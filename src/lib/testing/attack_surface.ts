import './assert_dev_env.js';

/**
 * Adversarial auth enforcement test runners and the standard attack surface suite.
 *
 * The combinatorial test runner (`describe_adversarial_auth`) generates
 * test suites for routes x auth levels. The standard suite
 * (`describe_standard_attack_surface_tests`) composes all attack surface
 * test groups into a single call.
 *
 * Stubs, app factories, and assertion helpers live in focused submodules:
 * - `test_auth_stubs` — stub factories and pre-built dep bundles
 * - `test_auth_apps` — auth-level test app factories
 * - `test_auth_assertions` — snapshot, public route, and middleware assertions
 *
 * @module
 */

import {test, assert, describe} from 'vitest';

import {
	assert_surface_invariants,
	assert_surface_security_policy,
	audit_error_schema_tightness,
	assert_error_schema_tightness,
	type SurfaceSecurityPolicyOptions,
	type ErrorSchemaTightnessOptions,
} from './surface_invariants.js';
import {describe_adversarial_input} from './adversarial_input.js';
import {describe_adversarial_404} from './adversarial_404.js';
import {
	create_test_app_from_specs,
	create_test_request_context,
	create_auth_test_apps,
	select_auth_app,
	resolve_test_path,
} from './auth_apps.js';
import {
	assert_surface_matches_snapshot,
	assert_surface_deterministic,
	assert_only_expected_public_routes,
	assert_full_middleware_stack,
	assert_error_schema_valid,
} from './assertions.js';
import type {MiddlewareSpec} from '../http/middleware_spec.js';
import type {RouteSpec} from '../http/route_spec.js';
import {merge_error_schemas} from '../http/schema_helpers.js';
import {collect_middleware_errors, type AppSurfaceSpec} from '../http/surface.js';
import {
	filter_protected_routes,
	filter_role_routes,
	filter_keeper_routes,
} from '../http/surface_query.js';
import {
	type RouteErrorSchemas,
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_KEEPER_REQUIRES_DAEMON_TOKEN,
} from '../http/error_schemas.js';
// --- Adversarial test runner ---

/**
 * Build a lookup from `"METHOD /path"` to merged error schemas (auto-derived + middleware + explicit).
 *
 * Uses `merge_error_schemas` to ensure consistency with surface generation —
 * accounts for auth, input, params, and middleware when auto-deriving error schemas.
 */
const build_error_schema_lookup = (
	route_specs: Array<RouteSpec>,
	middleware_specs?: Array<MiddlewareSpec>,
): Map<string, RouteErrorSchemas> => {
	const lookup: Map<string, RouteErrorSchemas> = new Map();
	for (const spec of route_specs) {
		const key = `${spec.method} ${spec.path}`;
		const mw_errors = middleware_specs
			? collect_middleware_errors(middleware_specs, spec.path)
			: null;
		const merged = merge_error_schemas(spec, mw_errors);
		if (merged && Object.keys(merged).length > 0) {
			lookup.set(key, merged);
		}
	}
	return lookup;
};

/** Options for adversarial test runners (auth enforcement and input validation). */
export interface AdversarialTestOptions {
	/** Build the app surface bundle (surface + route specs + middleware specs). */
	build: () => AppSurfaceSpec;
	/** All roles in the app (e.g. `['admin', 'keeper']`). */
	roles: Array<string>;
}

/**
 * Generate adversarial HTTP auth enforcement test suites.
 *
 * Describe blocks:
 * - unauthenticated → 401 — every protected route
 * - wrong role → 403 — every role route, tested with all non-matching roles
 * - authenticated without role → 403 — every role route, no-role context
 * - correct auth passes guard — every protected route, assert not 401/403
 *
 * @param options - the test configuration
 */
export const describe_adversarial_auth = (options: AdversarialTestOptions): void => {
	const {build, roles} = options;
	const {surface, route_specs, middleware_specs} = build();
	const protected_routes = filter_protected_routes(surface);

	if (protected_routes.length === 0) return;

	const role_routes = filter_role_routes(surface);
	const keeper_routes = filter_keeper_routes(surface);

	// merged error schemas (auto-derived + middleware + handler-specific) for response validation
	const error_schema_lookup = build_error_schema_lookup(route_specs, middleware_specs);

	const apps = create_auth_test_apps(route_specs, roles);

	describe('adversarial HTTP auth enforcement', () => {
		describe('unauthenticated → 401', () => {
			for (const route of protected_routes) {
				test(`${route.method} ${route.path}`, async () => {
					const res = await apps.public.request(resolve_test_path(route.path), {
						method: route.method,
					});
					assert.strictEqual(res.status, 401, `${route.method} ${route.path}`);
					const body = await res.json();
					assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
					assert_error_schema_valid(error_schema_lookup, route, 401, body);
				});
			}
		});

		if (role_routes.length > 0) {
			describe('wrong role → 403', () => {
				for (const route of role_routes) {
					const wrong_roles = roles.filter((r) => r !== route.auth.role);
					for (const wrong_role of wrong_roles) {
						test(`${route.method} ${route.path} (${wrong_role} instead of ${route.auth.role})`, async () => {
							const app = apps.by_role.get(wrong_role);
							if (!app) throw new Error(`No test app for role '${wrong_role}'`);
							const res = await app.request(resolve_test_path(route.path), {
								method: route.method,
							});
							assert.strictEqual(res.status, 403, `${route.method} ${route.path}`);
							const body = await res.json();
							assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
							assert.strictEqual(body.required_role, route.auth.role);
							assert_error_schema_valid(error_schema_lookup, route, 403, body);
						});
					}
				}
			});

			describe('authenticated without role → 403', () => {
				for (const route of role_routes) {
					test(`${route.method} ${route.path}`, async () => {
						const res = await apps.authed.request(resolve_test_path(route.path), {
							method: route.method,
						});
						assert.strictEqual(res.status, 403, `${route.method} ${route.path}`);
						const body = await res.json();
						assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
						assert.strictEqual(body.required_role, route.auth.role);
						assert_error_schema_valid(error_schema_lookup, route, 403, body);
					});
				}
			});
		}

		if (keeper_routes.length > 0) {
			describe('keeper routes reject session credential → 403', () => {
				// keeper role via session cookie should fail (wrong credential type)
				const app_session_keeper = create_test_app_from_specs(
					route_specs,
					create_test_request_context('keeper'),
					'session',
				);
				for (const route of keeper_routes) {
					test(`${route.method} ${route.path}`, async () => {
						const res = await app_session_keeper.request(resolve_test_path(route.path), {
							method: route.method,
						});
						assert.strictEqual(res.status, 403, `${route.method} ${route.path}`);
						const body = await res.json();
						assert.strictEqual(body.error, ERROR_KEEPER_REQUIRES_DAEMON_TOKEN);
						assert_error_schema_valid(error_schema_lookup, route, 403, body);
					});
				}
			});
		}

		describe('correct auth passes guard', () => {
			for (const route of protected_routes) {
				test(`${route.method} ${route.path}`, async () => {
					const res = await select_auth_app(apps, route.auth).request(
						resolve_test_path(route.path),
						{method: route.method},
					);
					// handler may error (500) or return 404 (stub deps) — that's fine, we only verify auth passed
					assert.notStrictEqual(res.status, 401, 'should not be 401 (auth rejected)');
					assert.notStrictEqual(res.status, 403, 'should not be 403 (role rejected)');
					// handler-level 404 (resource not found with stub deps) is fine —
					// only reject router-level 404 (route not registered)
					if (res.status === 404) {
						const body = await res.json().catch(() => null);
						assert.ok(body?.error, `route not registered: ${route.method} ${route.path}`);
					}
					// SSE streams need explicit cleanup — the suspended promise keeps the event loop alive.
					// Only cancel streaming responses; regular JSON bodies don't need it.
					if (res.headers.get('Content-Type')?.includes('text/event-stream')) {
						await res.body?.cancel();
					}
				});
			}
		});
	});
};

// --- Standard attack surface test suite ---

/** Options for the standard attack surface test suite. */
export interface StandardAttackSurfaceOptions {
	/** Build the app surface bundle (surface + route specs + middleware specs). */
	build: () => AppSurfaceSpec;
	/** Absolute path to the committed snapshot JSON file. */
	snapshot_path: string;
	/** Expected public routes, e.g. `['GET /health', 'POST /api/account/login']`. */
	expected_public_routes: Array<string>;
	/** Expected middleware names for API routes, e.g. `['origin', 'session', 'request_context', 'bearer_auth']`. */
	expected_api_middleware: Array<string>;
	/** All roles in the app (e.g. `['admin', 'keeper']`). */
	roles: Array<string>;
	/** Path prefix for middleware stack assertion. Default `'/api/'`. */
	api_path_prefix?: string;
	/** Security policy configuration. Omit for sensible defaults. */
	security_policy?: SurfaceSecurityPolicyOptions;
	/** Error schema tightness assertion. Omit for informational-only behavior. */
	error_schema_tightness?: ErrorSchemaTightnessOptions;
}

/**
 * Run the standard attack surface test suite.
 *
 * Generates 10 test groups:
 * 1. Snapshot — live surface matches committed JSON
 * 2. Determinism — building twice yields identical results
 * 3. Public routes — bidirectional check (no unexpected, no missing)
 * 4. Middleware stack — every API route has the full middleware chain
 * 5. Surface invariants — structural assertions (error schemas, descriptions, duplicates, consistency)
 * 6. Security policy — rate limiting on sensitive routes, no unexpected public mutations, method conventions
 * 7. Error schema tightness audit — informational log of generic vs specific error schemas
 * 8. Adversarial auth — unauthenticated/wrong-role/correct-auth enforcement
 * 9. Adversarial input — input body and params validation
 * 10. Adversarial 404 — stub 404 handlers, validate response bodies against declared schemas
 *
 * Consumer test files call this with project-specific options, then add
 * any project-specific assertions in additional `describe` blocks.
 *
 * @param options - the test configuration
 */
export const describe_standard_attack_surface_tests = (
	options: StandardAttackSurfaceOptions,
): void => {
	const {
		build,
		snapshot_path,
		expected_public_routes,
		expected_api_middleware,
		roles,
		api_path_prefix = '/api/',
		security_policy,
		error_schema_tightness,
	} = options;

	const built = build();
	const {surface} = built;

	describe('attack surface snapshot', () => {
		test('matches committed snapshot', () => {
			assert_surface_matches_snapshot(surface, snapshot_path);
		});

		test('is deterministic', () => {
			assert_surface_deterministic(() => build().surface);
		});
	});

	describe('attack surface structure', () => {
		test('only expected public routes', () => {
			assert_only_expected_public_routes(surface, expected_public_routes);
		});

		test('full middleware stack on API routes', () => {
			assert_full_middleware_stack(surface, api_path_prefix, expected_api_middleware);
		});

		test('surface invariants', () => {
			assert_surface_invariants(surface);
		});

		test('security policy', () => {
			assert_surface_security_policy(surface, security_policy);
		});

		test('error schema tightness audit', () => {
			const entries = audit_error_schema_tightness(surface);
			const generic = entries.filter((e) => e.specificity === 'generic');
			const literal = entries.filter((e) => e.specificity === 'literal');
			const enumerated = entries.filter((e) => e.specificity === 'enum');
			console.log(
				`[error schema tightness] ${entries.length} total: ` +
					`${literal.length} literal, ${enumerated.length} enum, ${generic.length} generic`,
			);
			if (generic.length > 0) {
				console.log(
					`[error schema tightness] generic schemas:\n` +
						generic.map((e) => `  ${e.method} ${e.route_path} → ${e.status}`).join('\n'),
				);
			}
			if (error_schema_tightness) {
				assert_error_schema_tightness(surface, error_schema_tightness);
			}
		});
	});

	describe_adversarial_auth({build: () => built, roles});

	describe_adversarial_input({build: () => built, roles});

	describe_adversarial_404({build: () => built, roles});
};
