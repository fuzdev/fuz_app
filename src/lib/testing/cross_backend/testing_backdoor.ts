import '../assert_dev_env.ts';

/**
 * Cross-backend suite for the `_testing_*` backdoor actions: the backend's
 * declaration of which it mounts, and the credential gate on each.
 *
 * `TESTING_BACKDOOR_METHODS` (`_testing_reset`, `_testing_drain_effects`,
 * `_testing_mint_session`, `_testing_put_fact`,
 * `_testing_flood_notifications`, `_testing_schema_snapshot`,
 * `_testing_migration_tracker`, `_testing_action_manifest`,
 * `_testing_origin_check`, `_testing_shorten_credential_expiry`) are
 * privileged test-binary actions the production
 * wire never exposes — direct DB writes (full auth wipe, forged session row,
 * raw fact insert), the audit barrier, a flood of the caller's own connection,
 * introspection reads (the live schema, the `schema_version` migration
 * tracker, and the live RPC registry — the highest info-leak of the set were
 * the gate to break), a probe of the origin allowlist parser, and a rewrite of
 * an account's credential expiries. Their only structural fence
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
 * **The declaration.** A backend states which it mounts in
 * `capabilities.testing_backdoors`, and the suite holds it to that: each known
 * backdoor the declaration leaves out is sent anonymously and must answer
 * `method_not_found` (404) — both spines look a method up before they
 * authenticate the caller, so an unmounted method answers that whatever the
 * credential — and each declared one runs the rows below, whose anonymous row
 * (a 401, not `method_not_found`) proves it mounted. A wrong declaration fails
 * either way, so the suites that skip on an undeclared backdoor
 * (`describe_spine_cross_suites`) skip only what the backend truly lacks. The
 * check runs on every backend, one mounting none of them included.
 *
 * For every declared backdoor, and each `extra_methods` seam (a consumer's own
 * daemon-token action), three principals:
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
 * The credential rows run cross-process only — the `_testing_*` actions are
 * mounted on the spawned binary, not the in-process app — like the ws/sse
 * suites; there, wire from a `*.cross.test.ts`, whose setup fires
 * `_testing_reset`, so the backend must mount that one. In-process, an app
 * mounting none declares none, and the suite runs the declaration rows alone,
 * one per known backdoor. The WS cases run when `ws` is passed — for a
 * backend that also serves its backdoors on its WS endpoint.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { ERROR_CREDENTIAL_TYPE_REQUIRED } from '../../http/error_schemas.ts';
import { JSONRPC_ERROR_CODES } from '../../http/jsonrpc_errors.ts';
import { rpc_call } from '../rpc_helpers.ts';
import { TESTING_METHOD_PREFIX } from '../surface_invariants.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
import { is_response_for, type JsonrpcErrorResponseFrame } from '../transports/ws_client.ts';
import { test_if } from './capabilities.ts';
import type { RpcPathCapabilityGatedCrossSuiteOptions, TestFixture } from './setup.ts';
import {
	SPINE_RPC_PATH,
	TESTING_BACKDOOR_METHODS,
	type TestingBackdoorMethod
} from './spine_surface_constants.ts';
import { open_session_ws, type WsEndpointTarget } from './ws_endpoint.ts';

/** A well-formed UUID that never names a real row. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * A **valid** params payload for each known backdoor (so the session/bearer
 * cases reach the 403 credential gate rather than a 400 on input validation).
 * The handlers never run — the gate refuses first. Keyed by
 * `TestingBackdoorMethod`, so a method added to `TESTING_BACKDOOR_METHODS`
 * fails typecheck here until it has its params.
 */
const BACKDOOR_PARAMS: Readonly<Record<TestingBackdoorMethod, unknown>> = {
	_testing_reset: {},
	// The audit barrier — its input is void, so the call carries no params.
	_testing_drain_effects: undefined,
	_testing_mint_session: { account_id: NIL_UUID, expires_in_seconds: -60 },
	_testing_put_fact: { content: 'backdoor-probe' },
	// An empty burst — valid input, so it clears the 400 phase; a refused
	// caller never reaches the handler that would queue it.
	_testing_flood_notifications: { count: 0, size: 0 },
	// The schema-dump read — `exclude_tables` is optional, so `{}` is valid
	// and clears the 400 phase like the writes above.
	_testing_schema_snapshot: {},
	// The migration-tracker-dump read — its input is void, so the call carries no params.
	_testing_migration_tracker: undefined,
	// The RPC-registry-dump read — its input is void, so the call carries no params.
	_testing_action_manifest: undefined,
	// The origin conformance probe — a valid `{patterns, origin}` pair, so it
	// clears the 400 phase like the rest.
	_testing_origin_check: { patterns: 'http://localhost:*', origin: null },
	// The credential-expiry rewrite — a valid `{account_id, seconds}` pair (a
	// syntactically valid UUID; no row needs to match), so it clears the 400
	// phase like the rest.
	_testing_shorten_credential_expiry: {
		account_id: '00000000-0000-4000-8000-000000000000',
		seconds: 30
	}
};

/**
 * A backdoor the suite fires: its method and a params payload its input
 * schema accepts, so a refusal lands on the credential gate, not on validation.
 */
export interface TestingBackdoorProbe {
	readonly method: string;
	readonly params?: unknown;
}

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

/** Options for the testing-backdoor suite. */
export interface TestingBackdoorCrossTestOptions extends RpcPathCapabilityGatedCrossSuiteOptions {
	/**
	 * Where the backend's WebSocket endpoint is, for the session-socket cases.
	 * Pass it when the backend serves its `_testing_*` actions on its WS
	 * endpoint too; omitted, those cases are skipped.
	 */
	readonly ws?: WsEndpointTarget;
	/**
	 * The backend's own daemon-token seams beyond `TESTING_BACKDOOR_METHODS`,
	 * each with params its input accepts — fired with the same refused
	 * principals as the known backdoors. Each must start with `_testing_` and
	 * not be a known backdoor; the call throws otherwise.
	 */
	readonly extra_methods?: ReadonlyArray<TestingBackdoorProbe>;
}

/**
 * The known backdoors a backend declares, checked against the known list,
 * and its extra seams, checked against the `_testing_` prefix and the list.
 *
 * @throws Error - on a declared method that isn't a known backdoor, an extra
 *   method outside the `_testing_` namespace or naming a known backdoor, or a
 *   duplicate
 */
const resolve_backdoor_probes = (
	declared: ReadonlyArray<string>,
	extra_methods: ReadonlyArray<TestingBackdoorProbe>
): Array<TestingBackdoorProbe> => {
	const known: ReadonlySet<string> = new Set(TESTING_BACKDOOR_METHODS);
	const seen: Set<string> = new Set();
	for (const method of declared) {
		if (!known.has(method)) {
			throw new Error(
				`describe_testing_backdoor_cross_tests: capabilities.testing_backdoors declares ` +
					`'${method}', which is not in TESTING_BACKDOOR_METHODS — pass a consumer seam as extra_methods`
			);
		}
		if (seen.has(method)) {
			throw new Error(
				`describe_testing_backdoor_cross_tests: capabilities.testing_backdoors declares '${method}' twice`
			);
		}
		seen.add(method);
	}
	for (const { method } of extra_methods) {
		if (!method.startsWith(TESTING_METHOD_PREFIX) || known.has(method)) {
			throw new Error(
				`describe_testing_backdoor_cross_tests: extra method '${method}' must start with ` +
					`'${TESTING_METHOD_PREFIX}' and not be a known backdoor (declare those in capabilities.testing_backdoors)`
			);
		}
		if (seen.has(method)) {
			throw new Error(
				`describe_testing_backdoor_cross_tests: extra method '${method}' is listed twice`
			);
		}
		seen.add(method);
	}
	return [
		...TESTING_BACKDOOR_METHODS.filter((method) => declared.includes(method)).map((method) => ({
			method,
			params: BACKDOOR_PARAMS[method]
		})),
		...extra_methods
	];
};

/**
 * Register the backdoor suite: the declaration check over every known
 * backdoor, then the refused-principal rows over the mounted ones.
 *
 * @param options - the fixture, the backend's capabilities, and the optional
 *   WS target and extra seams
 * @throws Error - on a declaration or extra method `resolve_backdoor_probes` refuses
 */
export const describe_testing_backdoor_cross_tests = (
	options: TestingBackdoorCrossTestOptions
): void => {
	const { setup_test, capabilities, ws, extra_methods = [] } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const declared = capabilities.testing_backdoors;
	const probes = resolve_backdoor_probes(declared, extra_methods);

	// a declared backdoor's mount is pinned by its anonymous row below (a 401,
	// not `method_not_found`); an undeclared one must not be mounted, so a
	// backend can't mount one its declaration leaves out
	const undeclared = TESTING_BACKDOOR_METHODS.filter((method) => !declared.includes(method));
	// vitest fails a describe holding no test, so a full declaration registers none
	if (undeclared.length > 0) {
		describe('testing backdoor declaration', () => {
			for (const method of undeclared) {
				test(`${method} is undeclared → method_not_found`, async () => {
					const fixture = await setup_test();
					const res = await rpc_call({
						app: fixture.fresh_transport(),
						path: rpc_path,
						method,
						params: BACKDOOR_PARAMS[method]
					});
					assert.ok(
						!res.ok,
						`${method}: undeclared in capabilities.testing_backdoors, but the call succeeded`
					);
					if (!res.ok) {
						assert.strictEqual(
							res.error.code,
							JSONRPC_ERROR_CODES.method_not_found,
							`${method}: undeclared in capabilities.testing_backdoors, but it answers ` +
								`${res.status} (${res.error.code}) — the backend mounts it, so declare it`
						);
					}
					assert.strictEqual(res.status, 404, `${method}: status`);
				});
			}
		});
	}

	// none declared and no extra seam: no rows, and vitest fails an empty describe
	if (probes.length === 0) return;

	describe('testing backdoor credential gate parity', () => {
		for (const { method, params } of probes) {
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
					// `!res.ok` narrows `res` to the error variant for `res.error`.
					if (!res.ok) {
						assert.notStrictEqual(
							res.error.code,
							JSONRPC_ERROR_CODES.method_not_found,
							`${label}: declared but not mounted — the backend answers method_not_found`
						);
						assert.strictEqual(res.status, principal.status, `${label}: status`);
						assert.strictEqual(res.error.code, principal.code, `${label}: error.code`);
						if (principal.reason !== undefined) {
							const reason = (res.error.data as { reason?: unknown } | undefined)?.reason;
							assert.strictEqual(reason, principal.reason, `${label}: error.data.reason`);
						}
					}
				});
			}
		}

		for (const { method, params } of probes) {
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
