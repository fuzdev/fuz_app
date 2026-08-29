import '../assert_dev_env.ts';

/**
 * Cross-backend query-string shape parity suite.
 *
 * The TS pipeline reads queries through Hono's `c.req.query()` — a duplicated
 * key resolves to its **first** occurrence — and only routes that declare a
 * `z.strictObject` query schema 400 unknown keys, in the pipeline's
 * params → query → 401 → authz → 403 phase order. A derived-serde axum
 * extractor diverges on every axis (a plain-text pre-handler "duplicate
 * field" 400 observable anonymously, silently ignored unknown keys, query
 * rejection ahead of the 401), so each spine surface that reads a query is
 * pinned here on both backends:
 *
 * - **`GET /api/account/status`** — NO query schema: a duplicated `acting`
 *   reads first-wins (the persona resolves), unknown keys are ignored, and an
 *   anonymous caller with junk query hears 401, never a query 400.
 * - **the JSON-RPC GET endpoint** — `method` / `id` / `params` read
 *   first-wins; a duplicated `method` must dispatch the first one on every
 *   backend (a last-wins reader dispatches a different method per backend on
 *   the same request).
 * - **`GET /api/facts/:hash`** (gated on `capabilities.fact_serving`) —
 *   strict query schema: unknown keys and a malformed `acting` are 400
 *   `invalid_query_params` even for an anonymous caller (query precedes the
 *   401 guard), while a duplicated `acting` takes the first occurrence.
 *
 * The per-surface in-process TS pins live beside each module's own tests
 * (`account_status.test.ts`, `action_rpc.test.ts`,
 * `serve_fact_route.db.test.ts`); this suite is the cross-impl gate, so it is
 * cross-process only — like `login_security.ts` and `testing_backdoor.ts`.
 *
 * `$lib`-free by contract (relative specifiers only), like the sibling
 * cross-backend suites.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { account_verify_action_spec } from '../../auth/account_action_specs.ts';
import { ERROR_INVALID_QUERY_PARAMS } from '../../http/error_schemas.ts';
import { test_if } from './capabilities.ts';
import type { RpcPathCrossSuiteOptions } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';

/**
 * Options for the query-shape parity suite. The standard RPC-dispatched
 * cross-suite shape (`setup_test` / `capabilities` / `rpc_path`); aliases the
 * shared `RpcPathCrossSuiteOptions` rather than minting a duplicate.
 */
export type QueryShapeCrossTestOptions = RpcPathCrossSuiteOptions;

/** The status route every spine serves (bundled into the account family). */
const STATUS_PATH = '/api/account/status';

/** A well-formed blake3 hash that references no stored fact. */
const MISSING_HASH = `blake3:${'a'.repeat(64)}`;

export const describe_query_shape_cross_tests = (options: QueryShapeCrossTestOptions): void => {
	const { setup_test, capabilities } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('query-shape parity (duplicate keys, unknown keys, phase order)', () => {
		test_if(
			capabilities.account_status,
			'status: duplicated acting takes the first occurrence (persona resolves)',
			async () => {
				const fixture = await setup_test();
				// First occurrence is the keeper's real actor; the second is a
				// mismatching-but-well-formed uuid. First-wins resolves the real
				// persona; last-wins would fall through to `actor: null`, and a
				// derived-serde extractor would 400 before the handler ran.
				const nil = '00000000-0000-0000-0000-000000000000';
				const res = await fixture.transport(
					`${STATUS_PATH}?acting=${fixture.actor.id}&acting=${nil}`,
					{ method: 'GET', headers: fixture.create_session_headers() }
				);
				assert.strictEqual(res.status, 200);
				const body = (await res.json()) as { actor: { id: string } | null };
				assert.strictEqual(body.actor?.id, fixture.actor.id, 'first acting occurrence must win');
			}
		);

		test_if(
			capabilities.account_status,
			'status: anonymous with duplicated/unknown query keys → 401, never a query 400',
			async () => {
				const fixture = await setup_test();
				const anon = fixture.fresh_transport();
				// The status route has no query schema — an anonymous prober with a
				// junk query must hear the same 401 as a clean one (a pre-handler
				// query reject here is a backend fingerprint).
				const dup = await anon(`${STATUS_PATH}?acting=a&acting=b`, { method: 'GET' });
				assert.strictEqual(dup.status, 401);
				const unknown = await anon(`${STATUS_PATH}?foo=1&bar=2`, { method: 'GET' });
				assert.strictEqual(unknown.status, 401);
			}
		);

		test_if(
			capabilities.account_status,
			'status: unknown query keys are ignored for an authed caller (no strict schema)',
			async () => {
				const fixture = await setup_test();
				const res = await fixture.transport(`${STATUS_PATH}?foo=1`, {
					method: 'GET',
					headers: fixture.create_session_headers()
				});
				assert.strictEqual(res.status, 200);
			}
		);

		test('rpc GET: duplicated method and id keys take the first occurrence', async () => {
			const fixture = await setup_test();
			const method = account_verify_action_spec.method;
			// First-wins dispatches `account_verify` with id 7; a last-wins
			// reader dispatches the missing method (method_not_found) with id 8.
			const res = await fixture.transport(
				`${rpc_path}?method=${method}&method=definitely_missing_method&id=7&id=8`,
				{ method: 'GET', headers: fixture.create_session_headers() }
			);
			assert.strictEqual(res.status, 200);
			const body = (await res.json()) as { id: unknown; result?: unknown };
			assert.strictEqual(body.id, 7, 'first id occurrence must win');
			assert.ok(body.result !== undefined, 'first method occurrence must dispatch');
		});

		test_if(
			capabilities.fact_serving,
			'bare-hash facts: unknown query key → 400 invalid_query_params, even anonymous',
			async () => {
				const fixture = await setup_test();
				// Authed admin (the keeper): the strict query schema refuses the
				// unknown key before the handler can 404 the missing fact.
				const as_admin = await fixture.transport(`/api/facts/${MISSING_HASH}?foo=1`, {
					method: 'GET',
					headers: fixture.create_session_headers()
				});
				assert.strictEqual(as_admin.status, 400);
				const body = (await as_admin.json()) as { error?: string };
				assert.strictEqual(body.error, ERROR_INVALID_QUERY_PARAMS);

				// Anonymous: query validation precedes the 401 guard (phase
				// order), with the clean anonymous request as the 401 control.
				const anon = fixture.fresh_transport();
				const anon_bad = await anon(`/api/facts/${MISSING_HASH}?foo=1`, { method: 'GET' });
				assert.strictEqual(anon_bad.status, 400);
				const anon_clean = await anon(`/api/facts/${MISSING_HASH}`, { method: 'GET' });
				assert.strictEqual(anon_clean.status, 401);
			}
		);

		test_if(
			capabilities.fact_serving,
			'bare-hash facts: duplicated acting takes the first occurrence; malformed acting → 400',
			async () => {
				const fixture = await setup_test();
				// First occurrence is the keeper's real actor; the second is
				// garbage. First-wins passes the query phase and reaches the
				// handler's masked 404 (the hash references nothing) — a
				// derived-serde extractor would 400 the duplication instead.
				const dup = await fixture.transport(
					`/api/facts/${MISSING_HASH}?acting=${fixture.actor.id}&acting=not-a-uuid`,
					{ method: 'GET', headers: fixture.create_session_headers() }
				);
				assert.strictEqual(dup.status, 404, 'duplicated acting must resolve first-wins');

				// A malformed single acting is refused at the query phase.
				const bad = await fixture.transport(`/api/facts/${MISSING_HASH}?acting=not-a-uuid`, {
					method: 'GET',
					headers: fixture.create_session_headers()
				});
				assert.strictEqual(bad.status, 400);
				const body = (await bad.json()) as { error?: string };
				assert.strictEqual(body.error, ERROR_INVALID_QUERY_PARAMS);
			}
		);
	});
};
