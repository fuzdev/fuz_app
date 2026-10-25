import '../assert_dev_env.ts';

/**
 * Cross-process malformed-envelope and invalid-params suite for a JSON-RPC
 * endpoint.
 *
 * `describe_rpc_attack_surface_tests` runs its envelope and params groups
 * in-process against stub apps, so they never reach a spawned backend — and
 * the Rust spine parses envelopes and params by hand, while the
 * action-manifest parity gate compares declarations and is blind to param
 * schemas. This suite sends the same requests over `fixture.transport` to
 * each backend.
 *
 * Two groups:
 *
 * - **Envelopes** — `create_rpc_envelope_cases`, the in-process group's set:
 *   non-JSON body, wrong or missing `jsonrpc`, missing `method` or `id`, a
 *   batch array, non-object POST params, an unknown method, `GET` missing
 *   `method` or `id`, `GET` invalid-JSON params, `GET` non-object params on
 *   every read, and a `GET` of a mutating method.
 *   Each is sent by the principal its method's auth admits, so the envelope
 *   check is what refuses, and each pins status, JSON-RPC code, the echoed
 *   `id`, and `data.reason` (exact where the TS dispatcher sets one, absent
 *   otherwise). Three ordering cases go without a credential: an anonymous
 *   `GET` of a mutating method is refused `invalid_request` rather than 401
 *   (the read restriction runs after the method lookup and before
 *   authorization), an anonymous batch array is refused `invalid_request`
 *   with `id: null` (the envelope parse runs before auth, and batches are
 *   unsupported), and an anonymous `GET` with non-object params is the 401
 *   (params validation runs after authorization).
 * - **Params** — for each declared method, `generate_rpc_params_test_cases`
 *   (the in-process generator minus its structural cases), each sent as the
 *   method's authorized principal and owing 400 `invalid_params` with no
 *   `data.reason`. One test per method, reporting every case that answers
 *   otherwise; `xfail_params` runs named cases of a method as their own
 *   `xfail_until` tests, for a known divergence on one backend.
 *
 * The authorized principal is the keeper on the first channel the method's
 * auth admits: its session, else its daemon token or API token over a
 * no-`Origin` transport (`resolve_conformance_principal`), mirroring the
 * in-process `select_auth_app`. **Preconditions:** the keeper holds every
 * role a declared method gates on (`default_cross_process_setup` seeds
 * `keeper` and `admin`; pass `extra_keeper_roles` for others), and it has a
 * single actor. No generated body carries a valid `acting` — the generator's
 * base fills only required and defaulted fields — and a malformed `acting` is
 * read as omitted ahead of validation on both spines, so a single-actor
 * keeper resolves its actor and validation is what refuses. A keeper with a
 * second actor answers `actor_required` first; such a suite lists the
 * actor-required methods in `skip_methods`.
 *
 * Skipped: `_testing_*` methods (live-mounted only, owned by the backdoor
 * suite) and the protocol actions (`PROTOCOL_ACTION_METHODS`, fixed shared
 * specs covered by the WS suites) — the same set
 * `generate_rpc_auth_conformance_cases` skips.
 *
 * Cross-process only: in-process, `describe_rpc_attack_surface_tests` runs
 * the same envelope cases and params generator.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import type { AppSurfaceRpcMethod, AppSurfaceSpec } from '../../http/surface.ts';
import { is_public_auth, type RouteAuth } from '../../http/auth_shape.ts';
import { JSONRPC_ERROR_CODES } from '../../http/jsonrpc_errors.ts';
import {
	BUILTIN_CREDENTIAL_TYPES,
	CREDENTIAL_TYPE_API_TOKEN,
	CREDENTIAL_TYPE_DAEMON_TOKEN,
	CREDENTIAL_TYPE_SESSION
} from '../../auth/credential_type_schema.ts';
import { PROTOCOL_ACTION_METHODS } from '../../actions/action_codegen.ts';
import { TESTING_METHOD_PREFIX } from '../surface_invariants.ts';
import { create_rpc_post_init } from '../rpc_helpers.ts';
import {
	assert_rpc_envelope_refusal,
	create_rpc_envelope_cases,
	generate_rpc_params_test_cases,
	to_rpc_envelope_request
} from '../rpc_envelope_cases.ts';
import type { ConformancePrincipal } from './conformance_case.ts';
import { resolve_conformance_principal } from './conformance_table.ts';
import type { RpcPathCrossSuiteOptions, TestFixture } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';
import { xfail_until } from './xfail.ts';
import type { InputTestCase } from '../adversarial_input_cases.ts';

/** Options for `describe_rpc_adversarial_cross_tests`. */
export interface RpcAdversarialCrossTestOptions extends RpcPathCrossSuiteOptions {
	/** The declared surface; the endpoint at `rpc_path` supplies the methods and their input schemas. */
	readonly surface_source: AppSurfaceSpec;
	/** Methods to leave out, beyond the `_testing_*` and protocol actions always skipped. */
	readonly skip_methods?: ReadonlyArray<string>;
	/**
	 * Generated params cases a backend is known to answer otherwise, each run
	 * as its own `xfail_until` test; the method's other cases keep their test.
	 * Pass it only for the backend that diverges.
	 */
	readonly xfail_params?: ReadonlyArray<RpcParamsXfail>;
}

/** Generated params cases of one method marked `xfail_until`, by case label. */
export interface RpcParamsXfail {
	readonly method: string;
	/** `InputTestCase.label`s of `generate_rpc_params_test_cases(method's input)`. */
	readonly labels: ReadonlyArray<string>;
	readonly tracking_id: string;
	readonly reason: string;
}

const PROTOCOL_METHODS: ReadonlySet<string> = new Set(PROTOCOL_ACTION_METHODS);

/** The keeper principal on each builtin credential channel. */
const CHANNEL_PRINCIPALS: Readonly<Record<string, ConformancePrincipal>> = {
	[CREDENTIAL_TYPE_SESSION]: 'keeper',
	[CREDENTIAL_TYPE_DAEMON_TOKEN]: 'daemon',
	[CREDENTIAL_TYPE_API_TOKEN]: 'token'
};

/**
 * The principal a method's auth admits: the keeper's session where the
 * method takes one, else the first builtin channel its credential gate
 * names — the choice the in-process `select_auth_app` makes, minus its throw
 * on a non-session channel paired with a role other than keeper (the keeper
 * holds every builtin role, so sending its token there still passes the gate).
 *
 * @param auth - the method's declared auth
 * @returns the principal to send as
 */
const to_authorized_principal = (auth: RouteAuth): ConformancePrincipal => {
	if (is_public_auth(auth)) return 'anonymous';
	const credential_types = auth.credential_types;
	if (!credential_types?.length || credential_types.includes(CREDENTIAL_TYPE_SESSION)) {
		return 'keeper';
	}
	const channel = BUILTIN_CREDENTIAL_TYPES.find((t) => credential_types.includes(t));
	const principal = channel === undefined ? undefined : CHANNEL_PRINCIPALS[channel];
	if (!principal) {
		throw new Error(
			`rpc_adversarial: no builtin channel admits credential types '${credential_types.join(
				"', '"
			)}'`
		);
	}
	return principal;
};

const send_as = async (
	fixture: TestFixture,
	method: AppSurfaceRpcMethod,
	as: 'authorized' | 'anonymous',
	url: string,
	init: RequestInit
): Promise<{ status: number; body: unknown }> => {
	const principal = as === 'anonymous' ? 'anonymous' : to_authorized_principal(method.auth);
	const { transport, headers } = await resolve_conformance_principal(fixture, principal);
	const res = await transport(url, {
		...init,
		headers: { ...(init.headers as Record<string, string> | undefined), ...headers }
	});
	const text = await res.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, body };
};

const reason_of = (body: unknown): unknown => {
	const data = (body as { error?: { data?: unknown } } | null)?.error?.data;
	return typeof data === 'object' && data !== null
		? (data as { reason?: unknown }).reason
		: undefined;
};

/**
 * Run the cross-process malformed-envelope and invalid-params suite.
 *
 * @param options - the fixture, the declared surface, the RPC path, and methods to skip
 */
export const describe_rpc_adversarial_cross_tests = (
	options: RpcAdversarialCrossTestOptions
): void => {
	const { setup_test, surface_source } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const skip = new Set(options.skip_methods);

	const endpoint = surface_source.surface.rpc_endpoints.find((e) => e.path === rpc_path);
	const endpoint_spec = surface_source.rpc_endpoints.find((e) => e.path === rpc_path);

	describe('RPC adversarial envelopes (cross-process)', () => {
		if (!endpoint || !endpoint_spec) {
			test('the RPC endpoint is on the declared surface', () => {
				assert.fail(`no RPC endpoint at '${rpc_path}' on the declared surface`);
			});
			return;
		}
		const cases = create_rpc_envelope_cases(endpoint, { skip_methods: options.skip_methods });
		test('the envelope cases cover the endpoint', () => {
			// both halves need a read and a mutation to choose; a surface
			// lacking either loses cases silently otherwise
			assert.ok(
				cases.some((c) => !c.method.side_effects),
				'no read method to carry the POST and GET envelope cases'
			);
			assert.ok(
				cases.some((c) => c.method.side_effects),
				'no authenticated mutation to carry the GET read-restriction cases'
			);
		});
		for (const c of cases) {
			test(c.name, async () => {
				const fixture = await setup_test();
				const { url, init } = to_rpc_envelope_request(rpc_path, c);
				const { status, body } = await send_as(fixture, c.method, c.as, url, init);
				assert_rpc_envelope_refusal(status, body, c);
			});
		}
	});

	describe('RPC adversarial params (cross-process)', () => {
		if (!endpoint || !endpoint_spec) return;
		let total = 0;
		const xfails = new Map<string, RpcParamsXfail>();
		for (const x of options.xfail_params ?? []) {
			for (const label of x.labels) xfails.set(`${x.method}\0${label}`, x);
		}
		const matched_xfails = new Set<string>();

		/** Send one case; a refusal message when it is not the canonical 400. */
		const check_case = async (
			fixture: TestFixture,
			surface_method: AppSurfaceRpcMethod,
			tc: InputTestCase
		): Promise<string | null> => {
			const { status, body } = await send_as(
				fixture,
				surface_method,
				'authorized',
				rpc_path,
				create_rpc_post_init(surface_method.name, tc.body)
			);
			const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
			if (
				status === 400 &&
				code === JSONRPC_ERROR_CODES.invalid_params &&
				reason_of(body) === undefined
			) {
				return null;
			}
			return `[${tc.label}] params ${JSON.stringify(tc.body)} → ${status} ${JSON.stringify(body)}`;
		};

		for (const action of endpoint_spec.actions) {
			const { method, input } = action.spec;
			if (method.startsWith(TESTING_METHOD_PREFIX) || PROTOCOL_METHODS.has(method)) continue;
			if (skip.has(method)) continue;
			const surface_method = endpoint.methods.find((m) => m.name === method);
			if (!surface_method) continue;
			const all_cases = generate_rpc_params_test_cases(input);
			if (all_cases.length === 0) continue;
			total += all_cases.length;
			const param_cases: Array<InputTestCase> = [];
			for (const tc of all_cases) {
				const key = `${method}\0${tc.label}`;
				const xfail = xfails.get(key);
				if (!xfail) {
					param_cases.push(tc);
					continue;
				}
				matched_xfails.add(key);
				xfail_until(
					xfail.tracking_id,
					xfail.reason,
					`${method}: [${tc.label}] → 400 invalid_params`,
					async () => {
						const failure = await check_case(await setup_test(), surface_method, tc);
						assert.strictEqual(failure, null);
					}
				);
			}
			if (param_cases.length === 0) continue;

			test(`${method}: every generated invalid params case → 400 invalid_params`, async () => {
				const fixture = await setup_test();
				const failures: Array<string> = [];
				for (const tc of param_cases) {
					const failure = await check_case(fixture, surface_method, tc);
					if (failure) failures.push(failure);
				}
				assert.deepStrictEqual(
					failures,
					[],
					`${method}: ${failures.length} of ${param_cases.length} cases not refused invalid_params`
				);
			});
		}
		test('every xfail_params entry names a generated case', () => {
			// a stale entry would otherwise xfail nothing, silently
			const unmatched = [...xfails.keys()]
				.filter((key) => !matched_xfails.has(key))
				.map((key) => key.replace('\0', ': '));
			assert.deepStrictEqual(unmatched, []);
		});
		test('generated params cases exist', () => {
			assert.ok(total > 0, 'no params cases generated — schema walking may be broken');
		});
	});
};
