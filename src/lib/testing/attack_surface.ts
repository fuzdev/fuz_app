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
	audit_error_schema_tightness,
	assert_error_schema_tightness,
	default_error_schema_tightness,
	fuz_app_stock_route_tightness_allowlist,
	type SurfaceSecurityPolicyOptions,
	type ErrorSchemaTightnessOptions
} from './surface_invariants.ts';
import { describe_adversarial_input } from './adversarial_input.ts';
import { describe_adversarial_404 } from './adversarial_404.ts';
import { create_auth_test_apps, create_route_skip_filter, select_auth_app } from './auth_apps.ts';
import { resolve_valid_path } from './schema_generators.ts';
import {
	assert_surface_matches_snapshot,
	assert_surface_deterministic,
	assert_only_expected_public_routes,
	assert_full_middleware_stack,
	assert_error_schema_valid
} from './assertions.ts';
import type { MiddlewareSpec } from '../http/middleware_spec.ts';
import type { RouteSpec } from '../http/route_spec.ts';
import { merge_error_schemas } from '../http/schema_helpers.ts';
import { collect_middleware_errors, type AppSurfaceSpec } from '../http/surface.ts';
import {
	filter_protected_routes,
	filter_role_routes,
	filter_credential_gated_routes
} from '../http/surface_query.ts';
import { CREDENTIAL_TYPES } from '../hono_context.ts';
import { CREDENTIAL_TYPE_SESSION } from '../auth/credential_type_schema.ts';
import {
	type RouteErrorSchemas,
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_CREDENTIAL_TYPE_REQUIRED
} from '../http/error_schemas.ts';
// --- Adversarial test runner ---

/**
 * Build a lookup from `"METHOD /path"` to merged error schemas (auto-derived + middleware + explicit).
 *
 * Uses `merge_error_schemas` to ensure consistency with surface generation —
 * accounts for auth, input, params, and middleware when auto-deriving error schemas.
 */
const build_error_schema_lookup = (
	route_specs: Array<RouteSpec>,
	middleware_specs?: Array<MiddlewareSpec>
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

/**
 * Build a lookup from `"METHOD /path"` to the route's own `RouteSpec` — the
 * companion of `build_error_schema_lookup`, so a generated request can reach
 * the route's `params` schema and synthesize path segments the route will
 * actually accept.
 */
const build_route_spec_lookup = (route_specs: Array<RouteSpec>): Map<string, RouteSpec> => {
	const lookup: Map<string, RouteSpec> = new Map();
	for (const spec of route_specs) {
		lookup.set(`${spec.method} ${spec.path}`, spec);
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
	const { surface, route_specs, middleware_specs } = build();
	const is_skipped = create_route_skip_filter(options.skip_routes);
	const protected_routes = filter_protected_routes(surface).filter((r) => !is_skipped(r));

	if (protected_routes.length === 0) return;

	const role_routes = filter_role_routes(surface).filter((r) => !is_skipped(r));
	const credential_gated_routes = filter_credential_gated_routes(surface).filter(
		(r) => !is_skipped(r)
	);

	// merged error schemas (auto-derived + middleware + handler-specific) for response validation
	const error_schema_lookup = build_error_schema_lookup(route_specs, middleware_specs);

	// The route's own spec, so a path param with a declared format (a
	// `blake3:…` fact hash, a `tok_…` id) is synthesized into a value params
	// validation accepts. Otherwise the generated request 400s on the path
	// before ever reaching the 401 / 403 gate the case is asserting.
	const spec_lookup = build_route_spec_lookup(route_specs);
	const test_path = (route: { method: string; path: string }): string =>
		resolve_valid_path(route.path, spec_lookup.get(`${route.method} ${route.path}`)?.params);

	const apps = create_auth_test_apps(route_specs, roles);

	describe('adversarial HTTP auth enforcement', () => {
		describe('unauthenticated → 401', () => {
			for (const route of protected_routes) {
				test(`${route.method} ${route.path}`, async () => {
					const res = await apps.public.request(test_path(route), {
						method: route.method
					});
					assert.strictEqual(res.status, 401, `${route.method} ${route.path}`);
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
							const res = await app.request(test_path(route), {
								method: route.method
							});
							assert.strictEqual(res.status, 403, `${route.method} ${route.path}`);
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
					test(`${route.method} ${route.path}`, async () => {
						const res = await apps.authed.request(test_path(route), {
							method: route.method
						});
						assert.strictEqual(res.status, 403, `${route.method} ${route.path}`);
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
				// omits, in `CREDENTIAL_TYPES` order: a session for keeper's
				// `daemon_token` gate, an api token for the session-only routes —
				// which is the bearer channel those gates exist to refuse. The
				// channel apps hold the keeper role, so no route's role gate can
				// be what answers; it could not be anyway, the credential gate
				// being pre-authorization.
				for (const route of credential_gated_routes) {
					const admitted = route.auth.credential_types ?? [];
					const refused = CREDENTIAL_TYPES.find((t) => !admitted.includes(t));
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
						const res = await apps.by_credential_type.get(refused)!.request(test_path(route), {
							method: route.method
						});
						assert.strictEqual(res.status, 403, `${route.method} ${route.path}`);
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
				test(`${route.method} ${route.path}`, async () => {
					const res = await select_auth_app(apps, route.auth).request(test_path(route), {
						method: route.method
					});
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

/**
 * Merge a consumer's `error_schema_tightness` option with
 * `default_error_schema_tightness` so `allowlist` and `ignore_statuses` are
 * additive rather than replacing.
 *
 * - `undefined` → return the default as-is.
 * - `null` → return `null` (opt out of the assertion).
 * - object → spread the default, then consumer overrides for scalar fields
 *   (`min_specificity`), then concat stock-then-consumer for the list fields
 *   (`allowlist`, `ignore_statuses`) so consumer entries extend rather than
 *   replace.
 *
 * Exported for direct use when a consumer calls `assert_error_schema_tightness`
 * outside the standard suite but still wants the additive merge.
 */
export const resolve_standard_error_schema_tightness = (
	consumer: ErrorSchemaTightnessOptions | null | undefined
): ErrorSchemaTightnessOptions | null => {
	if (consumer === null) return null;
	return {
		...default_error_schema_tightness,
		...consumer,
		allowlist: [...fuz_app_stock_route_tightness_allowlist, ...(consumer?.allowlist ?? [])],
		ignore_statuses: [
			...(default_error_schema_tightness.ignore_statuses ?? []),
			...(consumer?.ignore_statuses ?? [])
		]
	};
};

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
	/**
	 * Error schema tightness assertion config. Defaults to
	 * `default_error_schema_tightness` (ignores 401/403/429,
	 * `min_specificity: 'enum'`, allowlist seeded with
	 * `fuz_app_stock_route_tightness_allowlist`).
	 *
	 * Consumer-supplied `allowlist` and `ignore_statuses` are **additive** —
	 * the suite merges them underneath the stock defaults, so project-specific
	 * entries don't need to re-list fuz_app's own stock routes. Pass a narrower
	 * config to extend either list or tighten `min_specificity`; pass `null`
	 * to skip the assertion and keep the audit log informational-only.
	 */
	error_schema_tightness?: ErrorSchemaTightnessOptions | null;
	/**
	 * Routes the three adversarial sub-suites skip, in `'METHOD /path'` form
	 * — the escape hatch every sibling suite carries (`round_trip`,
	 * `data_exposure`). Reach for it only when a route cannot be driven
	 * generically at all; a route whose path params merely carry a format is
	 * handled by the params-schema-aware synthesizer.
	 */
	skip_routes?: Array<string>;
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
 * 8. Error schema tightness — informational log of generic vs specific error schemas, plus assertion against `default_error_schema_tightness` by default (opt out with `error_schema_tightness: null`)
 * 9. Adversarial auth — unauthenticated/wrong-role/correct-auth enforcement
 * 10. Adversarial input — input body and params validation
 * 11. Adversarial 404 — stub 404 handlers, validate response bodies against declared schemas
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
		skip_routes
	} = options;

	const error_schema_tightness = resolve_standard_error_schema_tightness(
		options.error_schema_tightness
	);

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

		test('error schema tightness', () => {
			const entries = audit_error_schema_tightness(surface);
			const generic = entries.filter((e) => e.specificity === 'generic');
			const literal = entries.filter((e) => e.specificity === 'literal');
			const enumerated = entries.filter((e) => e.specificity === 'enum');
			console.log(
				`[error schema tightness] ${entries.length} total: ` +
					`${literal.length} literal, ${enumerated.length} enum, ${generic.length} generic`
			);
			if (generic.length > 0) {
				console.log(
					`[error schema tightness] generic schemas:\n` +
						generic.map((e) => `  ${e.method} ${e.route_path} → ${e.status}`).join('\n')
				);
			}
			if (error_schema_tightness) {
				assert_error_schema_tightness(surface, error_schema_tightness);
			}
		});
	});

	describe_adversarial_auth({ build: () => built, roles, skip_routes });

	describe_adversarial_input({ build: () => built, roles, skip_routes });

	describe_adversarial_404({ build: () => built, roles, skip_routes });
};
