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
 * Catches typos in error schema definitions and ensures consumers can always
 * read `.error` from error responses.
 */
export const assert_error_schemas_structurally_valid = (surface: AppSurface): void => {
	for (const route of surface.routes) {
		if (!route.error_schemas) continue;
		for (const [status, schema] of Object.entries(route.error_schemas)) {
			if (typeof schema !== 'object' || schema === null) continue;
			const s = schema as Record<string, unknown>;
			// JSON Schema must have properties.error or be an object type
			if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
				const props = s.properties as Record<string, unknown>;
				assert.ok(
					'error' in props,
					`${format_route_key(route)} error schema for status ${status} missing 'error' property`,
				);
			}
		}
	}
};

/**
 * The same `z.literal()` error code should not appear at different HTTP status codes
 * across routes.
 *
 * Extracts `const` values from error schema `error` properties (which correspond to
 * `z.literal()` in the Zod source). Flags when the same literal appears at different
 * status codes — e.g., `ERROR_INVALID_CREDENTIALS` at both 401 and 403 would be a bug.
 *
 * Only checks schemas with `const` values (literal schemas). Generic `z.string()`
 * schemas (which produce `{type: 'string'}` in JSON Schema) are ignored.
 */
export const assert_error_code_status_consistency = (surface: AppSurface): void => {
	// Map from error code literal → Set of status codes where it appears
	const code_to_statuses: Map<string, Set<string>> = new Map();

	for (const route of surface.routes) {
		if (!route.error_schemas) continue;
		for (const [status, schema] of Object.entries(route.error_schemas)) {
			const error_const = extract_error_const(schema);
			if (error_const === null) continue;
			let statuses = code_to_statuses.get(error_const);
			if (!statuses) {
				statuses = new Set();
				code_to_statuses.set(error_const, statuses);
			}
			statuses.add(status);
		}
	}

	// Also check middleware error schemas
	for (const mw of surface.middleware) {
		if (!mw.error_schemas) continue;
		for (const [status, schema] of Object.entries(mw.error_schemas)) {
			const error_const = extract_error_const(schema);
			if (error_const === null) continue;
			let statuses = code_to_statuses.get(error_const);
			if (!statuses) {
				statuses = new Set();
				code_to_statuses.set(error_const, statuses);
			}
			statuses.add(status);
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
 * Extract the `const` value from a JSON Schema error property, if present.
 *
 * Looks for `schema.properties.error.const` — the JSON Schema representation
 * of `z.literal('some_error_code')`.
 */
const extract_error_const = (schema: unknown): string | null => {
	const error_prop = get_error_property(schema);
	if (!error_prop) return null;
	if (typeof error_prop.const === 'string') return error_prop.const;
	return null;
};

/**
 * Check if a JSON Schema error property uses specific error codes (`const` or `enum`),
 * not just generic `z.string()` (`{type: 'string'}`).
 *
 * Returns `true` for `z.literal()` (`{const: '...'}`) and `z.enum()` (`{enum: [...]}`).
 */
const has_specific_error_schema = (schema: unknown): boolean => {
	const error_prop = get_error_property(schema);
	if (!error_prop) return false;
	return typeof error_prop.const === 'string' || Array.isArray(error_prop.enum);
};

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
 */
const classify_error_specificity = (schema: unknown): ErrorSchemaSpecificity => {
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
 */
const extract_error_codes = (schema: unknown): Array<string> | null => {
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
 * @param surface - the app surface to audit
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
	 * Default: common sensitive patterns (login, password, bootstrap, tokens/create).
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

/** Default patterns for sensitive routes that should be rate-limited. */
const DEFAULT_SENSITIVE_PATTERNS: Array<string | RegExp> = [
	/\/login$/,
	/\/password$/,
	/\/bootstrap$/,
	/\/tokens\/create$/,
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
 * Recommended baseline error schema tightness for consumer projects.
 *
 * Uses `min_specificity: 'enum'` (the assertion default) with `ignore_statuses`
 * for middleware-derived status codes that are commonly generic (auth middleware
 * produces multiple error codes at 401/403, and 429 comes from rate limiters).
 * Consumers can extend with project-specific `allowlist` entries.
 */
export const DEFAULT_ERROR_SCHEMA_TIGHTNESS: ErrorSchemaTightnessOptions = {
	ignore_statuses: [401, 403, 429],
};

/**
 * Assert that all error schemas meet a minimum specificity threshold.
 *
 * Calls `audit_error_schema_tightness` and fails on any entry below
 * the configured threshold. Use `allowlist` and `ignore_statuses` to exclude
 * known exceptions during progressive tightening.
 *
 * @param surface - the app surface to check
 * @param options - threshold and exclusion configuration
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
