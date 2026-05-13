import './assert_dev_env.js';

/**
 * Surface invariant assertions for `AppSurface` data.
 *
 * Two categories:
 * - **Structural** — validate internal consistency (error schema presence,
 *   descriptions, duplicates, middleware propagation, error schema validity,
 *   error code consistency). No options needed.
 * - **Policy** — enforce security policy (sensitive routes rate-limited,
 *   no public mutations, mutation method conventions). Configurable with
 *   sensible defaults.
 *
 * Structural invariants catch schema/surface generation bugs. Policy invariants
 * catch security misconfigurations. Both propagate automatically to consumers
 * via `assert_surface_invariants`.
 *
 * @module
 */

import {assert} from 'vitest';

import {middleware_applies} from '../http/schema_helpers.js';
import type {AppSurface, AppSurfaceMiddleware} from '../http/surface.js';
import {
	filter_protected_routes,
	filter_role_routes,
	filter_keeper_routes,
	filter_routes_with_input,
	filter_routes_with_params,
	filter_routes_with_query,
	filter_public_routes,
	format_route_key,
} from '../http/surface_query.js';

// --- Structural invariants ---

/**
 * Every protected route has 401 in `error_schemas`.
 */
export const assert_protected_routes_declare_401 = (surface: AppSurface): void => {
	const routes = filter_protected_routes(surface);
	for (const route of routes) {
		assert.ok(
			route.error_schemas && '401' in route.error_schemas,
			`${format_route_key(route)} is protected but missing 401 error schema`,
		);
	}
};

/**
 * Every role/keeper route has 403 in `error_schemas`.
 */
export const assert_role_routes_declare_403 = (surface: AppSurface): void => {
	const role_routes = filter_role_routes(surface);
	const keeper_routes = filter_keeper_routes(surface);
	for (const route of [...role_routes, ...keeper_routes]) {
		assert.ok(
			route.error_schemas && '403' in route.error_schemas,
			`${format_route_key(route)} requires role/keeper but missing 403 error schema`,
		);
	}
};

/**
 * Every route with non-null `input_schema` has 400 in `error_schemas`.
 */
export const assert_input_routes_declare_400 = (surface: AppSurface): void => {
	const routes = filter_routes_with_input(surface);
	for (const route of routes) {
		assert.ok(
			route.error_schemas && '400' in route.error_schemas,
			`${format_route_key(route)} has input but missing 400 error schema`,
		);
	}
};

/**
 * Every route with non-null `params_schema` has 400 in `error_schemas`.
 */
export const assert_params_routes_declare_400 = (surface: AppSurface): void => {
	const routes = filter_routes_with_params(surface);
	for (const route of routes) {
		assert.ok(
			route.error_schemas && '400' in route.error_schemas,
			`${format_route_key(route)} has params but missing 400 error schema`,
		);
	}
};

/**
 * Every route with non-null `query_schema` has 400 in `error_schemas`.
 */
export const assert_query_routes_declare_400 = (surface: AppSurface): void => {
	const routes = filter_routes_with_query(surface);
	for (const route of routes) {
		assert.ok(
			route.error_schemas && '400' in route.error_schemas,
			`${format_route_key(route)} has query schema but missing 400 error schema`,
		);
	}
};

/**
 * Every route has a non-empty description.
 */
export const assert_descriptions_present = (surface: AppSurface): void => {
	for (const route of surface.routes) {
		assert.ok(route.description.length > 0, `${format_route_key(route)} has empty description`);
	}
};

/**
 * No duplicate method+path pairs.
 */
export const assert_no_duplicate_routes = (surface: AppSurface): void => {
	const seen: Set<string> = new Set();
	for (const route of surface.routes) {
		const key = format_route_key(route);
		assert.ok(!seen.has(key), `Duplicate route: ${key}`);
		seen.add(key);
	}
};

/**
 * Every applicable middleware that declares errors must have those status codes
 * present in the route's `error_schemas`.
 */
export const assert_middleware_errors_propagated = (surface: AppSurface): void => {
	const middleware_with_errors: Array<AppSurfaceMiddleware> = surface.middleware.filter(
		(m) => m.error_schemas !== null,
	);
	for (const route of surface.routes) {
		for (const mw of middleware_with_errors) {
			if (!middleware_applies(mw.path, route.path)) continue;
			for (const status of Object.keys(mw.error_schemas!)) {
				assert.ok(
					route.error_schemas && status in route.error_schemas,
					`${format_route_key(route)} missing status ${status} from middleware '${mw.name}'`,
				);
			}
		}
	}
};

/**
 * Every route's declared error schemas must have an `error` field at the top level
 * (conforming to the `ApiError` base shape `{error: string}`).
 *
 * Walks union branches (`anyOf` from `z.union`, `oneOf` from
 * `z.discriminatedUnion`) so every emit shape inside a merged 400 / 404
 * is checked, not just the top-level wrapper.
 *
 * Catches typos in error schema definitions and ensures consumers can always
 * read `.error` from error responses.
 */
export const assert_error_schemas_structurally_valid = (surface: AppSurface): void => {
	for (const route of surface.routes) {
		if (!route.error_schemas) continue;
		for (const [status, schema] of Object.entries(route.error_schemas)) {
			assert_branch_has_error_property(schema, format_route_key(route), status);
		}
	}
};

const assert_branch_has_error_property = (
	schema: unknown,
	route_key: string,
	status: string,
): void => {
	const branches = get_union_branches(schema);
	if (branches) {
		for (const branch of branches) {
			assert_branch_has_error_property(branch, route_key, status);
		}
		return;
	}
	if (typeof schema !== 'object' || schema === null) return;
	const s = schema as Record<string, unknown>;
	if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
		const props = s.properties as Record<string, unknown>;
		assert.ok(
			'error' in props,
			`${route_key} error schema for status ${status} missing 'error' property`,
		);
	}
};

/**
 * The same `z.literal()` error code should not appear at different HTTP status codes
 * across routes.
 *
 * Extracts `const` values from error schema `error` properties (which correspond to
 * `z.literal()` in the Zod source). Walks union branches (`anyOf` from `z.union`,
 * `oneOf` from `z.discriminatedUnion`) so literal codes nested inside merged unions
 * (e.g. validation 400 + actor-resolution 400) are still tracked. Flags when the
 * same literal appears at different status codes — e.g., `ERROR_INVALID_CREDENTIALS`
 * at both 401 and 403 would be a bug.
 *
 * Only checks `const` values (literal schemas). Generic `z.string()` schemas
 * (which produce `{type: 'string'}`) and `z.enum()` schemas are ignored — the
 * literal-only narrow keeps the check unambiguous.
 */
export const assert_error_code_status_consistency = (surface: AppSurface): void => {
	// Map from error code literal → Set of status codes where it appears
	const code_to_statuses: Map<string, Set<string>> = new Map();

	const record = (status: string, schema: unknown): void => {
		for (const code of extract_error_consts(schema)) {
			let statuses = code_to_statuses.get(code);
			if (!statuses) {
				statuses = new Set();
				code_to_statuses.set(code, statuses);
			}
			statuses.add(status);
		}
	};

	for (const route of surface.routes) {
		if (!route.error_schemas) continue;
		for (const [status, schema] of Object.entries(route.error_schemas)) {
			record(status, schema);
		}
	}

	// Also check middleware error schemas
	for (const mw of surface.middleware) {
		if (!mw.error_schemas) continue;
		for (const [status, schema] of Object.entries(mw.error_schemas)) {
			record(status, schema);
		}
	}

	for (const [code, statuses] of code_to_statuses) {
		assert.ok(
			statuses.size === 1,
			`Error code '${code}' appears at multiple status codes: ${[...statuses].sort().join(', ')}`,
		);
	}
};

/**
 * Extract the `error` property's JSON Schema from a route error schema.
 *
 * Navigates `schema.properties.error` — the common structure for all
 * `ApiError`-shaped schemas. Returns `null` if the schema doesn't conform.
 */
const get_error_property = (schema: unknown): Record<string, unknown> | null => {
	if (typeof schema !== 'object' || schema === null) return null;
	const s = schema as Record<string, unknown>;
	if (s.type !== 'object' || !s.properties || typeof s.properties !== 'object') return null;
	const props = s.properties as Record<string, unknown>;
	if (!props.error || typeof props.error !== 'object') return null;
	return props.error as Record<string, unknown>;
};

/**
 * Read the branch array off a JSON Schema union, if present.
 *
 * Zod 4 emits `anyOf` for `z.union(...)` and `oneOf` for
 * `z.discriminatedUnion(...)` via `z.toJSONSchema`; both are union-shaped
 * for tightness/code-extraction purposes. Nested unions are NOT flattened
 * by `toJSONSchema`, so every caller must recurse through the returned
 * branches. Returns the branch array or `null` for non-union schemas.
 */
const get_union_branches = (schema: unknown): Array<unknown> | null => {
	if (typeof schema !== 'object' || schema === null) return null;
	const s = schema as Record<string, unknown>;
	if (Array.isArray(s.anyOf)) return s.anyOf;
	if (Array.isArray(s.oneOf)) return s.oneOf;
	return null;
};

/**
 * Extract every `const` value from a JSON Schema error property, walking
 * union branches.
 *
 * Looks for `schema.properties.error.const` — the JSON Schema representation
 * of `z.literal('some_error_code')` — and recurses into `anyOf` / `oneOf`
 * branches so literals nested inside `z.union` or `z.discriminatedUnion`
 * are still tracked. Returns an empty array for schemas with no literal
 * codes (`z.enum`, `z.string`, non-object schemas).
 */
const extract_error_consts = (schema: unknown): Array<string> => {
	const branches = get_union_branches(schema);
	if (branches) {
		const codes: Array<string> = [];
		for (const branch of branches) {
			codes.push(...extract_error_consts(branch));
		}
		return codes;
	}
	const error_prop = get_error_property(schema);
	if (!error_prop) return [];
	if (typeof error_prop.const === 'string') return [error_prop.const];
	return [];
};

/**
 * Check if a JSON Schema error property uses specific error codes (`const` or `enum`),
 * not just generic `z.string()` (`{type: 'string'}`).
 *
 * Returns `true` for `z.literal()` (`{const: '...'}`) and `z.enum()` (`{enum: [...]}`),
 * and for union schemas where every branch is specific. Defers to
 * `classify_error_specificity` so the union walk stays in one place.
 */
const has_specific_error_schema = (schema: unknown): boolean =>
	classify_error_specificity(schema) !== 'generic';

/**
 * Routes declaring 404 error schemas should use specific `z.literal()` or `z.enum()`
 * error codes, not generic `z.string()`.
 *
 * A generic 404 schema (`ApiError` with `z.string()`) means the error code is
 * unconstrained — the handler could return any string, making client error handling
 * fragile. Routes with params (`:id`) are the primary 404 producers; their error
 * schemas should use specific constants like `ERROR_ACCOUNT_NOT_FOUND`.
 *
 * Only flags routes that have `params_schema` (param-driven resource lookup) — routes
 * declaring 404 for other reasons (e.g., bootstrap not configured) may legitimately
 * use generic schemas.
 */
export const assert_404_schemas_use_specific_errors = (surface: AppSurface): void => {
	for (const route of surface.routes) {
		if (!route.error_schemas || !('404' in route.error_schemas)) continue;
		if (route.params_schema === null) continue;
		assert.ok(
			has_specific_error_schema(route.error_schemas['404']),
			`${format_route_key(route)} declares 404 with params but uses generic error schema — ` +
				`use a specific z.literal() or z.enum() error code`,
		);
	}
};

// --- Audit tools ---

/** Specificity level of an error schema's `error` field. */
export type ErrorSchemaSpecificity = 'literal' | 'enum' | 'generic';

/** A single entry in the error schema tightness audit report. */
export interface ErrorSchemaAuditEntry {
	method: string;
	route_path: string;
	status: string;
	specificity: ErrorSchemaSpecificity;
	/** The literal value or enum values, if specific. */
	error_codes: Array<string> | null;
}

/**
 * Classify the specificity of a JSON Schema error property.
 *
 * - `'literal'` — `z.literal()` (`{const: '...'}`)
 * - `'enum'` — `z.enum()` (`{enum: [...]}`)
 * - `'generic'` — `z.string()` or unrecognized
 *
 * Walks union branches (`anyOf` from `z.union`, `oneOf` from
 * `z.discriminatedUnion`) — `derive_error_schemas` emits `anyOf` when it
 * merges multiple shapes at one status (e.g. validation 400 +
 * actor-resolution 400), and a consumer that explicitly declares a
 * discriminated-union error schema emits `oneOf`. Reports the **minimum**
 * specificity across branches — a union's contract is only as tight as
 * its loosest member.
 */
const classify_error_specificity = (schema: unknown): ErrorSchemaSpecificity => {
	const branches = get_union_branches(schema);
	if (branches) {
		if (branches.length === 0) return 'generic';
		let min: ErrorSchemaSpecificity = 'literal';
		for (const branch of branches) {
			const branch_specificity = classify_error_specificity(branch);
			if (SPECIFICITY_ORDER[branch_specificity] < SPECIFICITY_ORDER[min]) {
				min = branch_specificity;
			}
		}
		return min;
	}
	const error_prop = get_error_property(schema);
	if (!error_prop) return 'generic';
	if (typeof error_prop.const === 'string') return 'literal';
	if (Array.isArray(error_prop.enum)) return 'enum';
	return 'generic';
};

/**
 * Extract error code values from a JSON Schema error property.
 *
 * Returns the literal value or enum array, or `null` for generic schemas.
 *
 * For union schemas (`anyOf` / `oneOf`), collects codes from every branch
 * (deduped). If any branch is generic, returns `null` because the union
 * admits arbitrary strings on that branch.
 */
const extract_error_codes = (schema: unknown): Array<string> | null => {
	const branches = get_union_branches(schema);
	if (branches) {
		const codes = new Set<string>();
		for (const branch of branches) {
			const branch_codes = extract_error_codes(branch);
			if (branch_codes === null) return null;
			for (const code of branch_codes) codes.add(code);
		}
		return [...codes];
	}
	const error_prop = get_error_property(schema);
	if (!error_prop) return null;
	if (typeof error_prop.const === 'string') return [error_prop.const];
	if (Array.isArray(error_prop.enum))
		return error_prop.enum.filter((v): v is string => typeof v === 'string');
	return null;
};

/**
 * Audit error schema tightness across all routes in a surface.
 *
 * Reports which route x status code combinations use generic `ApiError`
 * (`z.string()`) vs specific `z.literal()` or `z.enum()` error codes.
 * Use the output to prioritize progressive tightening of error schemas.
 *
 * @returns audit entries for every route x status combination
 */
export const audit_error_schema_tightness = (surface: AppSurface): Array<ErrorSchemaAuditEntry> => {
	const entries: Array<ErrorSchemaAuditEntry> = [];
	for (const route of surface.routes) {
		if (!route.error_schemas) continue;
		for (const [status, schema] of Object.entries(route.error_schemas)) {
			const specificity = classify_error_specificity(schema);
			entries.push({
				method: route.method,
				route_path: route.path,
				status,
				specificity,
				error_codes: extract_error_codes(schema),
			});
		}
	}
	return entries;
};

// --- Policy invariants ---

/**
 * Configuration for security policy invariants.
 *
 * All fields have sensible defaults. Pass overrides for project-specific needs.
 */
export interface SurfaceSecurityPolicyOptions {
	/**
	 * Path patterns for routes that should be rate-limited.
	 * Default: common sensitive REST patterns (login, password, bootstrap).
	 * `account_token_create` lives on the RPC surface; per-method RPC rate
	 * limiting is a separate invariant if consumers want it.
	 */
	sensitive_route_patterns?: Array<string | RegExp>;
	/**
	 * Routes explicitly allowed to be public mutations (e.g., webhooks, bootstrap).
	 * Format: `'METHOD /path'` (e.g., `'POST /api/account/login'`).
	 */
	public_mutation_allowlist?: Array<string>;
	/**
	 * Allowed path prefixes for keeper-protected routes.
	 * Default: `['/api/']`. Catches keeper routes outside expected namespaces.
	 */
	keeper_route_prefixes?: Array<string>;
}

/** Default patterns for sensitive REST routes that should be rate-limited. */
const DEFAULT_SENSITIVE_PATTERNS: Array<string | RegExp> = [
	/\/login$/,
	/\/password$/,
	/\/bootstrap$/,
];

/**
 * Sensitive routes must declare rate limiting (`rate_limit_key` is non-null)
 * or have 429 in their error schemas.
 *
 * Matches routes against sensitive patterns and flags any that lack rate limit
 * declarations. Catches forgotten rate limiting on credential-handling routes.
 */
export const assert_sensitive_routes_rate_limited = (
	surface: AppSurface,
	sensitive_patterns: Array<string | RegExp> = DEFAULT_SENSITIVE_PATTERNS,
): void => {
	for (const route of surface.routes) {
		const matches = sensitive_patterns.some((pattern) =>
			typeof pattern === 'string' ? route.path.includes(pattern) : pattern.test(route.path),
		);
		if (!matches) continue;
		const has_rate_limit =
			route.rate_limit_key !== null ||
			(route.error_schemas !== null && '429' in route.error_schemas);
		assert.ok(
			has_rate_limit,
			`${format_route_key(route)} matches a sensitive pattern but has no rate limiting declared`,
		);
	}
};

/**
 * Public mutation routes (auth: none + is_mutation) must be in the allowlist.
 *
 * Catches accidentally unprotected POST/PUT/DELETE routes. Routes like login
 * and bootstrap are public mutations by design — they go in the allowlist.
 */
export const assert_no_unexpected_public_mutations = (
	surface: AppSurface,
	allowlist: Array<string> = [],
): void => {
	const public_routes = filter_public_routes(surface);
	const mutations = public_routes.filter((r) => r.is_mutation);
	const allowset = new Set(allowlist);
	for (const route of mutations) {
		const key = format_route_key(route);
		assert.ok(
			allowset.has(key),
			`${key} is a public mutation route not in the allowlist. ` +
				`Add it to public_mutation_allowlist if intentional.`,
		);
	}
};

/**
 * Routes with non-null input schemas should use POST (or other mutation methods),
 * not GET.
 *
 * GET routes with request bodies are technically allowed by HTTP but semantically
 * suspicious — they bypass browser security assumptions about GET being idempotent.
 * Query-string-driven filtering (audit log, list endpoints) should use params schemas
 * or query string parsing, not input schemas.
 *
 * Note: RPC endpoints (`create_rpc_endpoint`) use `input: z.null()` on their
 * route specs — the dispatcher handles body/query parsing internally. Real input
 * schemas live in `rpc_endpoints` surface, not on routes.
 */
export const assert_mutation_routes_use_post = (surface: AppSurface): void => {
	const input_routes = filter_routes_with_input(surface);
	for (const route of input_routes) {
		assert.ok(
			route.method !== 'GET',
			`${format_route_key(route)} has input schema on GET route — use POST or move to params/query`,
		);
	}
};

/** Default allowed prefixes for keeper routes. */
const DEFAULT_KEEPER_ROUTE_PREFIXES: Array<string> = ['/api/'];

/**
 * Keeper-protected routes must be under expected path prefixes.
 *
 * Catches keeper routes accidentally placed outside the API namespace
 * (e.g., a keeper route at `/health` or `/admin/` instead of `/api/...`).
 */
export const assert_keeper_routes_under_prefix = (
	surface: AppSurface,
	prefixes: Array<string> = DEFAULT_KEEPER_ROUTE_PREFIXES,
): void => {
	const keeper_routes = filter_keeper_routes(surface);
	for (const route of keeper_routes) {
		const under_prefix = prefixes.some((prefix) => route.path.startsWith(prefix));
		assert.ok(
			under_prefix,
			`${format_route_key(route)} is keeper-protected but not under any expected prefix: ${prefixes.join(', ')}`,
		);
	}
};

// --- Error schema tightness assertion ---

/** Numeric specificity ranking for threshold comparisons. */
const SPECIFICITY_ORDER: Record<ErrorSchemaSpecificity, number> = {
	literal: 2,
	enum: 1,
	generic: 0,
};

/** Options for `assert_error_schema_tightness`. */
export interface ErrorSchemaTightnessOptions {
	/** Minimum specificity level. Error schemas below this threshold fail. Default: `'enum'`. */
	min_specificity?: ErrorSchemaSpecificity;
	/** HTTP status codes to skip (e.g., middleware-injected codes). */
	ignore_statuses?: Array<number>;
	/** Routes to skip, in `'METHOD /path'` format. */
	allowlist?: Array<string>;
}

/**
 * Routes shipped by fuz_app whose error schemas require a tightness exemption.
 *
 * Currently empty — every fuz_app-shipped route (account login/password/
 * bootstrap/signup, db health/tables/:name/tables/:name/rows/:id) was tightened
 * in place to `z.enum([...])` / `z.literal(...)` against every emit-site error
 * code.
 *
 * Kept as a forward-compatibility hook: when new stock routes ship with
 * heterogeneous error surfaces that need an interim generic schema, add
 * them here instead of forcing every consumer to hand-maintain the entry.
 *
 * Paths assume the standard `/api/account` + `/api/db` prefixes used by every
 * fuz_app consumer. Merged into `default_error_schema_tightness.allowlist` so
 * consumers calling `assert_error_schema_tightness` directly inherit the
 * exemptions; the standard attack-surface suite also prepends these entries
 * underneath any consumer-supplied allowlist so project-specific entries are
 * additive.
 */
export const fuz_app_stock_route_tightness_allowlist: ReadonlyArray<string> = [];

/**
 * Baseline error schema tightness applied by
 * `describe_standard_attack_surface_tests` when no config is passed.
 *
 * Uses `min_specificity: 'enum'` (the assertion default) with `ignore_statuses`
 * for middleware-derived status codes that are commonly generic (auth middleware
 * produces multiple error codes at 401/403, and 429 comes from rate limiters),
 * and `allowlist` seeded with `fuz_app_stock_route_tightness_allowlist` so
 * fuz_app-shipped routes with heterogeneous generic schemas don't force every
 * consumer to hand-maintain an identical allowlist. Consumers can pass a
 * narrower config with project-specific `allowlist` entries, or pass `null`
 * to skip the assertion entirely.
 */
export const default_error_schema_tightness: ErrorSchemaTightnessOptions = {
	ignore_statuses: [401, 403, 429],
	allowlist: [...fuz_app_stock_route_tightness_allowlist],
};

/**
 * Assert that all error schemas meet a minimum specificity threshold.
 *
 * Calls `audit_error_schema_tightness` and fails on any entry below
 * the configured threshold. Use `allowlist` and `ignore_statuses` to exclude
 * known exceptions during progressive tightening.
 *
 * @throws AssertionError listing every route × status combination whose error
 *   schema specificity is below `min_specificity` (default `'enum'`) and is
 *   not in `allowlist` or `ignore_statuses`.
 */
export const assert_error_schema_tightness = (
	surface: AppSurface,
	options?: ErrorSchemaTightnessOptions,
): void => {
	const min_specificity = options?.min_specificity ?? 'enum';
	const ignore_statuses = new Set(options?.ignore_statuses?.map(String));
	const allowlist = new Set(options?.allowlist);
	const threshold = SPECIFICITY_ORDER[min_specificity];

	const entries = audit_error_schema_tightness(surface);
	const failures: Array<string> = [];

	for (const entry of entries) {
		if (ignore_statuses.has(entry.status)) continue;
		const key = `${entry.method} ${entry.route_path}`;
		if (allowlist.has(key)) continue;
		if (SPECIFICITY_ORDER[entry.specificity] < threshold) {
			failures.push(`${key} → ${entry.status} (${entry.specificity})`);
		}
	}

	assert.ok(
		failures.length === 0,
		`Error schemas below '${min_specificity}' threshold:\n  ${failures.join('\n  ')}`,
	);
};

// --- Aggregate runners ---

/**
 * Run all structural invariants. Options-free — applies universally.
 *
 * Catches schema/surface generation bugs: missing 401/403/400 declarations,
 * empty descriptions, duplicate routes, middleware-injected error codes
 * unpropagated to routes, structurally invalid error schemas, error codes
 * appearing at multiple statuses, and generic 404 schemas on param routes.
 *
 * @throws AssertionError on the first invariant violation; the message names
 *   the offending route and the missing/inconsistent field.
 */
export const assert_surface_invariants = (surface: AppSurface): void => {
	assert_protected_routes_declare_401(surface);
	assert_role_routes_declare_403(surface);
	assert_input_routes_declare_400(surface);
	assert_params_routes_declare_400(surface);
	assert_query_routes_declare_400(surface);
	assert_descriptions_present(surface);
	assert_no_duplicate_routes(surface);
	assert_middleware_errors_propagated(surface);
	assert_error_schemas_structurally_valid(surface);
	assert_error_code_status_consistency(surface);
	assert_404_schemas_use_specific_errors(surface);
};

/**
 * Run security policy invariants. Configurable with sensible defaults.
 *
 * Checks:
 * - Sensitive routes are rate-limited
 * - No unexpected public mutation routes
 * - Input schemas use mutation methods (not GET)
 * - Keeper routes under expected prefixes
 *
 * @throws AssertionError on the first policy violation; the message names
 *   the offending route.
 */
export const assert_surface_security_policy = (
	surface: AppSurface,
	options: SurfaceSecurityPolicyOptions = {},
): void => {
	assert_sensitive_routes_rate_limited(surface, options.sensitive_route_patterns);
	assert_no_unexpected_public_mutations(surface, options.public_mutation_allowlist);
	assert_mutation_routes_use_post(surface);
	assert_keeper_routes_under_prefix(surface, options.keeper_route_prefixes);
};
