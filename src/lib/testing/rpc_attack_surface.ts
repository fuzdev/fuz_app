import './assert_dev_env.js';

/**
 * Composable RPC attack surface test suite.
 *
 * Three test groups for JSON-RPC 2.0 endpoints:
 * 1. **Auth enforcement** — per-method auth inside the dispatcher
 * 2. **Adversarial envelopes** — malformed JSON-RPC requests
 * 3. **Adversarial params** — schema-invalid params per method
 *
 * Uses the same `{build, roles}` config as `describe_adversarial_auth`
 * and `describe_adversarial_input`. No DB needed — uses stub deps.
 *
 * @module
 */

import {test, assert, describe} from 'vitest';

import type {AppSurfaceRpcEndpoint, AppSurfaceRpcMethod, AppSurfaceSpec} from '../http/surface.js';
import type {RouteAuth} from '../http/route_spec.js';
import {JSONRPC_ERROR_CODES} from '../http/jsonrpc_errors.js';
import {
	create_auth_test_apps,
	create_test_app_from_specs,
	create_test_request_context,
	select_auth_app,
} from './auth_apps.js';
import {generate_input_test_cases} from './adversarial_input.js';
import {ERROR_INVALID_JSON_BODY} from '../http/error_schemas.js';
import type {RpcAction} from '../actions/action_rpc.js';
import {
	create_rpc_post_init,
	create_rpc_get_url,
	assert_jsonrpc_error_response,
} from './rpc_helpers.js';

// --- Types ---

/** Options for `describe_rpc_attack_surface_tests`. */
export interface RpcAttackSurfaceOptions {
	/** Build the app surface bundle (surface + route specs + middleware specs + rpc_endpoints). */
	build: () => AppSurfaceSpec;
	/** All roles in the app (e.g. `['admin', 'keeper']`). */
	roles: Array<string>;
}

// --- Helpers ---

/** Filter RPC methods that require any form of authentication. */
const filter_protected_rpc_methods = (
	endpoint: AppSurfaceRpcEndpoint,
): Array<AppSurfaceRpcMethod> => endpoint.methods.filter((m) => m.auth.type !== 'none');

/** Filter RPC methods that require a specific role. */
const filter_role_rpc_methods = (
	endpoint: AppSurfaceRpcEndpoint,
): Array<AppSurfaceRpcMethod & {auth: {type: 'role'; role: string}}> =>
	endpoint.methods.filter(
		(m): m is AppSurfaceRpcMethod & {auth: {type: 'role'; role: string}} => m.auth.type === 'role',
	);

/** Filter RPC methods that require keeper auth (daemon_token + keeper role). */
const filter_keeper_rpc_methods = (
	endpoint: AppSurfaceRpcEndpoint,
): Array<AppSurfaceRpcMethod & {auth: {type: 'keeper'}}> =>
	endpoint.methods.filter(
		(m): m is AppSurfaceRpcMethod & {auth: {type: 'keeper'}} => m.auth.type === 'keeper',
	);

/** Find the `RpcAction` source spec for a surface method. */
const find_rpc_action = (
	rpc_endpoint_specs: AppSurfaceSpec['rpc_endpoints'],
	endpoint_path: string,
	method_name: string,
): RpcAction | undefined => {
	const ep = rpc_endpoint_specs.find((e) => e.path === endpoint_path);
	return ep?.actions.find((a) => a.spec.method === method_name);
};

// --- Auth enforcement ---

/**
 * Generate adversarial auth enforcement tests for RPC endpoints.
 *
 * For each endpoint, iterates methods with auth requirements and fires
 * JSON-RPC envelopes with wrong/missing credentials. Auth errors are
 * JSON-RPC format: `{jsonrpc, id, error: {code, message}}`.
 *
 * Describe blocks:
 * - unauthenticated → error code -32001 — every protected method
 * - wrong role → error code -32002 — every role method with non-matching roles
 * - authenticated without role → -32002 — every role method, no-role context
 * - keeper rejects non-daemon credentials → -32002 — session and api_token rejected
 * - correct auth passes — every protected method, assert not 401/403
 */
const describe_rpc_auth = (options: RpcAttackSurfaceOptions): void => {
	const {build, roles} = options;
	const {surface, route_specs} = build();

	if (surface.rpc_endpoints.length === 0) return;

	const apps = create_auth_test_apps(route_specs, roles);

	describe('RPC auth enforcement', () => {
		for (const endpoint of surface.rpc_endpoints) {
			const protected_methods = filter_protected_rpc_methods(endpoint);
			if (protected_methods.length === 0) continue;

			const role_methods = filter_role_rpc_methods(endpoint);

			describe(endpoint.path, () => {
				describe('unauthenticated → JSON-RPC error', () => {
					for (const method of protected_methods) {
						test(`${method.name} (${format_auth(method.auth)})`, async () => {
							const res = await apps.public.request(
								endpoint.path,
								create_rpc_post_init(method.name),
							);
							assert.strictEqual(res.status, 401, `${method.name} should return 401`);
							const body = await res.json();
							assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.unauthenticated);
						});
					}
				});

				if (role_methods.length > 0) {
					describe('wrong role → forbidden', () => {
						for (const method of role_methods) {
							const wrong_roles = roles.filter((r) => r !== method.auth.role);
							for (const wrong_role of wrong_roles) {
								test(`${method.name} (${wrong_role} instead of ${method.auth.role})`, async () => {
									const app = apps.by_role.get(wrong_role);
									if (!app) throw new Error(`No test app for role '${wrong_role}'`);
									const res = await app.request(endpoint.path, create_rpc_post_init(method.name));
									assert.strictEqual(res.status, 403, `${method.name} should return 403`);
									const body = await res.json();
									assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.forbidden);
								});
							}
						}
					});

					describe('authenticated without role → forbidden', () => {
						for (const method of role_methods) {
							test(`${method.name} (${method.auth.role})`, async () => {
								const res = await apps.authed.request(
									endpoint.path,
									create_rpc_post_init(method.name),
								);
								assert.strictEqual(res.status, 403, `${method.name} should return 403`);
								const body = await res.json();
								assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.forbidden);
							});
						}
					});
				}

				const keeper_methods = filter_keeper_rpc_methods(endpoint);
				if (keeper_methods.length > 0) {
					describe('keeper rejects non-daemon credentials', () => {
						const session_app = create_test_app_from_specs(
							route_specs,
							create_test_request_context('keeper'),
							'session',
						);
						const api_token_app = create_test_app_from_specs(
							route_specs,
							create_test_request_context('keeper'),
							'api_token',
						);

						for (const method of keeper_methods) {
							test(`${method.name} rejects session credential`, async () => {
								const res = await session_app.request(
									endpoint.path,
									create_rpc_post_init(method.name),
								);
								assert.strictEqual(
									res.status,
									403,
									`${method.name} should reject session credential`,
								);
								const body = await res.json();
								assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.forbidden);
							});

							test(`${method.name} rejects api_token credential`, async () => {
								const res = await api_token_app.request(
									endpoint.path,
									create_rpc_post_init(method.name),
								);
								assert.strictEqual(
									res.status,
									403,
									`${method.name} should reject api_token credential`,
								);
								const body = await res.json();
								assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.forbidden);
							});
						}
					});
				}

				describe('correct auth passes', () => {
					for (const method of protected_methods) {
						test(method.name, async () => {
							const app = select_auth_app(apps, method.auth);
							const res = await app.request(endpoint.path, create_rpc_post_init(method.name));
							// handler may error (500, 404 from stub deps) — that's fine
							assert.notStrictEqual(res.status, 401, 'should not be 401');
							assert.notStrictEqual(res.status, 403, 'should not be 403');
						});
					}
				});

				// also test GET for read methods with auth
				const protected_reads = protected_methods.filter((m) => !m.side_effects);
				if (protected_reads.length > 0) {
					describe('GET unauthenticated → JSON-RPC error', () => {
						for (const method of protected_reads) {
							test(`${method.name} (GET)`, async () => {
								const url = create_rpc_get_url(endpoint.path, method.name);
								const res = await apps.public.request(url);
								assert.strictEqual(res.status, 401, `GET ${method.name} should return 401`);
								const body = await res.json();
								assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.unauthenticated);
							});
						}
					});
				}
			});
		}
	});
};

// --- Adversarial envelopes ---

/**
 * Generate adversarial envelope tests for RPC endpoints.
 *
 * Fixed set of malformation cases that exercise the dispatcher's
 * envelope parsing (step 1) and method lookup (step 2).
 */
const describe_rpc_adversarial_envelopes = (options: RpcAttackSurfaceOptions): void => {
	const {build, roles} = options;
	const {surface, route_specs} = build();

	if (surface.rpc_endpoints.length === 0) return;

	// public app for envelope errors (happen before auth checks)
	const apps = create_auth_test_apps(route_specs, []);
	// authed apps for the GET mutation test (needs correct auth to reach the side_effects check)
	const authed_apps = create_auth_test_apps(route_specs, roles);

	describe('RPC adversarial envelopes', () => {
		for (const endpoint of surface.rpc_endpoints) {
			// find a mutation method for GET-restriction testing
			const mutation_method = endpoint.methods.find((m) => m.side_effects);

			describe(endpoint.path, () => {
				// --- POST envelope malformation ---

				test('non-JSON body → parse_error', async () => {
					const res = await apps.public.request(endpoint.path, {
						method: 'POST',
						headers: {'Content-Type': 'application/json'},
						body: 'not-json',
					});
					assert.strictEqual(res.status, 400);
					const body = await res.json();
					assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.parse_error);
				});

				test('wrong jsonrpc version → invalid_request', async () => {
					const res = await apps.public.request(endpoint.path, {
						method: 'POST',
						headers: {'Content-Type': 'application/json'},
						body: JSON.stringify({
							jsonrpc: '1.0',
							id: 'test',
							method: endpoint.methods[0]?.name ?? 'any',
						}),
					});
					assert.strictEqual(res.status, 400);
					const body = await res.json();
					assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.invalid_request);
				});

				test('missing jsonrpc field → invalid_request', async () => {
					const res = await apps.public.request(endpoint.path, {
						method: 'POST',
						headers: {'Content-Type': 'application/json'},
						body: JSON.stringify({
							id: 'test',
							method: endpoint.methods[0]?.name ?? 'any',
						}),
					});
					assert.strictEqual(res.status, 400);
					const body = await res.json();
					assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.invalid_request);
				});

				test('missing method field → invalid_request', async () => {
					const res = await apps.public.request(endpoint.path, {
						method: 'POST',
						headers: {'Content-Type': 'application/json'},
						body: JSON.stringify({jsonrpc: '2.0', id: 'test'}),
					});
					assert.strictEqual(res.status, 400);
					const body = await res.json();
					assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.invalid_request);
				});

				test('missing id field → invalid_request', async () => {
					const res = await apps.public.request(endpoint.path, {
						method: 'POST',
						headers: {'Content-Type': 'application/json'},
						body: JSON.stringify({
							jsonrpc: '2.0',
							method: endpoint.methods[0]?.name ?? 'any',
						}),
					});
					assert.strictEqual(res.status, 400);
					const body = await res.json();
					assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.invalid_request);
				});

				test('batch (array) body → invalid_request', async () => {
					const res = await apps.public.request(endpoint.path, {
						method: 'POST',
						headers: {'Content-Type': 'application/json'},
						body: JSON.stringify([
							{jsonrpc: '2.0', id: '1', method: endpoint.methods[0]?.name ?? 'any'},
						]),
					});
					assert.strictEqual(res.status, 400);
					const body = await res.json();
					assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.invalid_request);
					assert.strictEqual(body.id, null, 'batch has no extractable id');
				});

				test('unknown method name → method_not_found', async () => {
					const res = await apps.public.request(
						endpoint.path,
						create_rpc_post_init('__nonexistent_method__'),
					);
					assert.strictEqual(res.status, 404);
					const body = await res.json();
					assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.method_not_found);
				});

				// --- GET envelope malformation ---

				test('GET missing method → invalid_request', async () => {
					const res = await apps.public.request(`${endpoint.path}?id=test`);
					assert.strictEqual(res.status, 400);
					const body = await res.json();
					assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.invalid_request);
				});

				test('GET missing id → invalid_request', async () => {
					const first_method = endpoint.methods[0]?.name ?? 'any';
					const res = await apps.public.request(`${endpoint.path}?method=${first_method}`);
					assert.strictEqual(res.status, 400);
					const body = await res.json();
					assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.invalid_request);
				});

				test('GET invalid JSON params → invalid_params', async () => {
					const read_method = endpoint.methods.find((m) => !m.side_effects);
					// skip if no read methods exist
					if (!read_method) return;
					const res = await apps.public.request(
						`${endpoint.path}?method=${read_method.name}&id=test&params=not-json`,
					);
					assert.strictEqual(res.status, 400);
					const body = await res.json();
					assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.invalid_params);
				});

				test('GET non-object params → error', async () => {
					const read_method = endpoint.methods.find((m) => !m.side_effects);
					// skip if no read methods exist
					if (!read_method) return;
					// valid JSON but not an object — hits dispatcher's params validation
					const res = await apps.public.request(
						`${endpoint.path}?method=${read_method.name}&id=test&params=42`,
					);
					// should reject: either invalid_params (step 4) or auth error (step 3)
					assert.ok(
						res.status >= 400,
						`expected error status for non-object params, got ${res.status}`,
					);
					const body = await res.json();
					assert_jsonrpc_error_response(body);
				});

				if (mutation_method) {
					test('GET mutation method → invalid_request (side effects)', async () => {
						const url = create_rpc_get_url(endpoint.path, mutation_method.name);
						// need correct auth to reach the side_effects check
						const app = select_auth_app(authed_apps, mutation_method.auth);
						const res = await app.request(url);
						assert.strictEqual(res.status, 400);
						const body = await res.json();
						assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.invalid_request);
					});
				}
			});
		}
	});
};

// --- Adversarial params ---

/**
 * Generate adversarial params validation tests for RPC endpoints.
 *
 * For each method with a non-null input schema, generates test cases
 * from the schema (wrong types, missing fields, format violations)
 * and wraps them in valid JSON-RPC envelopes. Reuses
 * `generate_input_test_cases` from `testing/adversarial_input.ts`.
 */
const describe_rpc_adversarial_params = (options: RpcAttackSurfaceOptions): void => {
	const {build, roles} = options;
	const {surface, route_specs, rpc_endpoints: rpc_endpoint_specs} = build();

	if (surface.rpc_endpoints.length === 0) return;

	const apps = create_auth_test_apps(route_specs, roles);
	let total_cases = 0;

	describe('RPC adversarial params', () => {
		for (const endpoint of surface.rpc_endpoints) {
			const methods_with_input = endpoint.methods.filter((m) => m.input_schema !== null);
			if (methods_with_input.length === 0) continue;

			describe(endpoint.path, () => {
				for (const method of methods_with_input) {
					// look up the source RpcAction for the Zod schema
					const action = find_rpc_action(rpc_endpoint_specs, endpoint.path, method.name);
					if (!action) {
						test(`${method.name} — missing RpcAction source spec`, () => {
							assert.fail(
								`surface has method '${method.name}' but no matching RpcAction in rpc_endpoints`,
							);
						});
						continue;
					}

					// filter out structural cases (non-object body) — those fail at
					// envelope validation (invalid_request) not params validation (invalid_params).
					// Envelope-level structural errors are covered by adversarial envelopes.
					const test_cases = generate_input_test_cases(action.spec.input).filter(
						(tc) => tc.expected_error !== ERROR_INVALID_JSON_BODY,
					);
					if (test_cases.length === 0) continue;
					total_cases += test_cases.length;

					const app = select_auth_app(apps, method.auth);

					describe(method.name, () => {
						for (const tc of test_cases) {
							test(tc.label, async () => {
								const res = await app.request(
									endpoint.path,
									create_rpc_post_init(method.name, tc.body),
								);
								assert.strictEqual(
									res.status,
									400,
									`Expected 400 for ${method.name} [${tc.label}], got ${res.status}`,
								);
								const body = await res.json();
								assert_jsonrpc_error_response(body, JSONRPC_ERROR_CODES.invalid_params);
							});
						}
					});
				}
			});
		}

		test('generated RPC params test cases', () => {
			// soft check — methods with only null-input schemas produce 0 cases
			if (surface.rpc_endpoints.some((ep) => ep.methods.some((m) => m.input_schema !== null))) {
				assert.ok(
					total_cases > 0,
					'No RPC params test cases generated — schema walking may be broken',
				);
			}
		});
	});
};

// --- Helpers (formatting) ---

/** Format a `RouteAuth` as a human-readable label. */
const format_auth = (auth: RouteAuth): string => {
	switch (auth.type) {
		case 'none':
			return 'public';
		case 'authenticated':
			return 'authenticated';
		case 'role':
			return `role: ${auth.role}`;
		case 'keeper':
			return 'keeper';
	}
};

// --- Public API ---

/**
 * Run the standard RPC attack surface test suite.
 *
 * Generates 3 test groups:
 * 1. Auth enforcement — per-method auth checks via JSON-RPC envelopes
 * 2. Adversarial envelopes — malformed JSON-RPC requests
 * 3. Adversarial params — schema-invalid params per method
 *
 * Skips silently when `surface.rpc_endpoints` is empty.
 *
 * @param options - the test configuration
 */
export const describe_rpc_attack_surface_tests = (options: RpcAttackSurfaceOptions): void => {
	const {surface} = options.build();
	if (surface.rpc_endpoints.length === 0) return;

	describe_rpc_auth(options);
	describe_rpc_adversarial_envelopes(options);
	describe_rpc_adversarial_params(options);
};
