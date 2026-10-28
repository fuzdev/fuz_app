/**
 * Content-addressed fact serving — cell-scoped, per-reference reads.
 *
 * Two routes serve fact bytes from the PG-backed fact store:
 *
 * - `GET /api/cells/:cell_id/facts/:hash` — the **per-reference read**.
 *   The request names the referencing cell. Authz is scoped to that one
 *   reference: `(can_view_cell(caller, cell) OR the steward arm) AND
 *   cell.refs includes hash`, the steward arm being the governing root's
 *   manager reading a pending or rejected contribution
 *   (`auth/cell_steward.ts`). This is the path non-admin callers use, and the only path for
 *   confidential content.
 * - `GET /api/facts/:hash` — the **bare-hash read**, restricted to admins.
 *
 * Embedded facts stream from the `fact.bytes` PG column; external facts
 * (filesystem-backed `file:<shard>/<rest>` URLs) either return an
 * `X-Accel-Redirect` header pointing into nginx's internal facts location
 * (production) or stream from disk (dev / tests). The runtime mode is
 * selected by the optional `x_accel` factory option — a validated
 * `XAccelConfig` (built via
 * `create_x_accel_config` in `server/x_accel.ts`) set in prod, unset in dev.
 * The handle can only be obtained by proving the facts nginx location is
 * `internal;` and carries the fact hardening headers, so X-Accel serving can't
 * be enabled against a public or header-less location.
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
 * The edge is only as safe as what may create it. A cell's `refs` derive
 * from its `data`, and any account that can write a cell writes its `data` —
 * so this route alone would make a known hash a read capability: name it in
 * a cell you own, flip the cell public, and the bytes serve to the world,
 * while a 200 against a 404 says whether the fact exists. What closes that is
 * **possession-gated ref admission** on the cell verbs
 * (`auth/cell_ref_admission.ts`): a non-admin `cell_create` / `cell_update` /
 * `cell_clone` may introduce a ref only to a fact its acting actor holds —
 * one it put the bytes of, recorded in `fact_holder` on every put, a
 * deduplicated put included — and is refused `403 cell_ref_not_held`
 * otherwise, the same answer whether or not a fact is stored. Refs a cell
 * already carries stay admitted through updates and clones, so a viewer who
 * clones a cell carries its refs: what a viewer can read through a cell, it
 * can republish — no more than downloading the bytes and uploading them
 * again. A serve is a snapshot of the edge at read time; revoking someone's
 * access to a cell does not withdraw refs they already wrote elsewhere.
 * Writers that bypass the verbs (seeds, raw inserts) are trusted and not
 * admitted.
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
 * so the handler builds the `RequestContext` itself from the resolved account
 * id (`get_public_account_id`, over what the `/api/*` auth middleware set) by
 * resolving the caller's single actor and loading their role_grants.
 * Unauthed callers pass through with `req_ctx: null` and are admitted only by
 * a `cell.visibility === 'public'` cell whose `moderation` admits an audience (unmoderated or
 * `'approved'`). Multi-actor accounts fall through with `req_ctx: null`
 * — there's no `acting?` slot on a pure-public route, so multi-actor
 * callers are treated as anonymous. A scope-narrowed API token is treated as
 * anonymous too, not refused (`get_public_account_id`): a narrowed token
 * reaches no non-RPC surface, but on a route that admits anonymous callers
 * a 403 would enforce nothing — the holder drops the `Authorization` header and
 * re-reads every public cell anyway.
 *
 * 404 is the universal "not viewable" response: missing fact, missing or
 * unviewable cell, or the cell doesn't reference the hash. We deliberately
 * don't distinguish 403 from 404 — neither the existence of a fact nor the
 * existence of a cell→fact edge should leak through the public surface.
 *
 * A ref is a `data` string value that is exactly a fact hash
 * (`derive_cell_refs`) — a hash inside prose or markup is not one. So a doc
 * cell that shows images stores each image's hash as its own string value
 * (an attachment list, say) beside the text that places them; serving then
 * goes view-doc-cell → doc-cell-refs-include-hash → serve.
 *
 * ## Untrusted-content hardening
 *
 * Fact bytes are served with a producer-supplied `content_type` emitted
 * verbatim, inline. To stop a fact stored as (or sniffable to) `text/html`
 * from executing as stored XSS for any reader of a referencing cell, **every**
 * served-fact response carries `X-Content-Type-Options: nosniff` +
 * `Content-Security-Policy: default-src 'none'; sandbox` (the
 * `FACT_SECURITY_HEADERS` set from `server/fact_security_headers.ts`,
 * byte-identical with the Rust twin `fuz_fact_serving`). The embedded and
 * disk-stream branches set them on the response. On the `X-Accel-Redirect`
 * branch nginx serves the bytes, and the headers the client sees come from the
 * internal facts location, not this response — that location must carry the
 * lines `fact_security_header_directives` renders, which `create_x_accel_config`
 * enforces.
 * `Content-Disposition: attachment` is deliberately **not** added — it would
 * force-download and break legitimate inline image rendering.
 *
 * ## Defense-in-depth
 *
 * `external_url` is re-validated before it addresses the filesystem or an
 * `X-Accel-Redirect`: it must have the `file:<shard>/<rest>` shape, and it must
 * be the requested hash's own address (`file_fact_url_addresses`). `PgFactStore`
 * writes only such URLs, but the column is free text and `query_put_fact`
 * inserts what it is given, so a row written past the store — or a
 * row-injection bug upstream — would otherwise hand nginx an
 * attacker-controlled path, or serve another fact's bytes under this hash,
 * behind this hash's admission. The serve path never re-hashes what it
 * streams, so this binding is what ties the bytes to the name. Either refusal
 * is a logged error and the masked 404, the same unavailable that
 * `PgFactStore.get` reports as `null`. Twin of the Rust `fuz_fact_serving`.
 *
 * @module
 */

import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import type { Context } from 'hono';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import type { FactHash } from '@fuzdev/fuz_util/hash_schemas.ts';
import { FactHashSchema, Uuid } from '../primitive_schemas.ts';
import { z } from 'zod';

import {
	build_request_context,
	get_public_account_id,
	get_request_context,
	has_scoped_role,
	type RequestContext
} from '../auth/request_context.ts';
import { ROLE_ADMIN } from '../auth/role_schema.ts';
import { ActingActor } from '../http/auth_shape.ts';
import { query_active_actors_by_account } from '../auth/account_queries.ts';
import { get_route_params, type RouteContext, type RouteSpec } from '../http/route_spec.ts';
import { ERROR_INVALID_ROUTE_PARAMS } from '../http/error_schemas.ts';
import { query_get_fact, query_get_fact_meta } from '../db/fact_queries.ts';
import { to_uint8 } from '../db/fact_store.ts';
import { query_cell_get } from '../db/cell_queries.ts';
import { query_cell_grant_list_for_cell } from '../db/cell_grant_queries.ts';
import { can_view_cell } from '../auth/cell_authorize.ts';
import { cell_steward_admits } from '../auth/cell_steward.ts';
import { file_fact_url_addresses, parse_file_fact_url } from '../db/file_fact_url.ts';
import type { XAccelConfig } from './x_accel.ts';
import { FACT_CACHE_CONTROL, FACT_SECURITY_HEADERS } from './fact_security_headers.ts';

/**
 * Path-param schema for the bare-hash route. Matching the canonical
 * fact-hash form here pushes malformed-hash 400s through the framework's
 * standard params-validation error shape (`ERROR_INVALID_ROUTE_PARAMS`),
 * which the round-trip validator expects.
 */
const bare_hash_params_schema = z.strictObject({
	hash: FactHashSchema
});

/**
 * Path-param schema for the cell-scoped route. `cell_id` validates as a
 * `Uuid`; `hash` as the canonical fact-hash form. Malformed values 400 via
 * the standard params-validation shape.
 */
const cell_fact_params_schema = z.strictObject({
	cell_id: Uuid,
	hash: FactHashSchema
});

/**
 * Shared error-schema entry: tighten the auto-derived 400 to the literal
 * emitted by params validation. `issues` is optional because the framework
 * emits it through `dev_only` — a production body carries the `error`
 * literal alone.
 */
const params_400_error = {
	400: z.looseObject({
		error: z.literal(ERROR_INVALID_ROUTE_PARAMS),
		issues: z.array(z.unknown()).optional()
	})
} as const;

export interface CreateServeFactRouteSpecOptions {
	/** Absolute path of the facts directory. Used for the dev/test streaming path. */
	facts_dir: string;
	/**
	 * When set, external facts return an `X-Accel-Redirect` pointing at
	 * `${x_accel.redirect_prefix}<shard>/<rest>` — nginx's internal facts
	 * location serves the bytes. When unset, external facts stream from
	 * `<facts_dir>/<shard>/<rest>` directly. Production sets a validated
	 * `XAccelConfig` (built via `create_x_accel_config`, which proves the
	 * facts location is `internal;`); tests + dev leave it unset.
	 */
	x_accel?: XAccelConfig;
	log: Logger;
}

/** Serving config threaded into the shared byte-serving helper. */
interface ServeFactConfig {
	facts_dir: string;
	x_accel?: XAccelConfig;
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
 * Returns 404 when the fact's metadata is missing, its embedded bytes have
 * vanished (a race), or its disk file is missing, so the response shape is
 * identical whether the fact is genuinely absent or merely unviewable; any
 * other failure to open the disk file answers a logged 500. HEAD on a disk
 * fact opens the file (so it answers the same statuses) and closes it again,
 * sending headers only.
 */
const serve_fact_bytes = async (
	c: Context,
	route: RouteContext,
	hash: FactHash,
	config: ServeFactConfig
): Promise<Response> => {
	const { facts_dir, x_accel, log } = config;

	const meta = await query_get_fact_meta({ db: route.db }, hash);
	if (!meta) {
		return c.body(null, 404);
	}

	const content_type = meta.content_type ?? 'application/octet-stream';
	const size = String(meta.size);

	if (meta.external_url === null) {
		// Embedded — bytes live in the PG row.
		const row = await query_get_fact({ db: route.db }, hash);
		if (!row || row.bytes === null) {
			// Race: meta said embedded but bytes vanished. Treat as not-found.
			log.warn(
				`serve_fact: embedded bytes missing for ${hash} (meta said embedded, row=${
					row ? 'present' : 'null'
				})`
			);
			return c.body(null, 404);
		}
		const bytes = to_uint8(row.bytes);
		return c.body(bytes as unknown as ArrayBuffer, 200, {
			'Content-Type': content_type,
			'Content-Length': size,
			'Cache-Control': FACT_CACHE_CONTROL,
			...FACT_SECURITY_HEADERS
		});
	}

	// External — defense-in-depth re-validate the URL before trusting it
	// to address the filesystem: its shape, then that it is this hash's file
	const parsed = parse_file_fact_url(meta.external_url);
	if (!parsed) {
		log.error(
			`serve_fact: external_url for ${hash} is not a file:<shard>/<rest> URL; answering 404`
		);
		return c.body(null, 404);
	}
	if (!file_fact_url_addresses(parsed, hash)) {
		log.error(`serve_fact: external_url for ${hash} addresses another fact's file; answering 404`);
		return c.body(null, 404);
	}
	const { shard, rest } = parsed;

	if (x_accel !== undefined) {
		// Production: hand off to nginx via the validated `internal;` facts location.
		// nginx answers with that location's own `add_header` set, not these
		// headers, which is why the validator requires the fact pair there.
		return c.body(null, 200, {
			'Content-Type': content_type,
			'Content-Length': size,
			'Cache-Control': FACT_CACHE_CONTROL,
			'X-Accel-Redirect': `${x_accel.redirect_prefix}${shard}/${rest}`,
			...FACT_SECURITY_HEADERS
		});
	}

	// Dev / tests: stream from disk. Open before committing the 200 so a
	// missing file answers 404 and any other open failure a logged 500, as the
	// Rust twin does — a lazy stream would send the headers, then truncate.
	const file_path = join(facts_dir, shard, rest);
	let handle: FileHandle;
	try {
		handle = await open(file_path, 'r');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			log.warn(`serve_fact: disk file for ${hash} is missing; answering 404`);
			return c.body(null, 404);
		}
		log.error(`serve_fact: disk open for ${hash} failed`, err);
		return c.json({ error: 'internal_error' }, 500);
	}
	const headers = {
		'Content-Type': content_type,
		'Content-Length': size,
		'Cache-Control': FACT_CACHE_CONTROL,
		...FACT_SECURITY_HEADERS
	};
	// Hono answers HEAD by running this GET handler and discarding the body
	// unread, so a stream built here would hold the handle open until GC
	if (c.req.method === 'HEAD') {
		await handle.close();
		return c.body(null, 200, headers);
	}
	const web_stream = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
	return c.body(web_stream, 200, headers);
};

/**
 * Resolve the caller's `RequestContext` on a pure-public route from the
 * session-middleware-set account id, read through `get_public_account_id`, so
 * a scope-narrowed API token returns `null` — downgraded to anonymous, not
 * refused (see the module doc). Twin of the Rust
 * `AuthGate::public_request_context`.
 *
 * Multi-actor accounts return `null` (no `acting?` slot on a public route to
 * disambiguate); single active-actor accounts resolve their actor and
 * role_grants for owner / grant / admin admission paths. Unauthenticated
 * callers return `null`. Soft-deleted (tombstoned) actors are excluded from the
 * count (`query_active_actors_by_account`), matching the acting-actor
 * resolution path — a tombstoned actor is never resolvable here.
 */
const build_public_request_context = async (
	c: Context,
	route: RouteContext
): Promise<RequestContext | null> => {
	// a narrowed token is the anonymous caller here, never a refusal
	const account_id = get_public_account_id(c);
	if (!account_id) return null;
	const actors = await query_active_actors_by_account({ db: route.db }, account_id);
	if (actors.length !== 1) return null;
	return build_request_context({ db: route.db }, account_id, actors[0]!.id);
};

/**
 * Build the cell-scoped `GET /api/cells/:cell_id/facts/:hash` `RouteSpec`
 * — the per-reference read.
 *
 * Resolves the named cell (404 if missing / soft-deleted), requires
 * `can_view_cell(caller, cell)` — or the steward arm,
 * `cell_steward_admits` — AND `cell.refs` to include the hash
 * (else 404, masked), then serves the bytes. Authz is scoped to this one
 * `(cell, hash)` edge — never unioned across the fact's other referrers.
 *
 * Pure-public auth — the handler builds the per-request `RequestContext`
 * from the resolved account id (`get_public_account_id`) and enforces
 * visibility per-reference.
 */
export const create_serve_cell_fact_route_spec = (
	options: CreateServeFactRouteSpecOptions
): RouteSpec => {
	const { facts_dir, x_accel, log } = options;
	const config: ServeFactConfig = { facts_dir, x_accel, log };
	return {
		method: 'GET',
		path: '/api/cells/:cell_id/facts/:hash',
		auth: { account: 'none', actor: 'none' },
		reads_credential: true,
		description:
			"Serve content-addressed fact bytes through a named referencing cell. 404 unless the cell admits the caller via can_view_cell (or the steward arm: the governing root's manager reading a pending or rejected contribution) AND references the hash (per-reference, never union-of-referrers).",
		params: cell_fact_params_schema,
		input: z.null(),
		// The body is a binary stream; no JSON output schema applies.
		output: z.null(),
		errors: params_400_error,
		handler: async (c, route) => {
			const { cell_id, hash } = get_route_params<{ cell_id: Uuid; hash: FactHash }>(c);

			// Resolve the named cell. Missing / soft-deleted → 404 (masked).
			const cell = await query_cell_get({ db: route.db }, cell_id);
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
			const grants = req_ctx
				? await query_cell_grant_list_for_cell({ db: route.db }, cell.id)
				: null;
			// The governing root's manager also reads a pending or rejected
			// contribution's facts (the steward arm, `auth/cell_steward.ts`),
			// checked only once the view check denies.
			if (
				!can_view_cell(req_ctx, cell, grants) &&
				!(await cell_steward_admits({ db: route.db }, req_ctx, cell))
			) {
				// 404 (not 403) so an unviewable cell→fact edge doesn't leak.
				return c.body(null, 404);
			}

			return serve_fact_bytes(c, route, hash, config);
		}
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
 * The handler re-checks the **global** admin grant
 * (`has_scoped_role(_, admin, null)`, the auth phase's own reading) as
 * defense-in-depth so a future mounting/auth-shape regression fails closed —
 * a masked 404, logged at error — rather than serving by bare hash to a
 * non-admin.
 */
export const create_serve_fact_route_spec = (
	options: CreateServeFactRouteSpecOptions
): RouteSpec => {
	const { facts_dir, x_accel, log } = options;
	const config: ServeFactConfig = { facts_dir, x_accel, log };
	return {
		method: 'GET',
		path: '/api/facts/:hash',
		auth: {
			account: 'required',
			actor: 'required',
			roles: [ROLE_ADMIN],
			// Rule 3 — a narrowed token gets no bare-hash read. This route
			// serves *any* stored fact by hash with no per-reference cell check
			// (that is the per-cell route's job), so it is the broad capability
			// of the pair; gating it keeps a narrowed token to the cell-scoped
			// route its RPC methods can justify.
			required_scope: 'surface:fact_bare'
		},
		description:
			'Serve content-addressed fact bytes by bare hash — admin only. Non-admin reads go through GET /api/cells/:cell_id/facts/:hash (per-reference).',
		params: bare_hash_params_schema,
		// `actor: 'required'` (implied by the admin role gate) needs the
		// authorization phase to resolve an acting actor — registry-time
		// invariant 2 requires the `acting?` slot. On a GET it lives on
		// `query` (a multi-actor admin disambiguates via `?acting=<actor>`).
		query: z.strictObject({ acting: ActingActor }),
		input: z.null(),
		// The body is a binary stream; no JSON output schema applies.
		output: z.null(),
		errors: params_400_error,
		handler: async (c, route) => {
			const { hash } = get_route_params<{ hash: FactHash }>(c);

			// Defense-in-depth: the auth phase already gated this on the admin
			// role, but re-check the resolved context so a mounting/auth-shape
			// regression fails closed instead of serving by bare hash. Global
			// grant only — a scoped `admin` row must not read every fact. It
			// fires only on such a regression, so it fails loud as well.
			if (!has_scoped_role(get_request_context(c), ROLE_ADMIN, null)) {
				log.error(
					'bare-hash fact read reached the handler without a global admin grant — the auth gate did not run'
				);
				return c.body(null, 404);
			}

			return serve_fact_bytes(c, route, hash, config);
		}
	};
};
