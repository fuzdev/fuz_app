import './assert_dev_env.ts';

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

import { test, assert, describe } from 'vitest';

import {
	assert_surface_invariants,
	assert_rpc_ws_surface_invariants,
	assert_surface_security_policy,
	type SurfaceSecurityPolicyOptions
} from './surface_invariants.ts';
import { describe_adversarial_input } from './adversarial_input.ts';
import { describe_adversarial_404 } from './adversarial_404.ts';
import { create_auth_test_apps, create_route_skip_filter, select_auth_app } from './auth_apps.ts';
import {
	resolve_valid_path,
	to_route_content_type,
	type RouteParamValues
} from './schema_generators.ts';
import {
	assert_surface_matches_snapshot,
	assert_surface_deterministic,
	assert_only_expected_public_routes,
	assert_full_middleware_stack,
	assert_error_schema_valid,
	assert_error_response_declared
} from './assertions.ts';
import { get_route_error_map } from '../http/route_errors.ts';
import type { RouteSpec } from '../http/route_spec.ts';
import type { AppSurfaceSpec } from '../http/surface.ts';
import {
	filter_protected_routes,
	filter_role_routes,
	filter_credential_gated_routes,
	format_route_key
} from '../http/surface_query.ts';
import {
	BUILTIN_CREDENTIAL_TYPES,
	CREDENTIAL_TYPE_SESSION
} from '../auth/credential_type_schema.ts';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_CREDENTIAL_TYPE_REQUIRED
} from '../http/error_schemas.ts';
// --- Adversarial test runner ---

/**
 * Build a lookup from `"METHOD /path"` to the route's own `RouteSpec` — the
 * companion of the surface spec's `route_error_maps`, so a generated request can reach
 * the route's `params` schema and synthesize path segments the route will
 * actually accept.
 */
const build_route_spec_lookup = (route_specs: Array<RouteSpec>): Map<string, RouteSpec> => {
	const lookup: Map<string, RouteSpec> = new Map();
	for (const spec of route_specs) {
		lookup.set(format_route_key(spec), spec);
	}
	return lookup;
};

/** Options for adversarial test runners (auth enforcement and input validation). */
export interface AdversarialTestOptions {
	/** Build the app surface bundle (surface + route specs + middleware specs). */
	build: () => AppSurfaceSpec;
	/** All roles in the app (e.g. `['admin', 'keeper']`). */
	roles: Array<string>;
	/**
	 * Routes to skip, in `'METHOD /path'` form (the surface key) — the escape
	 * hatch every sibling suite carries. Reach for it only when a route
	 * cannot be driven generically at all (a handler needing real seeded
	 * state, a path segment no schema can describe); a route whose params
	 * merely have a format is handled by the synthesizer.
	 */
	skip_routes?: Array<string>;
	/**
	 * Path param values for specific routes (`'METHOD /path'` → param name →
	 * value), used before the generated ones — needed for a `{re}` param whose
	 * pattern refuses the generated value. See `RouteParamValues`.
	 */
	param_values?: RouteParamValues;
}

/**
 * Generate adversarial HTTP auth enforcement test suites.
 *
 * Describe blocks:
 * - unauthenticated → 401 — every protected route
 * - wrong role → 403 — every role route the role apps' session credential
 *   reaches, tested with all non-matching roles
 * - authenticated without role → 403 — the same routes, no-role context
 * - credential-gated routes reject a disallowed credential → 403 — every
 *   route declaring `auth.credential_types`, probed on a channel it refuses
 * - correct auth passes guard — every protected route, assert not 401/403
 */
export const describe_adversarial_auth = (options: AdversarialTestOptions): void => {
	const { build, roles } = options;
	const { surface, route_specs, route_error_maps } = build();
	const is_skipped = create_route_skip_filter(options.skip_routes);
	const protected_routes = filter_protected_routes(surface).filter((r) => !is_skipped(r));

	if (protected_routes.length === 0) return;

	const role_routes = filter_role_routes(surface).filter((r) => !is_skipped(r));
	const credential_gated_routes = filter_credential_gated_routes(surface).filter(
		(r) => !is_skipped(r)
	);

	// each route's error map (derived, middleware, and handler-specific), for response validation
	const error_schema_lookup = route_error_maps;

	// The route's own spec, so a path param with a declared format (a
	// `blake3:…` fact hash, a `tok_…` id) is synthesized into a value params
	// validation accepts. Otherwise the generated request 400s on the path
	// before ever reaching the 401 / 403 gate the case is asserting.
	const spec_lookup = build_route_spec_lookup(route_specs);
	const test_path = (route: { method: string; path: string }): string => {
		const key = format_route_key(route);
		return resolve_valid_path(
			route.path,
			spec_lookup.get(key)?.params,
			options.param_values?.[key]
		);
	};

	const apps = create_auth_test_apps(route_specs, roles);
	// every probe carries the content type a real client sends, so the
	// per-route content-type check (415) never answers ahead of the auth gate
	const probe_init = (route: { method: string; raw_body?: boolean }): RequestInit => ({
		method: route.method,
		headers: { 'content-type': to_route_content_type(route) }
	});

	describe('adversarial HTTP auth enforcement', () => {
		describe('unauthenticated → 401', () => {
			for (const route of protected_routes) {
				test(format_route_key(route), async () => {
					const res = await apps.public.request(test_path(route), probe_init(route));
					assert.strictEqual(res.status, 401, format_route_key(route));
					const body = await res.json();
					assert.strictEqual(body.error, ERROR_AUTHENTICATION_REQUIRED);
					assert_error_schema_valid(error_schema_lookup, route, 401, body);
				});
			}
		});

		// Role routes the role apps can actually reach. Those apps carry a
		// session credential, so a route gated to another channel (keeper) is
		// refused by the pre-authorization credential gate before its role gate
		// ever runs — probing it here would assert `insufficient_permissions`
		// and see `credential_type_required`. A route gated *to* the session
		// channel (the audit SSE stream) stays in: its role gate is reachable,
		// and dropping it would silently retire this coverage the day a route
		// gained a session gate. Either way the credential block below probes
		// the gate itself.
		const role_only_routes = role_routes.filter(
			(r) =>
				!r.auth.credential_types?.length ||
				r.auth.credential_types.includes(CREDENTIAL_TYPE_SESSION)
		);

		if (role_only_routes.length > 0) {
			describe('wrong role → 403', () => {
				for (const route of role_only_routes) {
					const required_roles = route.auth.roles ?? [];
					const wrong_roles = roles.filter((r) => !required_roles.includes(r));
					for (const wrong_role of wrong_roles) {
						test(`${route.method} ${route.path} (${wrong_role} instead of ${required_roles.join(
							'|'
						)})`, async () => {
							const app = apps.by_role.get(wrong_role);
							if (!app) throw new Error(`No test app for role '${wrong_role}'`);
							const res = await app.request(test_path(route), probe_init(route));
							assert.strictEqual(res.status, 403, format_route_key(route));
							const body = await res.json();
							assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
							assert.deepStrictEqual(body.required_roles, required_roles);
							assert_error_schema_valid(error_schema_lookup, route, 403, body);
						});
					}
				}
			});

			describe('authenticated without role → 403', () => {
				for (const route of role_only_routes) {
					test(format_route_key(route), async () => {
						const res = await apps.authed.request(test_path(route), probe_init(route));
						assert.strictEqual(res.status, 403, format_route_key(route));
						const body = await res.json();
						assert.strictEqual(body.error, ERROR_INSUFFICIENT_PERMISSIONS);
						assert.deepStrictEqual(body.required_roles, route.auth.roles ?? []);
						assert_error_schema_valid(error_schema_lookup, route, 403, body);
					});
				}
			});
		}

		if (credential_gated_routes.length > 0) {
			describe('credential-gated routes reject a disallowed credential → 403', () => {
				// Each route is probed on the first channel its own allowlist
				// omits, in `BUILTIN_CREDENTIAL_TYPES` order: a session for keeper's
				// `daemon_token` gate, an api token for the session-only routes —
				// which is the bearer channel those gates exist to refuse. The
				// channel apps hold the keeper role, so no route's role gate can
				// be what answers; it could not be anyway, the credential gate
				// being pre-authorization.
				for (const route of credential_gated_routes) {
					const admitted = route.auth.credential_types ?? [];
					const refused = BUILTIN_CREDENTIAL_TYPES.find((t) => !admitted.includes(t));
					if (!refused) {
						// A gate listing every builtin channel refuses none of them, so
						// there is no probe to make. Reported as a skip rather than
						// dropped silently: a route that reads as gated but is not is
						// worth seeing in the run, and a `continue` here would hide
						// exactly the shape this block exists to surface.
						test.skip(`${route.method} ${route.path} (gate admits every builtin channel — nothing to refuse)`, () => {});
						continue;
					}
					test(`${route.method} ${route.path} (${refused})`, async () => {
						const res = await apps.by_credential_type
							.get(refused)!
							.request(test_path(route), probe_init(route));
						assert.strictEqual(res.status, 403, format_route_key(route));
						const body = await res.json();
						assert.strictEqual(body.error, ERROR_CREDENTIAL_TYPE_REQUIRED);
						assert.deepStrictEqual(body.required_credential_types, admitted);
						assert_error_schema_valid(error_schema_lookup, route, 403, body);
					});
				}
			});
		}

		describe('correct auth passes guard', () => {
			for (const route of protected_routes) {
				test(format_route_key(route), async () => {
					const res = await select_auth_app(apps, route.auth).request(
						test_path(route),
						probe_init(route)
					);
					// the handler runs on stub deps, so any status it answers is fine
					// but the gates' — and an error it answers must be one the route declares
					assert.notStrictEqual(res.status, 401, 'should not be 401 (auth rejected)');
					assert.notStrictEqual(res.status, 403, 'should not be 403 (role rejected)');
					assert.notStrictEqual(res.status, 415, 'should not be 415 (content type refused)');
					// only reject router-level 404 (route not registered), Hono's plain text
					if (res.status === 404) {
						const body = await res
							.clone()
							.json()
							.catch(() => null);
						assert.ok(body?.error, `route not registered: ${route.method} ${route.path}`);
					}
					const spec = spec_lookup.get(format_route_key(route))!;
					await assert_error_response_declared(
						get_route_error_map(route_error_maps, spec),
						spec.jsonrpc ?? false,
						res,
						format_route_key(route)
					);
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
	/** Expected middleware names for API routes, e.g. `['trusted_proxy', 'origin', 'session', 'request_context', 'bearer_auth']`. */
	expected_api_middleware: Array<string>;
	/** All roles in the app (e.g. `['admin', 'keeper']`). */
	roles: Array<string>;
	/** Path prefix for middleware stack assertion. Default `'/api/'`. */
	api_path_prefix?: string;
	/** Security policy configuration. Omit for sensible defaults. */
	security_policy?: SurfaceSecurityPolicyOptions;
	/**
	 * Routes the three adversarial sub-suites skip, in `'METHOD /path'` form
	 * — the escape hatch every sibling suite carries (`round_trip`,
	 * `data_exposure`). Reach for it only when a route cannot be driven
	 * generically at all; a route whose path params merely carry a format is
	 * handled by the params-schema-aware synthesizer.
	 */
	skip_routes?: Array<string>;
	/**
	 * Path param values for the three adversarial sub-suites, by route key and
	 * then param name. See `AdversarialTestOptions.param_values`.
	 */
	param_values?: RouteParamValues;
}

/**
 * Run the standard attack surface test suite.
 *
 * Test groups:
 * 1. Snapshot — live surface matches committed JSON
 * 2. Determinism — building twice yields identical results
 * 3. Public routes — bidirectional check (no unexpected, no missing)
 * 4. Middleware stack — every API route has the full middleware chain
 * 5. Surface invariants — structural assertions over `surface.routes` (error schemas, descriptions, duplicates, consistency)
 * 6. RPC/WS surface invariants — structural assertions over `surface.rpc_endpoints` + `surface.ws_endpoints` (descriptions, protocol-action spread, kind ⇔ auth)
 * 7. Security policy — rate limiting on sensitive routes, no unexpected public mutations, method conventions
 * 8. Adversarial auth — unauthenticated/wrong-role/correct-auth enforcement, every refusal a status and code of the route's own error map
 * 9. Adversarial input — input body and params validation, each 400 a code of the route's own map
 * 10. Adversarial 404 — stub 404 handlers, validate response bodies against the route's declared 404
 *
 * Consumer test files call this with project-specific options, then add
 * any project-specific assertions in additional `describe` blocks.
 */
export const describe_standard_attack_surface_tests = (
	options: StandardAttackSurfaceOptions
): void => {
	const {
		build,
		snapshot_path,
		expected_public_routes,
		expected_api_middleware,
		roles,
		api_path_prefix = '/api/',
		security_policy,
		skip_routes,
		param_values
	} = options;

	const built = build();
	const { surface } = built;

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

		test('rpc/ws surface invariants', () => {
			assert_rpc_ws_surface_invariants(surface);
		});

		test('security policy', () => {
			assert_surface_security_policy(surface, security_policy);
		});
	});

	describe_adversarial_auth({ build: () => built, roles, skip_routes, param_values });

	describe_adversarial_input({ build: () => built, roles, skip_routes, param_values });

	describe_adversarial_404({ build: () => built, roles, skip_routes, param_values });
};
