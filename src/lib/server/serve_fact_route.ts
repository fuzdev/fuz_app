/**
 * Content-addressed fact serving — cell-scoped, per-reference reads.
 *
 * Two routes serve fact bytes from the PG-backed fact store:
 *
 * - `GET /api/cells/:cell_id/facts/:hash` — the **per-reference read**.
 *   The request names the referencing cell. Authz is scoped to that one
 *   reference: `can_view_cell(caller, cell) AND cell.refs includes hash`.
 *   This is the path non-admin callers use, and the only path for
 *   confidential content.
 * - `GET /api/facts/:hash` — the **bare-hash read**, restricted to admins.
 *
 * Embedded facts stream from the `fact.bytes` PG column; external facts
 * (filesystem-backed `file:<shard>/<rest>` URLs) either return an
 * `X-Accel-Redirect` header pointing into nginx's internal facts location
 * (production) or stream from disk via the filesystem `FactExternalFetcher`
 * (dev / tests). The runtime mode is selected by the optional
 * `x_accel_redirect_prefix` factory option — set in prod, unset in dev.
 *
 * REST, not RPC: binary responses don't fit the JSON-RPC envelope.
 *
 * ## Authorization — authz lives on the cell→fact edge, not the hash
 *
 * Facts are global, content-addressed, owner-less bytes: identical bytes
 * from different owners dedup to **one** `fact` row. Keying access control
 * on the bare hash therefore unions visibility across every owner that
 * references it — A's private bytes leak the instant B references identical
 * bytes from a public cell. The fix is to scope authz to the
 * `(cell, hash)` edge: a caller reads a fact *through a specific cell it
 * can view that references the hash*. Dedup becomes a pure storage
 * optimization with zero authz consequence — whether two owners' bytes
 * share a `fact` row is invisible to the read check.
 *
 * The cell-scoped route resolves the named cell, requires
 * `can_view_cell(caller, cell)`, and requires `cell.refs` to include the
 * hash. B publishing identical bytes from B's public cell makes them
 * readable *via B's cell* — it never touches A's private reference.
 *
 * The bare-hash route is **admin-only**: an admin's reach already spans
 * every cell, so serving by bare hash grants no escalation. Non-admin
 * callers are rejected at the auth phase and never reach the handler.
 * (Explicitly-public facts — a producer opting bytes into world-readable
 * status — are a future refinement; there is no such concept today, so
 * the bare-hash route stays strictly admin-gated.)
 *
 * Auth shape on the cell-scoped route is `{account: 'none', actor: 'none'}`
 * — the dispatcher's authorization phase is skipped for pure-public routes,
 * so the handler builds the `RequestContext` itself from `c.var.account_id`
 * (populated by the `/api/*` session middleware) by resolving the caller's
 * single actor and loading their role_grants. Unauthed callers pass through
 * with `req_ctx: null` and are admitted only by a `cell.visibility ===
 * 'public'` cell. Multi-actor accounts fall through with `req_ctx: null`
 * — there's no `acting?` slot on a pure-public route, so multi-actor
 * callers are treated as anonymous.
 *
 * 404 is the universal "not viewable" response: missing fact, missing or
 * unviewable cell, or the cell doesn't reference the hash. We deliberately
 * don't distinguish 403 from 404 — neither the existence of a fact nor the
 * existence of a cell→fact edge should leak through the public surface.
 *
 * Content-addressed serving of inline `blake3:` images (a markdown doc cell
 * with embedded image refs) works through this model: the referencing cell
 * is the doc cell, so serving goes view-doc-cell → doc-cell-refs-include-hash
 * → serve.
 *
 * ## Untrusted-content hardening
 *
 * Fact bytes are served with a producer-supplied `content_type` emitted
 * verbatim, inline. To stop a fact stored as (or sniffable to) `text/html`
 * from executing as stored XSS for any reader of a referencing cell, **every**
 * served-fact response carries `X-Content-Type-Options: nosniff` +
 * `Content-Security-Policy: default-src 'none'; sandbox` (the
 * `FACT_SECURITY_HEADERS` set, applied in all three serve branches). The same
 * pair, byte-identical, is set by the Rust twin (`fuz_fact_serving::serve`).
 * `Content-Disposition: attachment` is deliberately **not** added — it would
 * force-download and break legitimate inline image rendering.
 *
 * ## Defense-in-depth
 *
 * The `external_url` regex is re-validated before issuing
 * `X-Accel-Redirect` even though `PgFactStore.put_ref` only writes
 * `file:<shard>/<rest>`-shaped URLs. A future row-injection bug
 * upstream would otherwise hand nginx an attacker-controlled path.
 *
 * @module
 */

import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {join} from 'node:path';
import type {Context} from 'hono';
import type {Logger} from '@fuzdev/fuz_util/log.ts';
import {FactHashSchema, type FactHash} from '@fuzdev/fuz_util/fact_hash.ts';
import {Uuid} from '@fuzdev/fuz_util/id.ts';
import {z} from 'zod';

import {
	build_request_context,
	get_request_context,
	has_role,
	type RequestContext,
} from '../auth/request_context.ts';
import {ROLE_ADMIN} from '../auth/role_schema.ts';
import {ActingActor} from '../http/auth_shape.ts';
import {ACCOUNT_ID_KEY} from '../hono_context.ts';
import {query_actors_by_account} from '../auth/account_queries.ts';
import {get_route_params, type RouteContext, type RouteSpec} from '../http/route_spec.ts';
import {ERROR_INVALID_ROUTE_PARAMS} from '../http/error_schemas.ts';
import type {AppDeps} from '../auth/deps.ts';
import {query_get_fact, query_get_fact_meta} from '../db/fact_queries.ts';
import {query_cell_get} from '../db/cell_queries.ts';
import {query_cell_grant_list_for_cell} from '../db/cell_grant_queries.ts';
import {can_view_cell} from '../auth/cell_authorize.ts';
import {parse_file_fact_url} from '../db/file_fact_url.ts';

/** `Cache-Control` for fact responses — 5 min revocation window. */
const CACHE_CONTROL = 'private, max-age=300';

/**
 * `X-Content-Type-Options` for fact responses — block MIME sniffing so an
 * `application/octet-stream` fact can't be sniffed into executable HTML.
 */
const X_CONTENT_TYPE_OPTIONS = 'nosniff';

/**
 * `Content-Security-Policy` for fact responses. Fact bytes carry a
 * producer-supplied `content_type` served verbatim inline, so a fact stored as
 * (or sniffable to) `text/html` would otherwise execute as stored XSS for any
 * reader of a referencing cell. `default-src 'none'; sandbox` neutralizes
 * script execution and sub-resource loads even when a fact is rendered inline;
 * harmless for directly-served images (they load no sub-resources). The same
 * pair, byte-identical, is set by the Rust twin (`fuz_fact_serving::serve`).
 */
const CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox";

/**
 * The untrusted-content hardening headers applied to every served-fact
 * response across all three branches (embedded, `X-Accel-Redirect`,
 * disk-stream). `Content-Disposition: attachment` is deliberately omitted — it
 * would force-download and break legitimate inline image rendering.
 */
const FACT_SECURITY_HEADERS = {
	'X-Content-Type-Options': X_CONTENT_TYPE_OPTIONS,
	'Content-Security-Policy': CONTENT_SECURITY_POLICY,
} as const;

/**
 * Path-param schema for the bare-hash route. Matching the canonical
 * fact-hash form here pushes malformed-hash 400s through the framework's
 * standard params-validation error shape (`ERROR_INVALID_ROUTE_PARAMS`),
 * which the round-trip validator expects.
 */
const bare_hash_params_schema = z.strictObject({
	hash: FactHashSchema,
});

/**
 * Path-param schema for the cell-scoped route. `cell_id` validates as a
 * `Uuid`; `hash` as the canonical fact-hash form. Malformed values 400 via
 * the standard params-validation shape.
 */
const cell_fact_params_schema = z.strictObject({
	cell_id: Uuid,
	hash: FactHashSchema,
});

/** Shared error-schema entry: tighten the auto-derived 400 to the literal emitted by params validation. */
const params_400_error = {
	400: z.looseObject({
		error: z.literal(ERROR_INVALID_ROUTE_PARAMS),
		issues: z.array(z.unknown()),
	}),
} as const;

export interface CreateServeFactRouteSpecOptions {
	/**
	 * App deps reference. Currently unused at handler time (cell + fact
	 * tables are read via `RouteContext.db`); kept on the factory
	 * signature for symmetry with sibling route factories and to give
	 * future role_grant-scoped viewer extensions somewhere to read other
	 * deps without changing the public shape.
	 */
	deps: AppDeps;
	/** Absolute path of the facts directory. Used for the dev/test streaming path. */
	facts_dir: string;
	/**
	 * When set, external facts return an `X-Accel-Redirect` pointing at
	 * `${prefix}<shard>/<rest>` — nginx's internal facts location serves
	 * the bytes. When unset, external facts stream from
	 * `<facts_dir>/<shard>/<rest>` directly. Production sets this (e.g.
	 * `/_facts/`); tests + dev leave it unset.
	 */
	x_accel_redirect_prefix?: string;
	log: Logger;
}

/** Serving config threaded into the shared byte-serving helper. */
interface ServeFactConfig {
	facts_dir: string;
	x_accel_redirect_prefix?: string;
	log: Logger;
}

/**
 * Serve a fact's bytes by hash, after the caller has been authorized for it.
 *
 * This is the shared tail of both routes — it never re-checks authz, so it
 * MUST only be called once the caller has been admitted (admin on the
 * bare-hash route, viewable referencing cell on the cell-scoped route).
 * Reuses the embedded-stream / `X-Accel-Redirect` / disk-stream logic.
 *
 * Returns 404 when the fact's metadata is missing or its embedded bytes
 * have vanished (a race), so the response shape is identical whether the
 * fact is genuinely absent or merely unviewable.
 */
const serve_fact_bytes = async (
	c: Context,
	route: RouteContext,
	hash: FactHash,
	config: ServeFactConfig,
): Promise<Response> => {
	const {facts_dir, x_accel_redirect_prefix, log} = config;

	const meta = await query_get_fact_meta({db: route.db}, hash);
	if (!meta) {
		return c.body(null, 404);
	}

	const content_type = meta.content_type ?? 'application/octet-stream';
	const size = String(meta.size);

	if (meta.external_url === null) {
		// Embedded — bytes live in the PG row.
		const row = await query_get_fact({db: route.db}, hash);
		if (!row || row.bytes === null) {
			// Race: meta said embedded but bytes vanished. Treat as not-found.
			log.warn(
				`serve_fact: embedded bytes missing for ${hash} (meta said embedded, row=${
					row ? 'present' : 'null'
				})`,
			);
			return c.body(null, 404);
		}
		const bytes = to_uint8(row.bytes);
		return c.body(bytes as unknown as ArrayBuffer, 200, {
			'Content-Type': content_type,
			'Content-Length': size,
			'Cache-Control': CACHE_CONTROL,
			...FACT_SECURITY_HEADERS,
		});
	}

	// External — defense-in-depth re-validate the URL before trusting it
	// to address the filesystem.
	const parsed = parse_file_fact_url(meta.external_url);
	if (!parsed) {
		log.error(`serve_fact: rejecting malformed external_url for ${hash}: ${meta.external_url}`);
		return c.body(null, 404);
	}
	const {shard, rest} = parsed;

	if (x_accel_redirect_prefix !== undefined) {
		// Production: hand off to nginx via the internal facts location.
		return c.body(null, 200, {
			'Content-Type': content_type,
			'Content-Length': size,
			'Cache-Control': CACHE_CONTROL,
			'X-Accel-Redirect': `${x_accel_redirect_prefix}${shard}/${rest}`,
			...FACT_SECURITY_HEADERS,
		});
	}

	// Dev / tests: stream from disk. `createReadStream` errors land on the
	// returned ReadableStream, which Hono surfaces as a 500 to the client.
	const file_path = join(facts_dir, shard, rest);
	const node_stream = createReadStream(file_path);
	const web_stream = Readable.toWeb(node_stream) as ReadableStream<Uint8Array>;
	return c.body(web_stream, 200, {
		'Content-Type': content_type,
		'Content-Length': size,
		'Cache-Control': CACHE_CONTROL,
		...FACT_SECURITY_HEADERS,
	});
};

/**
 * Resolve the caller's `RequestContext` on a pure-public route from the
 * session-middleware-set account id. Multi-actor accounts return `null`
 * (no `acting?` slot on a public route to disambiguate); single-actor
 * accounts resolve their actor and role_grants for owner / grant / admin
 * admission paths. Unauthenticated callers return `null`.
 */
const build_public_request_context = async (
	c: Context,
	route: RouteContext,
): Promise<RequestContext | null> => {
	const account_id = c.get(ACCOUNT_ID_KEY);
	if (!account_id) return null;
	const actors = await query_actors_by_account({db: route.db}, account_id);
	if (actors.length !== 1) return null;
	return build_request_context({db: route.db}, account_id, actors[0]!.id);
};

/**
 * Build the cell-scoped `GET /api/cells/:cell_id/facts/:hash` `RouteSpec`
 * — the per-reference read.
 *
 * Resolves the named cell (404 if missing / soft-deleted), requires
 * `can_view_cell(caller, cell)` AND `cell.refs` to include the hash
 * (else 404, masked), then serves the bytes. Authz is scoped to this one
 * `(cell, hash)` edge — never unioned across the fact's other referrers.
 *
 * Pure-public auth — the handler builds the per-request `RequestContext`
 * from `c.var.account_id` and enforces visibility per-reference.
 */
export const create_serve_cell_fact_route_spec = (
	options: CreateServeFactRouteSpecOptions,
): RouteSpec => {
	const {facts_dir, x_accel_redirect_prefix, log} = options;
	const config: ServeFactConfig = {facts_dir, x_accel_redirect_prefix, log};
	return {
		method: 'GET',
		path: '/api/cells/:cell_id/facts/:hash',
		auth: {account: 'none', actor: 'none'},
		description:
			'Serve content-addressed fact bytes through a named referencing cell. 404 unless the cell admits the caller via can_view_cell AND references the hash (per-reference, never union-of-referrers).',
		params: cell_fact_params_schema,
		input: z.null(),
		// The body is a binary stream; no JSON output schema applies.
		output: z.null(),
		errors: params_400_error,
		handler: async (c, route) => {
			const {cell_id, hash} = get_route_params<{cell_id: Uuid; hash: FactHash}>(c);

			// Resolve the named cell. Missing / soft-deleted → 404 (masked).
			const cell = await query_cell_get({db: route.db}, cell_id);
			if (!cell) {
				return c.body(null, 404);
			}

			// The cell→fact edge: the cell must actually reference the hash.
			// `cell.refs` is auto-derived from `data` on every write, so this is
			// the authoritative "does this cell reference these bytes" check.
			// Missing edge → 404 (masked), never "exists elsewhere".
			if (!cell.refs?.includes(hash)) {
				return c.body(null, 404);
			}

			// Per-reference view check — scoped to *this* cell only.
			const req_ctx = await build_public_request_context(c, route);
			// Unauthenticated callers skip the grant fetch entirely — no grant
			// can admit a null req_ctx (the only admit path is the
			// public-visibility branch in `can_view_cell`, which doesn't read
			// grants).
			const grants = req_ctx ? await query_cell_grant_list_for_cell({db: route.db}, cell.id) : null;
			if (!can_view_cell(req_ctx, cell, grants)) {
				// 404 (not 403) so an unviewable cell→fact edge doesn't leak.
				return c.body(null, 404);
			}

			return serve_fact_bytes(c, route, hash, config);
		},
	};
};

/**
 * Build the admin-only bare-hash `GET /api/facts/:hash` `RouteSpec`.
 *
 * An admin's reach already spans every cell, so serving by bare hash grants
 * no escalation — the union concern that made this route a cross-owner leak
 * for non-admins is vacuous for an admin. Non-admin callers are rejected at
 * the auth phase (403) and never reach the handler. Confidential non-admin
 * reads always go through the cell-scoped route above.
 *
 * Auth is `{account: 'required', actor: 'required', roles: ['admin']}` —
 * the dispatcher's authorization phase resolves the acting actor and the
 * post-authorization guard enforces the admin role before the handler runs.
 * The handler re-checks `has_role(_, admin)` as defense-in-depth so a future
 * mounting/auth-shape regression fails closed rather than serving by bare
 * hash to a non-admin.
 */
export const create_serve_fact_route_spec = (
	options: CreateServeFactRouteSpecOptions,
): RouteSpec => {
	const {facts_dir, x_accel_redirect_prefix, log} = options;
	const config: ServeFactConfig = {facts_dir, x_accel_redirect_prefix, log};
	return {
		method: 'GET',
		path: '/api/facts/:hash',
		auth: {account: 'required', actor: 'required', roles: [ROLE_ADMIN]},
		description:
			'Serve content-addressed fact bytes by bare hash — admin only. Non-admin reads go through GET /api/cells/:cell_id/facts/:hash (per-reference).',
		params: bare_hash_params_schema,
		// `actor: 'required'` (implied by the admin role gate) needs the
		// authorization phase to resolve an acting actor — registry-time
		// invariant 2 requires the `acting?` slot. On a GET it lives on
		// `query` (a multi-actor admin disambiguates via `?acting=<actor>`).
		query: z.strictObject({acting: ActingActor}),
		input: z.null(),
		// The body is a binary stream; no JSON output schema applies.
		output: z.null(),
		errors: params_400_error,
		handler: async (c, route) => {
			const {hash} = get_route_params<{hash: FactHash}>(c);

			// Defense-in-depth: the auth phase already gated this on the admin
			// role, but re-check the resolved context so a mounting/auth-shape
			// regression fails closed instead of serving by bare hash.
			if (!has_role(get_request_context(c), ROLE_ADMIN)) {
				return c.body(null, 404);
			}

			return serve_fact_bytes(c, route, hash, config);
		},
	};
};

/**
 * Coerce whatever the driver returns for BYTEA into a `Uint8Array`. Same
 * shape as the helper in `PgFactStore.get` — `pg` returns a `Buffer`
 * (`Uint8Array` subclass), `pglite` already returns `Uint8Array`.
 */
const to_uint8 = (value: Uint8Array): Uint8Array =>
	value instanceof Uint8Array && value.constructor === Uint8Array
		? value
		: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
