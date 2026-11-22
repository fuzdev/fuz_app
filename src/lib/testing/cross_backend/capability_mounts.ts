import '../assert_dev_env.ts';

/**
 * Cross-backend suite holding a backend's mount flags to what it mounts, in
 * both directions.
 *
 * A capability flag gates the suites that need its surface: `true` runs them,
 * `false` skips them. Nothing in those suites checks a `false` — a backend
 * declaring `cell_crud: false` while mounting the cell verbs skips the cell
 * suites, and its cell surface goes untested with no failure anywhere. And on a
 * backend declaring every flag `true`, as fuz_app's own spine presets do, a
 * check of the `false` direction alone would never run. So each flag a request
 * can observe is probed once, and the observation must equal the declaration:
 * `true` must answer as mounted, `false` as unmounted.
 *
 * Each probe is the cheapest honest request — anonymous, so no setup state
 * shapes the answer — and none of them answers a mounted surface with a `404`.
 * An unmounted path under `/api` answers `404`: the spine's JSON
 * `route_not_found`, or no body where a runtime drops a refused upgrade's body
 * or a backend's own fallback answers `/api` paths.
 *
 * - **RPC verbs** (`cell_crud`: `cell_create`, `cell_relations`:
 *   `cell_grant_create`) — both spines look a method up before they
 *   authenticate the caller, so a mounted verb refuses an anonymous call `401`
 *   and an unmounted one answers `method_not_found` (`404`).
 * - **Auth-gated routes** (`sse` on `sse_path`, `account_status`) — a mounted
 *   route refuses an anonymous `GET` `401`.
 * - **The fact routes** (`fact_serving`, `fact_serving_admin_hash`) — a
 *   malformed `hash` param: both spines validate a route's params ahead of
 *   auth, so a mounted route answers `400` `invalid_route_params`. (The cell
 *   route's masked `404` for a cell no row names can't tell itself from a
 *   bodiless unmatched `404`.)
 * - **`ready`** — `GET /ready` answers `200 {ready: true}`, or `503` with
 *   `schema_drift` / `db_unreachable` (mounted, if drifted — the readiness
 *   suite fails that); unmounted, a `404` (any body — the spine fallback's
 *   plain text) or a `200` that isn't JSON (a static page).
 * - **WebSocket endpoints** (`ws` on `ws_path`, `ws_role_gated` on the gated
 *   path) — a mounted endpoint refuses an anonymous upgrade `401`.
 * - **`ws_account_actions`** — `account_verify` sent on the keeper's session
 *   socket answers unless the endpoint lacks it (`method_not_found`). Needs
 *   `ws`: with `ws` declared `false` the probe is skipped when the flag is
 *   `false` too, and fails when it is `true`.
 *
 * An answer that is neither the mounted nor the unmounted one fails the probe.
 *
 * **Unmounted controls.** On a backend declaring every probed flag `true`, as
 * fuz_app's spine presets do, no probe meets an unmounted surface, so a
 * classifier reading every answer as mounted would pass. Each flag's own probe
 * is also sent to its surface moved where no backend mounts anything
 * (`CAPABILITY_MOUNTS_ABSENT` — the path under an absent segment, the method
 * renamed), and must read as unmounted, on every backend. So a backend with a
 * catch-all under `/api`, or an RPC dispatcher answering an unknown method,
 * fails the controls: the suite rests on the spine's `404` and
 * `method_not_found` for what isn't mounted.
 *
 * The other flags are listed in `UNPROBED_CAPABILITIES` with why no request
 * checks them, and each shows in the run as a skipped test carrying that
 * reason. `ProbedCapability` and `UNPROBED_CAPABILITIES` together are
 * exhaustive over `BackendCapabilities` by their types, so a new flag fails to
 * compile until it is classified.
 *
 * `describe_spine_cross_suites` runs this suite on every backend and refuses to
 * exclude it, exclude one of its cases, or override any of its options: it
 * checks the declarations every other suite gates on, so each path it probes
 * is the one the suites gated on that flag send to — the backend config's,
 * `ws_role_gated`'s `gated_ws_path`, `ready`'s `ready_path`, and the
 * `SPINE_ACCOUNT_STATUS_PATH` that `query_shape`, `token_scope_surface` and
 * `request_target_conformance_wire` (each gated on `account_status`) send to.
 * A probe whose sibling suite the call excludes falls back to the spine
 * default, and its failure names the remedy (`path_notes`). It runs cross-process
 * only — in-process apps are assembled per test file, each mounting what its
 * suite needs, so no one in-process declaration describes them, and the WS
 * probes need a real socket.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	ERROR_DB_UNREACHABLE,
	ERROR_INVALID_ROUTE_PARAMS,
	ERROR_ROUTE_NOT_FOUND,
	ERROR_SCHEMA_DRIFT
} from '../../http/error_schemas.ts';
import { JSONRPC_ERROR_CODES } from '../../http/jsonrpc_errors.ts';
import { rpc_call } from '../rpc_helpers.ts';
import { create_ws_transport, WsUpgradeRefusedError } from '../transports/ws_transport.ts';
import { is_response_for, type JsonrpcErrorResponseFrame } from '../transports/ws_client.ts';
import type { BackendCapabilities } from './capabilities.ts';
import { test_skip_gated } from './declared_skips.ts';
import type { RpcPathCapabilityGatedCrossSuiteOptions, SetupTest, TestFixture } from './setup.ts';
import {
	SPINE_ACCOUNT_STATUS_PATH,
	SPINE_ROLE_GATED_WS_PATH,
	SPINE_RPC_PATH,
	SPINE_SSE_PATH,
	SPINE_WS_PATH
} from './spine_surface_constants.ts';
import { open_session_ws } from './ws_endpoint.ts';

/** The capability flags a request can observe, each probed in both directions. */
export type ProbedCapability = keyof Pick<
	BackendCapabilities,
	| 'ws'
	| 'sse'
	| 'cell_crud'
	| 'cell_relations'
	| 'fact_serving'
	| 'fact_serving_admin_hash'
	| 'ready'
	| 'account_status'
	| 'ws_account_actions'
	| 'ws_role_gated'
>;

/** The capabilities no probe checks — every `BackendCapabilities` key but the probed ones. */
export type UnprobedCapability = Exclude<keyof BackendCapabilities, ProbedCapability>;

/**
 * Why each unprobed capability has no probe, shown in the run as a skipped
 * test. Keyed by `UnprobedCapability`, so a new flag fails to compile until it
 * is either probed or listed here.
 */
export const UNPROBED_CAPABILITIES: Readonly<Record<UnprobedCapability, string>> = Object.freeze({
	account_lifecycle:
		'gates behavior, not a mount: the lifecycle verbs are on the declared surface, whose round-trip and attack-surface suites already reach them',
	peer_request:
		'the server→client request direction (`peer/ping`, a protocol action), which no request a client sends can observe; the peer suite drives it',
	cell_gated_create:
		'names a test policy over the cell verbs, not a mount — a backend mounting the verbs over its own policy states `false`; `cell_crud` probes the verbs',
	rooms:
		'names a test policy (the test room authorizer) over the room verbs, not a mount — a backend mounting rooms over its own authorizer states `false`',
	ws_handshake_pipelining: "a trait of the backend's HTTP runtime, not a mount",
	ws_refusal_body: "a trait of the backend's HTTP runtime, not a mount",
	ws_upgrade_runtime_refusals:
		"a trait of the backend's HTTP runtime, not a mount; the request header wire leg fails a declaration the runtime doesn't honor",
	runtime_resolves_dot_segments:
		"a trait of the backend's HTTP runtime, not a mount; the request target wire leg fails a declaration the runtime doesn't honor",
	spine_fallback:
		"the fallback's behavior, not a mount; the request target wire leg's rows outside `/api` fail a `true` the backend doesn't honor",
	host_gate:
		"the host gate's configuration, not a mount; the request header wire leg's host rows fail a `true` the backend doesn't honor",
	testing_backdoors:
		'a list, checked against the backend in both directions by the testing-backdoor suite'
});

/** Options for the capability mount suite. */
export interface CapabilityMountsCrossTestOptions extends RpcPathCapabilityGatedCrossSuiteOptions {
	/** Base URL the backend is reachable at (e.g. `http://localhost:1178`), for the upgrade probes. */
	readonly base_url: string;
	/** WebSocket endpoint path. Default `SPINE_WS_PATH`. */
	readonly ws_path?: string;
	/** Audit-log SSE stream path. Default `SPINE_SSE_PATH`. */
	readonly sse_path?: string;
	/** Role-gated WebSocket endpoint path. Default `SPINE_ROLE_GATED_WS_PATH`. */
	readonly gated_ws_path?: string;
	/** Readiness route path. Default `/ready`. */
	readonly ready_path?: string;
	/**
	 * A note per flag, added to that probe's failure — where its path came from
	 * and how to move it. `describe_spine_cross_suites` sets one for a flag
	 * whose path it reads from a sibling suite the call excludes.
	 */
	readonly path_notes?: Readonly<Partial<Record<ProbedCapability, string>>>;
}

/** What a probe saw: whether the surface answered as mounted, and the answer, for the failure message. */
interface MountObservation {
	readonly mounted: boolean;
	readonly answer: string;
}

/**
 * The suite's options with every path resolved — where the probes send. Each
 * of these is a declaration as much as a flag is: a probe sent to the wrong
 * path finds nothing mounted there.
 *
 * @internal Used by the suite's own tests and `describe_spine_cross_suites` — not stable API.
 */
export interface CapabilityMountsTarget {
	readonly base_url: string;
	readonly rpc_path: string;
	readonly ws_path: string;
	readonly sse_path: string;
	readonly gated_ws_path: string;
	readonly ready_path: string;
}

/**
 * Resolve the suite's paths, each option's default filled.
 *
 * @param options - the suite's options
 * @returns where every probe sends
 * @internal Used by the suite's own tests and `describe_spine_cross_suites`, which derives the
 *   suite's options resolved — not stable API.
 */
export const resolve_capability_mounts_target = (
	options: Omit<CapabilityMountsCrossTestOptions, 'setup_test' | 'capabilities'>
): CapabilityMountsTarget => ({
	base_url: options.base_url,
	rpc_path: options.rpc_path ?? SPINE_RPC_PATH,
	ws_path: options.ws_path ?? SPINE_WS_PATH,
	sse_path: options.sse_path ?? SPINE_SSE_PATH,
	gated_ws_path: options.gated_ws_path ?? SPINE_ROLE_GATED_WS_PATH,
	ready_path: options.ready_path ?? '/ready'
});

interface MountProbe {
	/**
	 * The request, for the test name — with `absent`, the control's: the same
	 * request to the surface moved where nothing is mounted (`to_absent_path`,
	 * `to_absent_method`).
	 */
	readonly request: (target: CapabilityMountsTarget, absent: boolean) => string;
	/** The answer of a mounted surface, for the test name. */
	readonly mounted: string;
	/** The answer of an unmounted one, for the test name. */
	readonly unmounted: string;
	/**
	 * Send the request and classify the answer.
	 *
	 * @throws AssertionError - on an answer that is neither the mounted nor the unmounted one
	 */
	readonly observe: (
		fixture: TestFixture,
		target: CapabilityMountsTarget,
		absent: boolean
	) => Promise<MountObservation>;
}

/** A well-formed UUID no row has. */
const PROBE_CELL_ID = '00000000-0000-4000-8000-000000000000';

/**
 * A `hash` param no fact route accepts: both spines validate a route's params
 * ahead of auth and answer the flat `400` `invalid_route_params`, an answer
 * only a mounted route gives.
 */
const PROBE_MALFORMED_FACT_HASH = 'not-a-hash';

/**
 * The name the unmounted controls send to: a path segment, RPC method and WS
 * method no backend mounts.
 */
export const CAPABILITY_MOUNTS_ABSENT = 'capability_mounts_absent';

/** A path moved under `CAPABILITY_MOUNTS_ABSENT`, inside `/api` when it was. */
const to_absent_path = (path: string): string =>
	path.startsWith('/api/')
		? `/api/${CAPABILITY_MOUNTS_ABSENT}${path.slice('/api'.length)}`
		: `/${CAPABILITY_MOUNTS_ABSENT}${path}`;

/** A method renamed under `CAPABILITY_MOUNTS_ABSENT`. */
const to_absent_method = (method: string): string => `${CAPABILITY_MOUNTS_ABSENT}_${method}`;

/** `path_of`'s path, moved when `absent`. */
const locate = (
	path_of: (t: CapabilityMountsTarget) => string,
	t: CapabilityMountsTarget,
	absent: boolean
): string => (absent ? to_absent_path(path_of(t)) : path_of(t));

/** Parse JSON text, `undefined` when it isn't JSON. */
const parse_json = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

const error_of = (json: unknown): unknown =>
	json !== null && typeof json === 'object' ? (json as { error?: unknown }).error : undefined;

/** A status and the start of its body, for a failure message. */
const describe_answer = (status: number, text: string): string =>
	`${status} ${text === '' ? '(no body)' : text.slice(0, 200)}`;

/**
 * Whether an answer is an unmatched path's `404` under `/api`: the spine's JSON
 * `route_not_found`, or a bodiless one — what a runtime dropping a refused
 * upgrade's body (`ws_refusal_body`) sends, and a backend whose own fallback
 * answers `/api` paths. No probe's mounted answer is a `404`.
 */
const is_unmatched_404 = (status: number, text: string): boolean =>
	status === 404 && (text === '' || error_of(parse_json(text)) === ERROR_ROUTE_NOT_FOUND);

const UNMATCHED_404 = `404 (${ERROR_ROUTE_NOT_FOUND} or no body)`;

/** An anonymous RPC call: `401` mounted, `method_not_found` unmounted. */
const rpc_probe = (declared_method: string): MountProbe => ({
	request: (t, absent) =>
		`anonymous \`${absent ? to_absent_method(declared_method) : declared_method}\` on ${t.rpc_path}`,
	mounted: '401',
	unmounted: 'method_not_found',
	observe: async (fixture, t, absent) => {
		const method = absent ? to_absent_method(declared_method) : declared_method;
		const res = await rpc_call({ app: fixture.fresh_transport(), path: t.rpc_path, method });
		const answer = res.ok
			? `${res.status} result`
			: `${res.status} error ${res.error.code} ${res.error.message}`;
		if (!res.ok && res.status === 401 && res.error.code === JSONRPC_ERROR_CODES.unauthenticated) {
			return { mounted: true, answer };
		}
		if (!res.ok && res.status === 404 && res.error.code === JSONRPC_ERROR_CODES.method_not_found) {
			return { mounted: false, answer };
		}
		assert.fail(`${method}: expected 401 (mounted) or method_not_found (unmounted), got ${answer}`);
	}
});

/**
 * An anonymous `GET`: the route's own refusal mounted, an unmatched `404`
 * unmounted.
 */
const route_probe = (
	path_of: (t: CapabilityMountsTarget) => string,
	mounted: { readonly status: number; readonly error?: string }
): MountProbe => {
	const mounted_label = `${mounted.status}${mounted.error ? ` ${mounted.error}` : ''}`;
	return {
		request: (t, absent) => `anonymous GET ${locate(path_of, t, absent)}`,
		mounted: mounted_label,
		unmounted: UNMATCHED_404,
		observe: async (fixture, t, absent) => {
			const path = locate(path_of, t, absent);
			const res = await fixture.fresh_transport()(path, { method: 'GET' });
			const text = await res.text();
			const answer = describe_answer(res.status, text);
			if (
				res.status === mounted.status &&
				(mounted.error === undefined || error_of(parse_json(text)) === mounted.error)
			) {
				return { mounted: true, answer };
			}
			if (is_unmatched_404(res.status, text)) return { mounted: false, answer };
			assert.fail(
				`GET ${path}: expected ${mounted_label} (mounted) or ${UNMATCHED_404} (unmounted), got ${answer}`
			);
		}
	};
};

/** An anonymous upgrade: refused `401` mounted, `404` unmounted. */
const upgrade_probe = (path_of: (t: CapabilityMountsTarget) => string): MountProbe => ({
	request: (t, absent) => `anonymous upgrade on ${locate(path_of, t, absent)}`,
	mounted: '401',
	unmounted: UNMATCHED_404,
	observe: async (_fixture, t, absent) => {
		const ws_path = locate(path_of, t, absent);
		let refusal: WsUpgradeRefusedError;
		try {
			const client = await create_ws_transport({
				base_url: t.base_url,
				ws_path,
				cookies: [],
				origin: t.base_url
			});
			await client.close();
			assert.fail(`upgrade on ${ws_path}: an anonymous socket opened`);
		} catch (error) {
			if (!(error instanceof WsUpgradeRefusedError)) throw error;
			refusal = error;
		}
		const answer = describe_answer(refusal.status, refusal.body);
		if (refusal.status === 401) return { mounted: true, answer };
		if (is_unmatched_404(refusal.status, refusal.body)) return { mounted: false, answer };
		assert.fail(
			`upgrade on ${ws_path}: expected a 401 (mounted) or 404 (unmounted) refusal, got ${answer}`
		);
	}
});

/**
 * `GET` of a readiness route outside `/api`: `200 {ready: true}`, or `503`
 * with a drift code, mounted; a `404` (any body — the fallback's plain text
 * included) or a `200` that isn't JSON (a static page) unmounted.
 */
const ready_probe = (path_of: (t: CapabilityMountsTarget) => string): MountProbe => ({
	request: (t, absent) => `GET ${locate(path_of, t, absent)}`,
	mounted: `200 {ready: true} (or 503 ${ERROR_SCHEMA_DRIFT} / ${ERROR_DB_UNREACHABLE})`,
	unmounted: '404, or a 200 that is not JSON',
	observe: async (fixture, t, absent) => {
		const path = locate(path_of, t, absent);
		const res = await fixture.fresh_transport({ origin: null })(path, { method: 'GET' });
		const text = await res.text();
		const json = parse_json(text);
		const answer = describe_answer(res.status, text);
		const ready = json !== null && typeof json === 'object' && 'ready' in json && json.ready;
		const error = error_of(json);
		if (
			(res.status === 200 && ready === true) ||
			(res.status === 503 && (error === ERROR_SCHEMA_DRIFT || error === ERROR_DB_UNREACHABLE))
		) {
			return { mounted: true, answer };
		}
		if (res.status === 404 || (res.status === 200 && json === undefined)) {
			return { mounted: false, answer };
		}
		assert.fail(
			`GET ${path}: expected 200 {ready: true} or a drift 503 (mounted), or a 404 or a ` +
				`non-JSON 200 (unmounted), got ${answer}`
		);
	}
});

/** A method sent on the keeper's session socket: any answer mounted, `method_not_found` unmounted. */
const socket_method_probe = (declared_method: string): MountProbe => ({
	request: (t, absent) =>
		`\`${absent ? to_absent_method(declared_method) : declared_method}\` on the keeper's session socket on ${t.ws_path}`,
	mounted: 'an answer',
	unmounted: 'method_not_found',
	observe: async (fixture, t, absent) => {
		const method = absent ? to_absent_method(declared_method) : declared_method;
		const client = await open_session_ws({ base_url: t.base_url, ws_path: t.ws_path }, fixture, {
			admitted: true
		});
		try {
			const id = `capability_mounts_${method}`;
			await client.send({ jsonrpc: '2.0', id, method });
			const frame = await client.wait_for<Partial<JsonrpcErrorResponseFrame>>(is_response_for(id));
			const answer = JSON.stringify(frame).slice(0, 200);
			return { mounted: frame.error?.code !== JSONRPC_ERROR_CODES.method_not_found, answer };
		} finally {
			await client.close();
		}
	}
});

const PROBES: Readonly<Record<ProbedCapability, MountProbe>> = {
	ws: upgrade_probe((t) => t.ws_path),
	sse: route_probe((t) => t.sse_path, { status: 401 }),
	cell_crud: rpc_probe('cell_create'),
	cell_relations: rpc_probe('cell_grant_create'),
	fact_serving: route_probe(
		() => `/api/cells/${PROBE_CELL_ID}/facts/${PROBE_MALFORMED_FACT_HASH}`,
		{ status: 400, error: ERROR_INVALID_ROUTE_PARAMS }
	),
	fact_serving_admin_hash: route_probe(() => `/api/facts/${PROBE_MALFORMED_FACT_HASH}`, {
		status: 400,
		error: ERROR_INVALID_ROUTE_PARAMS
	}),
	ready: ready_probe((t) => t.ready_path),
	account_status: route_probe(() => SPINE_ACCOUNT_STATUS_PATH, { status: 401 }),
	ws_account_actions: socket_method_probe('account_verify'),
	ws_role_gated: upgrade_probe((t) => t.gated_ws_path)
};

/** Every probed capability, in the order the suite runs them. */
export const PROBED_CAPABILITIES: ReadonlyArray<ProbedCapability> = Object.freeze(
	Object.keys(PROBES) as Array<ProbedCapability>
);

/**
 * One test the suite registers: its describe group, name, and whether it runs.
 *
 * @internal Used by the suite's own tests — not stable API.
 */
export interface CapabilityMountRow {
	readonly group:
		'capability mounts' | 'capability mount controls' | 'capability mounts not probed';
	readonly name: string;
	/**
	 * `run` sends and checks; `fail` fails at once (a contradictory
	 * declaration); `skip` is shown skipped (a flag no request observes);
	 * `gated_skip` is a skip the backend's declarations cause, registered
	 * through `test_skip_gated` so `check_declared_skips` holds it.
	 */
	readonly mode: 'run' | 'fail' | 'skip' | 'gated_skip';
	/** The check a `run` row makes, or the failure a `fail` row reports. */
	readonly body: (setup_test: SetupTest) => Promise<void>;
}

/**
 * Plan the suite's tests from a backend's capabilities and paths — what
 * `describe_capability_mounts_cross_tests` registers, as data, so the
 * classification is checkable without a backend.
 *
 * @param capabilities - the backend's declarations
 * @param target - where the probes send
 * @param path_notes - a note per flag added to its probe's failure
 * @returns every row, in registration order
 * @internal Used by the suite's own tests — not stable API.
 */
export const plan_capability_mount_rows = (
	capabilities: BackendCapabilities,
	target: CapabilityMountsTarget,
	path_notes: Readonly<Partial<Record<ProbedCapability, string>>> = {}
): Array<CapabilityMountRow> => {
	const rows: Array<CapabilityMountRow> = [];
	const noop = (): Promise<void> => Promise.resolve();
	for (const flag of PROBED_CAPABILITIES) {
		const probe = PROBES[flag];
		const declared = capabilities[flag];
		const name =
			`${flag} declared ${declared}: ${probe.request(target, false)} → ` +
			(declared ? probe.mounted : probe.unmounted);
		// the account-actions probe needs a socket; with no WS endpoint
		// declared, a `false` has nothing to probe, and a `true` is wrong
		if (flag === 'ws_account_actions' && !capabilities.ws) {
			rows.push(
				declared
					? {
							group: 'capability mounts',
							name,
							mode: 'fail',
							body: () =>
								Promise.reject(
									new Error(
										'capabilities.ws_account_actions is true, but capabilities.ws is false — ' +
											'the account actions need a WebSocket endpoint to be mounted on'
									)
								)
						}
					: {
							group: 'capability mounts',
							name: `${flag}: no WebSocket endpoint to probe (capabilities.ws is false)`,
							mode: 'gated_skip',
							body: noop
						}
			);
			continue;
		}
		rows.push({
			group: 'capability mounts',
			name,
			mode: 'run',
			body: async (setup_test) => {
				const observed = await probe.observe(await setup_test(), target, false);
				const mismatch = declared
					? `capabilities.${flag} is true, but the backend doesn't mount it — ` +
						`${probe.request(target, false)} answered ${observed.answer}`
					: `capabilities.${flag} is false, but the backend mounts it — ` +
						`${probe.request(target, false)} answered ${observed.answer}; declare it true`;
				const note = path_notes[flag];
				assert.strictEqual(
					observed.mounted,
					declared,
					note === undefined ? mismatch : `${mismatch} (${note})`
				);
			}
		});
	}
	for (const flag of PROBED_CAPABILITIES) {
		const probe = PROBES[flag];
		const name = `${flag} control: ${probe.request(target, true)} → ${probe.unmounted}`;
		// the account-actions control sends on the keeper's socket too
		if (flag === 'ws_account_actions' && !capabilities.ws) {
			rows.push({
				group: 'capability mount controls',
				name: `${name}: no WebSocket endpoint (capabilities.ws is false)`,
				mode: 'gated_skip',
				body: noop
			});
			continue;
		}
		rows.push({
			group: 'capability mount controls',
			name,
			mode: 'run',
			body: async (setup_test) => {
				const observed = await probe.observe(await setup_test(), target, true);
				assert.strictEqual(
					observed.mounted,
					false,
					`${probe.request(target, true)} reads as mounted (answered ${observed.answer}) — ` +
						`the ${flag} probe's classifier is broken, or the backend answers a surface it doesn't mount`
				);
			}
		});
	}
	for (const [flag, reason] of Object.entries(UNPROBED_CAPABILITIES)) {
		rows.push({
			group: 'capability mounts not probed',
			name: `${flag}: ${reason}`,
			mode: 'skip',
			body: noop
		});
	}
	return rows;
};

/**
 * Register the capability mount suite: one probe per `ProbedCapability`, each
 * asserting the backend's answer matches its declaration, the same probe again
 * as an unmounted control, and one skipped test per `UNPROBED_CAPABILITIES`
 * entry naming why.
 *
 * @param options - the fixture, the backend's capabilities, and its paths
 */
export const describe_capability_mounts_cross_tests = (
	options: CapabilityMountsCrossTestOptions
): void => {
	const { setup_test, capabilities } = options;
	const rows = plan_capability_mount_rows(
		capabilities,
		resolve_capability_mounts_target(options),
		options.path_notes
	);
	for (const group of [
		'capability mounts',
		'capability mount controls',
		'capability mounts not probed'
	] as const) {
		describe(group, () => {
			for (const row of rows) {
				if (row.group !== group) continue;
				if (row.mode === 'skip') {
					test.skip(row.name, () => {});
				} else if (row.mode === 'gated_skip') {
					test_skip_gated(row.name, () => {});
				} else {
					test(row.name, () => row.body(setup_test));
				}
			}
		});
	}
};
