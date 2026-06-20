import '../assert_dev_env.ts';

/**
 * Table runner for the declarative cross-backend conformance suite.
 *
 * `describe_conformance_table_tests` takes a list of `ConformanceCase`
 * rows plus the standard `{setup_test, surface_source, capabilities}`
 * fixture protocol every Tier 1 suite uses — so **one runner drives both
 * transports**: in-process via `default_in_process_setup` (fast, every
 * `gro test`) and cross-process via `default_cross_process_setup` (the
 * conformance gate, exercising each impl's real auth resolution over real
 * HTTP). Same case definition, transport-parameterized.
 *
 * Each row references a `method`; the runner resolves its `input` /
 * `output` schema from the live spec registry (RPC) or `RouteSpec` (the 6
 * REST auth routes) — the row never carries a schema. The principal the
 * row runs `as` resolves to a `TestFixture` accessor via
 * `resolve_principal` — no inline credential minting.
 *
 * @module
 */

import {assert, describe, test} from 'vitest';

import type {AppSurfaceSpec} from '../../http/surface.ts';
import type {RouteMethod} from '../../http/route_spec.ts';
import type {SessionOptions} from '../../auth/session_cookie.ts';
import {
	find_auth_route,
	rest_auth_route_suffixes,
	type RestAuthRouteSuffix,
} from '../integration_helpers.ts';
import {
	find_rpc_action,
	rpc_call,
	resolve_rpc_endpoints_for_setup,
	type RpcEndpointsSuiteOption,
} from '../rpc_helpers.ts';
import type {FetchTransport} from '../transports/fetch_transport.ts';
import {type ConformanceCase, type ConformancePrincipal} from './conformance_case.ts';
import type {BackendCapabilities} from './capabilities.ts';
import type {SetupTest, TestFixture} from './setup.ts';
import {xfail_until} from './xfail.ts';

/**
 * Names a seeded `extra_accounts` username for the `role_holder` /
 * `wrong_role` principals — the only two that aren't backed by an
 * always-available fixture accessor. Suites exercising those principals
 * declare the matching `extra_accounts` at setup and name them here.
 */
export interface ConformancePrincipalConfig {
	/** `extra_accounts` username for the `role_holder` principal. */
	readonly role_holder?: string;
	/** `extra_accounts` username for the `wrong_role` principal. */
	readonly wrong_role?: string;
}

/** Options for `describe_conformance_table_tests`. */
export interface ConformanceTableOptions {
	/** The conformance cases to run, in order. */
	readonly cases: ReadonlyArray<ConformanceCase>;
	/** Per-test fixture producer (in-process or cross-process). */
	readonly setup_test: SetupTest;
	/** Surface spec — supplies the `RouteSpec`s for the REST branch. */
	readonly surface_source: AppSurfaceSpec;
	/** Declared backend capabilities (reserved for capability-gated rows). */
	readonly capabilities: BackendCapabilities;
	/** RPC endpoints — resolved to find each method's action spec. */
	readonly rpc_endpoints: RpcEndpointsSuiteOption;
	/** Session options — needed to resolve the `rpc_endpoints` factory form. */
	readonly session_options: SessionOptions<string>;
	/** Maps the `role_holder` / `wrong_role` principals to seeded usernames. */
	readonly principals?: ConformancePrincipalConfig;
	/** `describe` block label. Defaults to `'conformance table'`. */
	readonly suite_name?: string;
}

/** A resolved principal: the transport + headers a case fires through. */
interface ResolvedPrincipal {
	readonly transport: FetchTransport;
	readonly headers: Record<string, string>;
	/**
	 * Suppress the default `Origin` header on the request. Required for
	 * non-browser credential probes (bearer / daemon) — `bearer_auth`
	 * discards the token when `Origin` / `Referer` is present.
	 */
	readonly suppress_default_origin?: boolean;
}

/**
 * Map a `ConformancePrincipal` onto the transport + headers it
 * authenticates with, reading exclusively from the per-test `TestFixture`.
 *
 * The five always-available principals resolve from fixture accessors;
 * `role_holder` / `wrong_role` read a seeded `extra_accounts` entry named
 * via `options.principals` (throws a clear setup error when unconfigured).
 */
const resolve_principal = async (
	fixture: TestFixture,
	as: ConformancePrincipal,
	principals: ConformancePrincipalConfig | undefined,
): Promise<ResolvedPrincipal> => {
	switch (as) {
		case 'keeper':
			// Keeper carries its session cookie via `create_session_headers`
			// (in-process the transport is stateless; cross-process the jar
			// also holds it — the explicit header is the same value).
			return {transport: fixture.transport, headers: fixture.create_session_headers()};
		case 'daemon':
			// Daemon-token is a non-browser credential — empty jar + no Origin.
			return {
				transport: fixture.fresh_transport({origin: null}),
				headers: fixture.create_daemon_token_headers(),
				suppress_default_origin: true,
			};
		case 'token':
			// Bearer is discarded in a browser context — empty jar + no Origin.
			return {
				transport: fixture.fresh_transport({origin: null}),
				headers: fixture.create_bearer_headers(),
				suppress_default_origin: true,
			};
		case 'anonymous':
			// Fresh jar so the keeper cookie (cross-process) can't leak in.
			return {transport: fixture.fresh_transport(), headers: {}};
		case 'fresh_non_admin': {
			const account = await fixture.create_account();
			return {transport: fixture.fresh_transport(), headers: account.create_session_headers()};
		}
		case 'expired_session': {
			// The keeper presented via an expired server-side session — fresh
			// jar so only the (expired) cookie this seam returns is sent. The
			// minted cookie payload is valid; the backdated `auth_session` row
			// is what the DB-row expiry gate refuses.
			const cookie = await fixture.mint_expired_session();
			return {transport: fixture.fresh_transport(), headers: {cookie}};
		}
		case 'role_holder':
		case 'wrong_role': {
			const username = principals?.[as];
			if (!username) {
				throw new Error(
					`conformance: principal '${as}' requires options.principals.${as} naming a seeded ` +
						`extra_accounts username (declare the account at setup via extra_accounts).`,
				);
			}
			const extra = fixture.extra_accounts[username];
			if (!extra) {
				throw new Error(
					`conformance: extra_accounts['${username}'] not seeded for principal '${as}' — ` +
						`declare it in the suite's extra_accounts option.`,
				);
			}
			return {transport: fixture.fresh_transport(), headers: extra.create_session_headers()};
		}
	}
};

/** Assert each expected field deep-equals the corresponding response field. */
const assert_fields = (actual: unknown, fields: Record<string, unknown>, label: string): void => {
	assert.ok(
		actual !== null && typeof actual === 'object',
		`${label}: expected an object to read fields from, got ${JSON.stringify(actual)}`,
	);
	const record = actual as Record<string, unknown>;
	for (const [key, expected] of Object.entries(fields)) {
		assert.deepEqual(record[key], expected, `${label}: field '${key}'`);
	}
};

const is_success_status = (status: number): boolean => status >= 200 && status < 300;

/**
 * The wire-distinguishing content a case observed — `{status, body}` where
 * `body` is the success `result` or the error envelope (`{code, message,
 * data?}` for RPC, the flat `{error, ...}` for REST). Equivalence groups
 * compare this for byte-identity, so it is exactly what a prober sees.
 */
interface NormalizedResponse {
	readonly status: number;
	readonly body: unknown;
}

/**
 * Run one conformance case end-to-end: resolve the principal, dispatch the
 * request, and assert the expected status / reason / fields. Returns the
 * normalized response so the caller can feed an equivalence group.
 */
const run_case = async (
	c: ConformanceCase,
	options: ConformanceTableOptions,
	resolved_rpc_endpoints: ReturnType<typeof resolve_rpc_endpoints_for_setup>,
): Promise<NormalizedResponse> => {
	const fixture = await options.setup_test();
	const {transport, headers, suppress_default_origin} = await resolve_principal(
		fixture,
		c.request.as,
		options.principals,
	);

	if (c.request.method.startsWith('/')) {
		return run_rest_case(c, options, transport, headers);
	}
	return run_rpc_case(c, transport, headers, suppress_default_origin, resolved_rpc_endpoints);
};

/** Dispatch + assert a case targeting an RPC method. */
const run_rpc_case = async (
	c: ConformanceCase,
	transport: FetchTransport,
	headers: Record<string, string>,
	suppress_default_origin: boolean | undefined,
	resolved_rpc_endpoints: ReturnType<typeof resolve_rpc_endpoints_for_setup>,
): Promise<NormalizedResponse> => {
	const found = find_rpc_action(resolved_rpc_endpoints, c.request.method);
	if (!found) {
		throw new Error(
			`conformance: RPC method '${c.request.method}' not found on the surface — ` +
				`check the method name or that the action is registered on rpc_endpoints.`,
		);
	}

	const res = await rpc_call({
		app: transport,
		path: found.path,
		method: c.request.method,
		params: c.request.params,
		headers,
		...(c.request.verb && {verb: c.request.verb}),
		...(suppress_default_origin && {suppress_default_origin: true}),
	});

	if (is_success_status(c.expect.status)) {
		assert.ok(
			res.ok,
			`${c.name}: expected success (${c.expect.status}) but got error ${JSON.stringify(
				res.ok ? undefined : res.error,
			)}`,
		);
		assert.strictEqual(res.status, c.expect.status, `${c.name}: status`);
		const parsed = found.action.spec.output.safeParse(res.result);
		assert.ok(
			parsed.success,
			`${c.name}: result does not match spec.output: ${JSON.stringify(
				parsed.success ? undefined : parsed.error.issues,
			)}`,
		);
		if (c.expect.fields) assert_fields(res.result, c.expect.fields, c.name);
		return {status: res.status, body: res.result};
	}

	assert.ok(!res.ok, `${c.name}: expected error status ${c.expect.status} but got success`);
	assert.strictEqual(res.status, c.expect.status, `${c.name}: error status`);
	if (c.expect.error_reason !== undefined) {
		// A row that *declares* a reason must carry it — present AND equal —
		// mirroring the REST branch's unconditional `body.error` assertion. The
		// earlier skip-if-absent form let a backend that dropped the reason pass
		// a row declaring one, blessing a reason/forensic-parity divergence (the
		// IDOR-mask / privilege reason is exactly the distinguishing bit). Rows
		// whose denial genuinely has no reason (the bare `unauthenticated()` 401)
		// simply omit `error_reason` and are pinned by `status` above.
		const reason = (res.error.data as {reason?: unknown} | undefined)?.reason;
		assert.strictEqual(reason, c.expect.error_reason, `${c.name}: error.data.reason`);
	}
	if (c.expect.fields) assert_fields(res.error.data, c.expect.fields, c.name);
	return {status: res.status, body: res.error};
};

/** Dispatch + assert a case targeting one of the 6 REST auth routes. */
const run_rest_case = async (
	c: ConformanceCase,
	options: ConformanceTableOptions,
	transport: FetchTransport,
	headers: Record<string, string>,
): Promise<NormalizedResponse> => {
	const suffix = c.request.method as RestAuthRouteSuffix;
	if (!rest_auth_route_suffixes.includes(suffix)) {
		throw new Error(
			`conformance: REST method '${c.request.method}' is not a known auth-route suffix ` +
				`(${rest_auth_route_suffixes.join(', ')}). Use an RPC method name for RPC actions.`,
		);
	}
	const verb: RouteMethod = c.request.verb ?? 'POST';
	const route = find_auth_route(options.surface_source.route_specs, suffix, verb);
	if (!route) {
		throw new Error(`conformance: no REST route spec for ${verb} ${suffix} on the surface.`);
	}

	const init: RequestInit = {
		method: verb,
		headers: {'Content-Type': 'application/json', ...headers},
		...(verb !== 'GET' &&
			c.request.params !== undefined && {body: JSON.stringify(c.request.params)}),
	};
	const response = await transport(route.path, init);
	assert.strictEqual(response.status, c.expect.status, `${c.name}: status`);

	const body: unknown = await response.json().catch(() => undefined);
	if (is_success_status(c.expect.status)) {
		const parsed = route.output.safeParse(body);
		assert.ok(
			parsed.success,
			`${c.name}: body does not match route output: ${JSON.stringify(
				parsed.success ? undefined : parsed.error.issues,
			)}`,
		);
	} else if (c.expect.error_reason !== undefined) {
		const error = (body as {error?: unknown} | undefined)?.error;
		assert.strictEqual(error, c.expect.error_reason, `${c.name}: body.error`);
	}
	if (c.expect.fields) assert_fields(body, c.expect.fields, c.name);
	return {status: response.status, body};
};

/**
 * Register a `describe` block running every `ConformanceCase` as a
 * vitest `test` (or `xfail_until` for deferred-by-design rows). Drives
 * either transport via the shared `{setup_test, surface_source,
 * capabilities}` protocol.
 */
export const describe_conformance_table_tests = (options: ConformanceTableOptions): void => {
	const resolved_rpc_endpoints = resolve_rpc_endpoints_for_setup(
		options.rpc_endpoints,
		options.session_options,
	);
	// Per-group normalized responses, populated as the member case tests run
	// and consulted by the per-group byte-identity assertions registered after
	// the case loop — vitest runs a describe's tests in registration order, so
	// the group assertions execute last, after every member has recorded.
	const equivalence_groups = new Map<
		string,
		Array<{name: string; normalized: NormalizedResponse}>
	>();
	const group_names = new Set<string>();
	for (const c of options.cases) {
		if (c.expect.equivalence_group) group_names.add(c.expect.equivalence_group);
	}
	describe(options.suite_name ?? 'conformance table', () => {
		for (const c of options.cases) {
			const label = c.note ? `${c.name} — ${c.note}` : c.name;
			const group = c.expect.equivalence_group;
			const body = async (): Promise<void> => {
				const normalized = await run_case(c, options, resolved_rpc_endpoints);
				if (group) {
					const members = equivalence_groups.get(group) ?? [];
					members.push({name: c.name, normalized});
					equivalence_groups.set(group, members);
				}
			};
			if (c.xfail) {
				xfail_until(c.xfail.tracking_id, c.xfail.reason, label, body);
			} else {
				test(label, body);
			}
		}
		// Negative-space gate: every member of an equivalence group must have
		// produced a byte-identical `{status, body}`. This holds the impl under
		// test to "a prober cannot distinguish these masked paths" — the
		// promotion of a masked pair (wrong-password ≡ account-not-found,
		// found-but-unauthorized ≡ not-found) from "same status + reason" to
		// "wire-indistinguishable". Runs per impl, so each spine is held to it.
		for (const group of group_names) {
			test(`equivalence group '${group}' — members are wire-indistinguishable`, () => {
				const members = equivalence_groups.get(group) ?? [];
				assert.ok(
					members.length >= 2,
					`equivalence group '${group}': expected >= 2 members to have recorded, got ` +
						`${members.length} — a group pins indistinguishability between paths, so it ` +
						`needs at least a pair (check the member cases ran and weren't all xfail).`,
				);
				const [first, ...rest] = members;
				// `members.length >= 2` guarantees `first` is defined; the explicit
				// assert narrows it for the typechecker (noUncheckedIndexedAccess).
				assert.ok(first);
				for (const member of rest) {
					assert.deepStrictEqual(
						member.normalized,
						first.normalized,
						`equivalence group '${group}': '${member.name}' is distinguishable from ` +
							`'${first.name}' — a prober could tell these masked paths apart. The ` +
							`normalized {status, body} must be byte-identical across all members.`,
					);
				}
			});
		}
	});
};
