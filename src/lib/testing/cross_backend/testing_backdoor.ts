import '../assert_dev_env.ts';

/**
 * Cross-backend negative-credential suite for the `_testing_*` backdoor
 * actions.
 *
 * `_testing_reset` / `_testing_mint_session` / `_testing_put_fact` /
 * `_testing_flood_notifications` / `_testing_schema_snapshot` /
 * `_testing_migration_tracker` / `_testing_action_manifest` /
 * `_testing_origin_check` / `_testing_shorten_credential_expiry` are
 * privileged test-binary actions the production
 * wire never exposes — direct DB writes (full auth wipe, forged session row,
 * raw fact insert), a flood of the caller's own connection, introspection
 * reads (the live schema, the `schema_version` migration tracker, and the live
 * RPC registry — the highest info-leak of the set were the gate to break), a
 * probe of the origin allowlist parser, and a rewrite of an account's
 * credential expiries. Their only structural fence
 * is the **daemon-token** credential gate on
 * each spec's `auth` axis. A test binary live-mounts them on its RPC
 * endpoint (and, on fuz_app's spine binary and the Rust stub, its WS
 * endpoint) but keeps them off the declared surface — so the spec-derived
 * `describe_rpc_attack_surface_tests` never enumerates them. This suite fires
 * them with non-daemon credentials to prove the gate holds end-to-end, against
 * each impl's real auth resolution; a conformance table given the live mount
 * (`live_rpc_endpoints`) fires the same refusals through the auth rows
 * `generate_rpc_auth_conformance_cases` generates for them.
 *
 * For every backdoor method, three principals:
 *
 * - **anonymous** (no credential) → `401` (pre-authorization auth refuses an
 *   account-less caller before anything else).
 * - **session** (the keeper's browser-context cookie) → `403`
 *   `credential_type_required` — a session cookie, even one carrying the
 *   keeper role, tops out below the daemon-token channel.
 * - **bearer** (the keeper's api-token, non-browser context) → `403`
 *   `credential_type_required` — same ceiling; an api token cannot reach
 *   keeper operations.
 *
 * Over WebSocket (when `ws` is supplied), the same methods sent on a socket
 * opened with the keeper's **session** cookie answer the same `forbidden`
 * error with `credential_type_required`: the upgrade admits a session, but
 * each message runs the same per-action gates as HTTP RPC, so a socket is no
 * way around the daemon-token channel. Anonymous and bearer have no WS case —
 * an anonymous upgrade is refused before any message, and the upgrade client
 * threads cookies.
 *
 * Each method is sent with **valid** params so each case varies only the
 * credential. (Validation runs after the gates — the order is 401 → authz →
 * 403 → 429 → 400 — so the shapes are belt-and-suspenders here rather than load-
 * bearing.) The handler never runs (the gate refuses first), so the writes
 * never execute.
 *
 * Complements the spec-level gate check (which pins that each spec *declares*
 * `credential_types: ['daemon_token']`) and the surface-absence invariant
 * (`assert_no_testing_methods`) — this one pins the runtime 401/403 behavior
 * on both impls. Cited property: `security.md` §Test Backdoor Actions
 * (daemon-token-gated, off-surface, DEV-excluded).
 *
 * Cross-process only — the `_testing_*` actions are mounted on the spawned
 * binary, not the in-process app — like the ws/sse suites. Wire from a
 * `*.cross.test.ts`. Requires the standard `_testing_*` actions mounted (the
 * same precondition `default_cross_process_setup` already imposes for its
 * per-test `_testing_reset`); the HTTP cases are ungated, since every cross
 * backend mounts them, and the WS cases run when `ws` is passed — for a
 * backend that also serves them on its WS endpoint.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { ERROR_CREDENTIAL_TYPE_REQUIRED } from '../../http/error_schemas.ts';
import { JSONRPC_ERROR_CODES } from '../../http/jsonrpc_errors.ts';
import { rpc_call } from '../rpc_helpers.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
import { is_response_for, type JsonrpcErrorResponseFrame } from '../transports/ws_client.ts';
import { test_if } from './capabilities.ts';
import type { RpcPathCrossSuiteOptions, TestFixture } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';
import { open_session_ws, type WsEndpointTarget } from './ws_endpoint.ts';

/** A well-formed UUID that never names a real row. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The backdoor methods + a **valid** params payload each (so the
 * session/bearer cases reach the 403 credential gate rather than a 400 on
 * input validation). The handlers never run — the gate refuses first.
 */
const backdoor_methods: ReadonlyArray<{ method: string; params: unknown }> = [
	{ method: '_testing_reset', params: {} },
	// The audit barrier — its input is void, so the call carries no params.
	{ method: '_testing_drain_effects', params: undefined },
	{ method: '_testing_mint_session', params: { account_id: NIL_UUID, expires_in_seconds: -60 } },
	{ method: '_testing_put_fact', params: { content: 'backdoor-probe' } },
	// An empty burst — valid input, so it clears the 400 phase; a refused
	// caller never reaches the handler that would queue it.
	{ method: '_testing_flood_notifications', params: { count: 0, size: 0 } },
	// The schema-dump read — `exclude_tables` is optional, so `{}` is valid
	// and clears the 400 phase like the writes above.
	{ method: '_testing_schema_snapshot', params: {} },
	// The migration-tracker-dump read — input is an empty strict object, so `{}`
	// is valid and clears the 400 phase, reaching the credential gate like the rest.
	{ method: '_testing_migration_tracker', params: {} },
	// The RPC-registry-dump read — input is an empty strict object, so `{}` is
	// valid and clears the 400 phase, reaching the credential gate like the rest.
	{ method: '_testing_action_manifest', params: {} },
	// The origin conformance probe — a valid `{patterns, origin}` pair, so it
	// clears the 400 phase like the rest.
	{ method: '_testing_origin_check', params: { patterns: 'http://localhost:*', origin: null } },
	// The credential-expiry rewrite — a valid `{account_id, seconds}` pair (a
	// syntactically valid UUID; no row needs to match), so it clears the 400
	// phase like the rest.
	{
		method: '_testing_shorten_credential_expiry',
		params: { account_id: '00000000-0000-4000-8000-000000000000', seconds: 30 }
	}
];

/** A non-daemon principal + the denial it must hit on every backdoor method. */
interface BackdoorPrincipal {
	readonly name: string;
	/** Expected HTTP status of the denial. */
	readonly status: number;
	/** Expected JSON-RPC `error.code`. */
	readonly code: number;
	/** Expected `error.data.reason`, when the denial class carries one (the 403s). */
	readonly reason?: string;
	/** Resolve the per-test transport + headers (mirrors the conformance runner). */
	readonly resolve: (fixture: TestFixture) => {
		readonly transport: FetchTransport;
		readonly headers: Record<string, string>;
		readonly suppress_default_origin?: boolean;
	};
}

const principals: ReadonlyArray<BackdoorPrincipal> = [
	{
		name: 'anonymous',
		status: 401,
		code: JSONRPC_ERROR_CODES.unauthenticated,
		// Fresh jar so the keeper cookie (cross-process) can't leak in.
		resolve: (f) => ({ transport: f.fresh_transport(), headers: {} })
	},
	{
		name: 'session',
		status: 403,
		code: JSONRPC_ERROR_CODES.forbidden,
		reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
		resolve: (f) => ({ transport: f.transport, headers: f.create_session_headers() })
	},
	{
		name: 'bearer',
		status: 403,
		code: JSONRPC_ERROR_CODES.forbidden,
		reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
		// Bearer is discarded in a browser context, so suppress Origin (empty
		// jar + no Origin) — the credential must actually resolve so the refusal
		// lands on the credential-type gate, not on bearer-discard (→ 401).
		resolve: (f) => ({
			transport: f.fresh_transport({ origin: null }),
			headers: f.create_bearer_headers(),
			suppress_default_origin: true
		})
	}
];

/** Options for the testing-backdoor negative-credential suite. */
export interface TestingBackdoorCrossTestOptions extends RpcPathCrossSuiteOptions {
	/**
	 * Where the backend's WebSocket endpoint is, for the session-socket cases.
	 * Pass it when the backend serves the `_testing_*` actions on its WS
	 * endpoint too; omitted, those cases are skipped.
	 */
	readonly ws?: WsEndpointTarget;
}

export const describe_testing_backdoor_cross_tests = (
	options: TestingBackdoorCrossTestOptions
): void => {
	const { setup_test, ws } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('testing backdoor credential gate parity', () => {
		for (const { method, params } of backdoor_methods) {
			for (const principal of principals) {
				test(`${method} rejects ${principal.name} → ${principal.status}`, async () => {
					const fixture = await setup_test();
					const { transport, headers, suppress_default_origin } = principal.resolve(fixture);
					const res = await rpc_call({
						app: transport,
						path: rpc_path,
						method,
						params,
						headers,
						...(suppress_default_origin && { suppress_default_origin: true })
					});
					const label = `${method} ${principal.name}`;
					assert.ok(
						!res.ok,
						`${label}: expected denial (${principal.status}) but the call succeeded`
					);
					assert.strictEqual(res.status, principal.status, `${label}: status`);
					// `!res.ok` narrows `res` to the error variant for `res.error`.
					if (!res.ok) {
						assert.strictEqual(res.error.code, principal.code, `${label}: error.code`);
						if (principal.reason !== undefined) {
							const reason = (res.error.data as { reason?: unknown } | undefined)?.reason;
							assert.strictEqual(reason, principal.reason, `${label}: error.data.reason`);
						}
					}
				});
			}
		}

		for (const { method, params } of backdoor_methods) {
			test_if(
				ws !== undefined,
				`${method} over a session socket → forbidden ${ERROR_CREDENTIAL_TYPE_REQUIRED}`,
				async () => {
					const fixture = await setup_test();
					const client = await open_session_ws(ws!, fixture, { admitted: true });
					try {
						const id = `backdoor_${method}`;
						await client.send({ jsonrpc: '2.0', id, method, params });
						const frame = await client.wait_for<Partial<JsonrpcErrorResponseFrame>>(
							is_response_for(id)
						);
						const label = `${method} session socket`;
						assert.ok(
							frame.error,
							`${label}: expected a credential_type_required error but the call succeeded`
						);
						assert.strictEqual(frame.error.code, JSONRPC_ERROR_CODES.forbidden, `${label}: code`);
						const reason = (frame.error.data as { reason?: unknown } | undefined)?.reason;
						assert.strictEqual(
							reason,
							ERROR_CREDENTIAL_TYPE_REQUIRED,
							`${label}: error.data.reason`
						);
					} finally {
						await client.close();
					}
				}
			);
		}
	});
};
