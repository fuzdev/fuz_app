/**
 * `GET /api/facts/:hash` — content-addressed fact serving.
 *
 * Resolves a fact hash to the bytes referenced by at least one viewable
 * cell. Embedded facts stream from the `facts.bytes` PG column;
 * external facts (filesystem-backed `file:<shard>/<rest>` URLs) either
 * return an `X-Accel-Redirect` header pointing into nginx's internal
 * facts location (production) or stream from disk via the filesystem
 * `FactExternalFetcher` (dev / tests). The runtime mode is selected by
 * the optional `x_accel_redirect_prefix` factory option — set in prod,
 * unset in dev.
 *
 * REST, not RPC: binary responses don't fit the JSON-RPC envelope.
 *
 * ## Authorization
 *
 * Auth is `{account: 'none', actor: 'none'}` — the dispatcher's
 * authorization phase is skipped for pure-public routes, so this handler
 * builds the `RequestContext` itself from `c.var.account_id` (populated
 * by the `/api/*` session middleware) by resolving the caller's single
 * actor and loading their role_grants. Unauthed callers pass through
 * with `req_ctx: null`. Viewers are admitted via `can_view_cell` over
 * **every** active cell that references the hash. Multi-actor accounts
 * fall through with `req_ctx: null` — there's no `acting?` slot on a
 * pure-public route, so multi-actor callers are treated as anonymous
 * (admitted only by the public-visibility branch). A fact is viewable iff
 * at least one referencing cell admits the caller; unauthenticated callers
 * are admitted only via a referencing cell with `cell.visibility ===
 * 'public'`. Facts with no referencing active cell are unreachable here —
 * orphan-fact GC reaps them separately.
 *
 * 404 is the universal "not viewable" response: missing fact, missing
 * referencing cell, all referencing cells private to other actors. We
 * deliberately don't distinguish 403 from 404 — the existence of a
 * private hash should not leak through the public surface.
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
import type {Logger} from '@fuzdev/fuz_util/log.js';
import {FactHashSchema, type FactHash} from '@fuzdev/fuz_util/fact_hash.js';
import {z} from 'zod';

import {build_request_context, type RequestContext} from '../auth/request_context.js';
import {ACCOUNT_ID_KEY} from '../hono_context.js';
import {query_actors_by_account} from '../auth/account_queries.js';
import {get_route_params, type RouteSpec} from '../http/route_spec.js';
import {ERROR_INVALID_ROUTE_PARAMS} from '../http/error_schemas.js';
import type {AppDeps} from '../auth/deps.js';
import {query_get_fact, query_get_fact_meta} from '../db/fact_queries.js';
import {query_cell_list_by_ref} from '../db/cell_queries.js';
import {query_cell_grant_list_for_cell} from '../db/cell_grant_queries.js';
import {can_view_cell} from '../auth/cell_authorize.js';
import {parse_file_fact_url} from './file_fact_url.js';

/** `Cache-Control` for fact responses — 5 min revocation window. */
const CACHE_CONTROL = 'private, max-age=300';

/**
 * Path-param schema. Matching the canonical fact-hash form here pushes
 * malformed-hash 400s through the framework's standard params-validation
 * error shape (`ERROR_INVALID_ROUTE_PARAMS`), which the round-trip
 * validator expects.
 */
const params_schema = z.strictObject({
	hash: FactHashSchema,
});

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

/**
 * Build the `GET /api/facts/:hash` `RouteSpec`.
 *
 * Pure-public auth — the handler builds the per-request `RequestContext`
 * from `c.var.account_id` and enforces visibility per-fact via the
 * cell-walk above.
 */
export const create_serve_fact_route_spec = (
	options: CreateServeFactRouteSpecOptions,
): RouteSpec => {
	const {facts_dir, x_accel_redirect_prefix, log} = options;
	return {
		method: 'GET',
		path: '/api/facts/:hash',
		auth: {account: 'none', actor: 'none'},
		description:
			'Serve content-addressed fact bytes. 404 unless at least one referencing cell admits the caller via can_view_cell.',
		params: params_schema,
		input: z.null(),
		// The body is a binary stream; no JSON output schema applies.
		output: z.null(),
		errors: {
			// Tighten the auto-derived 400 from `ApiError` (`error: string`) to
			// the actual literal emitted by `create_params_validation`, so
			// `assert_error_schema_tightness` reads the surface as specific
			// rather than generic.
			400: z.looseObject({
				error: z.literal(ERROR_INVALID_ROUTE_PARAMS),
				issues: z.array(z.unknown()),
			}),
		},
		handler: async (c, route) => {
			const {hash} = get_route_params<{hash: FactHash}>(c);

			const meta = await query_get_fact_meta({db: route.db}, hash);
			if (!meta) {
				return c.body(null, 404);
			}

			// Pure-public route — dispatcher skips the authorization phase, so
			// build the `RequestContext` here from the session-middleware-set
			// account id. Multi-actor accounts fall through with `null` (no
			// `acting?` slot on a public route to disambiguate); single-actor
			// accounts resolve their actor and role_grants for owner / grant /
			// admin admission paths.
			const account_id = c.get(ACCOUNT_ID_KEY);
			let req_ctx: RequestContext | null = null;
			if (account_id) {
				const actors = await query_actors_by_account({db: route.db}, account_id);
				if (actors.length === 1) {
					req_ctx = await build_request_context({db: route.db}, account_id, actors[0]!.id);
				}
			}
			// `include_grant_count: false` — the authz walk only reads
			// `can_view_cell`-relevant fields, so skip the per-row grant
			// COUNT subquery. Cheap to begin with; even cheaper now.
			const referencing_cells = await query_cell_list_by_ref({db: route.db}, hash, {
				include_grant_count: false,
			});
			// Sequential walk with early break on first admit — preserves
			// the original `.some()` short-circuit. Unauthenticated callers
			// skip the grant fetch entirely since no grant can admit a null
			// req_ctx (the only admit path is the public-visibility branch
			// in `can_view_cell`, which doesn't need grants). Authenticated
			// callers eat one `cell_grant` lookup per referencing cell up
			// to the first admit; acceptable at MVP fact-serve scale.
			// TODO: if profiling shows this hot, batch grants in one query
			// across all referencing cells, or push the predicate into SQL.
			let viewable = false;
			for (const cell of referencing_cells) {
				const grants = req_ctx
					? await query_cell_grant_list_for_cell({db: route.db}, cell.id)
					: null;
				if (can_view_cell(req_ctx, cell, grants)) {
					viewable = true;
					break;
				}
			}
			if (!viewable) {
				// 404 (not 403) so existence of private hashes doesn't leak
				// through the public surface. Same response shape as a
				// genuinely missing fact.
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
						`serve_fact: embedded bytes missing for ${hash} (meta said embedded, row=${row ? 'present' : 'null'})`,
					);
					return c.body(null, 404);
				}
				const bytes = to_uint8(row.bytes);
				return c.body(bytes as unknown as ArrayBuffer, 200, {
					'Content-Type': content_type,
					'Content-Length': size,
					'Cache-Control': CACHE_CONTROL,
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
			});
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
