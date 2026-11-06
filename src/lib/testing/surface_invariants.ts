import './assert_dev_env.ts';

/**
 * Surface invariant assertions for `AppSurface` data.
 *
 * Two categories:
 * - **Structural** — validate internal consistency (error schema presence,
 *   descriptions, duplicates, middleware propagation, every error naming a
 *   code, error code consistency). No options needed.
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

import { assert } from 'vitest';

import { middleware_spec_applies } from '../http/schema_helpers.ts';
import type { AppSurface, AppSurfaceMiddleware } from '../http/surface.ts';
import {
	filter_protected_routes,
	filter_role_routes,
	filter_keeper_routes,
	filter_credential_gated_routes,
	filter_routes_with_input,
	filter_routes_with_params,
	filter_routes_with_query,
	filter_public_routes,
	format_route_key
} from '../http/surface_query.ts';
import { PROTOCOL_ACTION_METHODS } from '../actions/action_codegen.ts';
import {
	ERROR_INVALID_QUERY_PARAMS,
	ERROR_INVALID_REQUEST_BODY,
	ERROR_INVALID_ROUTE_PARAMS,
	REST_ERROR_CODE_PATTERN,
	is_rest_error_code
} from '../http/error_schemas.ts';

// --- Structural invariants ---

/**
 * Every protected route has 401 in `error_schemas`.
 */
export const assert_protected_routes_declare_401 = (surface: AppSurface): void => {
	const routes = filter_protected_routes(surface);
	for (const route of routes) {
		assert.ok(
			route.error_schemas && '401' in route.error_schemas,
			`${format_route_key(route)} is protected but missing 401 error schema`
		);
	}
};

/**
 * Every route with an authority gate that can answer 403 declares one — a
 * role gate, or a credential-channel gate of any kind (keeper included).
 *
 * The credential half is not just the keeper routes: the session-only gates
 * point the same axis the other way and refuse with the same status, so a
 * route carrying one and no 403 schema would have its denial body go
 * unvalidated by the DEV-only error-schema check.
 */
export const assert_role_routes_declare_403 = (surface: AppSurface): void => {
	const role_routes = filter_role_routes(surface);
	const credential_gated_routes = filter_credential_gated_routes(surface);
	for (const route of [...role_routes, ...credential_gated_routes]) {
		assert.ok(
			route.error_schemas && '403' in route.error_schemas,
			`${format_route_key(route)} has a role or credential gate but missing 403 error schema`
		);
	}
};

/**
 * Assert each route declares a 400 naming `code` among its branches — the
 * code its input middleware answers when it refuses the slot.
 */
const assert_routes_declare_400_code = (
	routes: ReadonlyArray<AppSurface['routes'][number]>,
	code: string,
	slot: string
): void => {
	for (const route of routes) {
		const declared = route.error_schemas?.['400'];
		assert.ok(declared, `${format_route_key(route)} has ${slot} but missing 400 error schema`);
		assert.ok(
			extract_error_consts(declared).includes(code),
			`${format_route_key(route)} has ${slot} but its 400 error schema does not name ${code}`
		);
	}
};

/**
 * Every route with a body — a non-null `input_schema` on a method other than
 * `GET`, which reads no body — declares a 400 naming `invalid_request_body`.
 */
export const assert_input_routes_declare_400 = (surface: AppSurface): void => {
	assert_routes_declare_400_code(
		filter_routes_with_input(surface).filter((route) => route.method !== 'GET'),
		ERROR_INVALID_REQUEST_BODY,
		'input'
	);
};

/**
 * Every route with non-null `params_schema` declares a 400 naming `invalid_route_params`.
 */
export const assert_params_routes_declare_400 = (surface: AppSurface): void => {
	assert_routes_declare_400_code(
		filter_routes_with_params(surface),
		ERROR_INVALID_ROUTE_PARAMS,
		'params'
	);
};

/**
 * Every route with non-null `query_schema` declares a 400 naming `invalid_query_params`.
 */
export const assert_query_routes_declare_400 = (surface: AppSurface): void => {
	assert_routes_declare_400_code(
		filter_routes_with_query(surface),
		ERROR_INVALID_QUERY_PARAMS,
		'query schema'
	);
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
		(m) => m.error_schemas !== null
	);
	for (const route of surface.routes) {
		for (const mw of middleware_with_errors) {
			if (!middleware_spec_applies(mw, route.path)) continue;
			for (const status of Object.keys(mw.error_schemas!)) {
				assert.ok(
					route.error_schemas && status in route.error_schemas,
					`${format_route_key(route)} missing status ${status} from middleware '${mw.name}'`
				);
			}
		}
	}
};

/**
 * Every error a route or middleware layer declares names its code exactly:
 * each body at each status (each branch of an `anyOf` or `oneOf`) is an
 * object whose `error` is a `const` or an `enum` — what a definition built by
 * `rest_error` writes. A bare string `error`, or a body with no `error`, is a
 * contract a client can't key on.
 *
 * @throws AssertionError naming the route or layer, the status, and the body
 */
export const assert_error_codes_specific = (surface: AppSurface): void => {
	for (const { label, status, branch } of each_error_branch(surface)) {
		const error_prop = get_error_property(branch);
		assert.ok(
			error_prop && (typeof error_prop.const === 'string' || Array.isArray(error_prop.enum)),
			`${label} error schema for status ${status} does not name its code — ` +
				`declare it with rest_error: ${JSON.stringify(branch)}`
		);
	}
};

/**
 * Every declared `error` code is a code — `REST_ERROR_CODE_PATTERN`, a
 * lowercase letter then lowercase letters, digits, and `_` — never prose,
 * which belongs in `message`. `rest_error` refuses one off the pattern; this
 * holds a surface built another way (a snapshot, a hand-written layer) to the
 * same rule.
 *
 * @throws AssertionError naming the route or layer, the status, and the code
 */
export const assert_error_codes_well_formed = (surface: AppSurface): void => {
	for (const { label, status, branch } of each_error_branch(surface)) {
		const error_prop = get_error_property(branch);
		if (!error_prop) continue;
		const codes: Array<unknown> =
			error_prop.const !== undefined
				? [error_prop.const]
				: Array.isArray(error_prop.enum)
					? error_prop.enum
					: [];
		for (const code of codes) {
			assert.ok(
				is_rest_error_code(code),
				`${label} error code ${JSON.stringify(code)} at status ${status} is not a code ` +
					`(${REST_ERROR_CODE_PATTERN.source}) — put prose in \`message\``
			);
		}
	}
};

/** Every body every route and middleware layer declares, one per union branch. */
const each_error_branch = (
	surface: AppSurface
): Array<{ label: string; status: string; branch: unknown }> => {
	const out: Array<{ label: string; status: string; branch: unknown }> = [];
	const visit = (label: string, status: string, schema: unknown): void => {
		const branches = get_union_branches(schema);
		if (branches) {
			for (const branch of branches) visit(label, status, branch);
			return;
		}
		out.push({ label, status, branch: schema });
	};
	for (const route of surface.routes) {
		if (!route.error_schemas) continue;
		for (const [status, schema] of Object.entries(route.error_schemas)) {
			visit(format_route_key(route), status, schema);
		}
	}
	for (const mw of surface.middleware) {
		if (!mw.error_schemas) continue;
		for (const [status, schema] of Object.entries(mw.error_schemas)) {
			visit(`middleware '${mw.name}'`, status, schema);
		}
	}
	return out;
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
			`Error code '${code}' appears at multiple status codes: ${[...statuses].sort().join(', ')}`
		);
	}
};

/**
 * Extract the `error` property's JSON Schema from a route error schema.
 *
 * Navigates `schema.properties.error` — every error body is an object with
 * an `error` code. Returns `null` if the schema doesn't conform.
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
 * The surface writes a status with several definitions as an `anyOf`, and a
 * `oneOf` from a JSON Schema written another way is read the same; both are
 * union-shaped for code extraction. Nested unions are NOT flattened
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

// --- RPC / WS structural invariants ---

/**
 * Every RPC method on every endpoint has a non-empty `description`.
 *
 * Parallel of `assert_descriptions_present` over `surface.rpc_endpoints`.
 * Empty descriptions on RPC methods leak through `library.json` codegen and
 * consumer-facing docs without the route-level check catching them.
 */
export const assert_rpc_method_descriptions_present = (surface: AppSurface): void => {
	for (const ep of surface.rpc_endpoints) {
		for (const method of ep.methods) {
			assert.ok(
				method.description.length > 0,
				`RPC method '${method.name}' on endpoint '${ep.path}' has empty description`
			);
		}
	}
};

/**
 * Every WS method on every endpoint has a non-empty `description`.
 *
 * Parallel of `assert_descriptions_present` over `surface.ws_endpoints`.
 * Same rationale as `assert_rpc_method_descriptions_present` — codegen +
 * surface explorer consume the description, blank values surface as `''`.
 */
export const assert_ws_method_descriptions_present = (surface: AppSurface): void => {
	for (const ep of surface.ws_endpoints) {
		for (const method of ep.methods) {
			assert.ok(
				method.description.length > 0,
				`WS method '${method.name}' on endpoint '${ep.path}' has empty description`
			);
		}
	}
};

/**
 * Every WS endpoint's `methods` includes every protocol action method
 * (`heartbeat`, `cancel`).
 *
 * Consumers register WS endpoints by spreading `protocol_actions` from
 * `actions/protocol.ts` before their own actions:
 *
 * ```ts
 * ws_endpoints: [{path: '/api/ws', actions: [...protocol_actions, ...consumer_actions], ...}]
 * ```
 *
 * Forgetting the spread compiles cleanly but breaks at runtime: client-side
 * heartbeats and `cancel` notifications get `method_not_found` from the
 * dispatcher, so disconnect detection silently regresses and per-request
 * cancel never aborts the matching handler. Catch the mistake at the
 * surface layer rather than at runtime.
 */
export const assert_ws_endpoints_include_protocol_actions = (surface: AppSurface): void => {
	for (const ep of surface.ws_endpoints) {
		const method_names = new Set(ep.methods.map((m) => m.name));
		for (const expected of PROTOCOL_ACTION_METHODS) {
			assert.ok(
				method_names.has(expected),
				`WS endpoint '${ep.path}' is missing protocol action method '${expected}' — ` +
					`spread \`protocol_actions\` from 'actions/protocol.ts' into \`actions\``
			);
		}
	}
};

/**
 * WS methods follow the kind ⇔ auth biconditional emitted by surface
 * generation: `kind === 'remote_notification' ⟺ auth === null`.
 *
 * `generate_app_surface` produces this shape directly from the action
 * spec union (notifications carry `auth: null` per `ActionSpecUnion`;
 * `request_response` carries a `RouteAuth`). The assertion guards against
 * drift if a future surface emitter, transform, or test fixture violates
 * it — and gives consumers a clear failure message when a hand-built
 * surface mocks the shape incorrectly.
 */
export const assert_ws_notifications_have_null_auth = (surface: AppSurface): void => {
	for (const ep of surface.ws_endpoints) {
		for (const method of ep.methods) {
			const is_notification = method.kind === 'remote_notification';
			const has_null_auth = method.auth === null;
			assert.ok(
				is_notification === has_null_auth,
				`WS method '${method.name}' on endpoint '${ep.path}' violates kind ⇔ auth: ` +
					`kind='${method.kind}', auth=${has_null_auth ? 'null' : 'non-null'} ` +
					`(notifications must have auth: null; request_response must have a RouteAuth)`
			);
		}
	}
};

/**
 * Reserved method-name prefix for the daemon-token-gated test-backdoor
 * actions (`_testing_reset`, `_testing_mint_session`, `_testing_put_fact`,
 * `_testing_drain_effects`, `_testing_schema_snapshot`). Test binaries
 * live-mount these on their RPC endpoint but they must never appear on a
 * **declared** surface.
 */
export const TESTING_METHOD_PREFIX = '_testing_';

/**
 * No `_testing_*` backdoor action ever appears as a method on the declared
 * surface (RPC or WS).
 *
 * The test-backdoor actions (`_testing_reset` et al.) are daemon-token-gated
 * privileged actions a consumer's test binary appends to its live RPC
 * endpoint at assembly time — but they are deliberately excluded from
 * surface generation (`spine_rpc_endpoints` and every consumer's
 * `create_*_app_surface_spec` omit them) so the published attack surface,
 * the committed `*_attack_surface.json` snapshot, and codegen never carry
 * a backdoor. This invariant is the structural guard against a future
 * wiring change that folds `create_testing_actions(...)` into the *declared*
 * registry instead of the live-only append — the surface stays the
 * authoritative "what the server exposes" map only if a backdoor can never
 * hide in it.
 *
 * Pairs with the wire-level negative-credential check
 * (`describe_testing_backdoor_cross_tests`, cross-process) and the
 * spec-level gate check: this one pins absence-from-surface, those pin
 * the daemon-token gate and the 401/403 behavior.
 *
 * @throws AssertionError naming the offending endpoint + method.
 */
export const assert_no_testing_methods = (surface: AppSurface): void => {
	for (const ep of surface.rpc_endpoints) {
		for (const method of ep.methods) {
			assert.ok(
				!method.name.startsWith(TESTING_METHOD_PREFIX),
				`RPC endpoint '${ep.path}' exposes test-backdoor method '${method.name}' on the ` +
					`declared surface — '${TESTING_METHOD_PREFIX}*' actions must be live-mounted only, ` +
					`never folded into the surface-generating registry`
			);
		}
	}
	for (const ep of surface.ws_endpoints) {
		for (const method of ep.methods) {
			assert.ok(
				!method.name.startsWith(TESTING_METHOD_PREFIX),
				`WS endpoint '${ep.path}' exposes test-backdoor method '${method.name}' on the ` +
					`declared surface — '${TESTING_METHOD_PREFIX}*' actions must be live-mounted only`
			);
		}
	}
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
	/\/bootstrap$/
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
	sensitive_patterns: Array<string | RegExp> = DEFAULT_SENSITIVE_PATTERNS
): void => {
	for (const route of surface.routes) {
		const matches = sensitive_patterns.some((pattern) =>
			typeof pattern === 'string' ? route.path.includes(pattern) : pattern.test(route.path)
		);
		if (!matches) continue;
		const has_rate_limit =
			route.rate_limit_key !== null ||
			(route.error_schemas !== null && '429' in route.error_schemas);
		assert.ok(
			has_rate_limit,
			`${format_route_key(route)} matches a sensitive pattern but has no rate limiting declared`
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
	allowlist: Array<string> = []
): void => {
	const public_routes = filter_public_routes(surface);
	const mutations = public_routes.filter((r) => r.is_mutation);
	const allowset = new Set(allowlist);
	for (const route of mutations) {
		const key = format_route_key(route);
		assert.ok(
			allowset.has(key),
			`${key} is a public mutation route not in the allowlist. ` +
				`Add it to public_mutation_allowlist if intentional.`
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
 * schemas live in `rpc_endpoints` surface, not on routes; see
 * `assert_rpc_ws_surface_invariants` for the parallel checks over RPC/WS
 * method shapes.
 */
export const assert_mutation_routes_use_post = (surface: AppSurface): void => {
	const input_routes = filter_routes_with_input(surface);
	for (const route of input_routes) {
		assert.ok(
			route.method !== 'GET',
			`${format_route_key(route)} has input schema on GET route — use POST or move to params/query`
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
	prefixes: Array<string> = DEFAULT_KEEPER_ROUTE_PREFIXES
): void => {
	const keeper_routes = filter_keeper_routes(surface);
	for (const route of keeper_routes) {
		const under_prefix = prefixes.some((prefix) => route.path.startsWith(prefix));
		assert.ok(
			under_prefix,
			`${format_route_key(
				route
			)} is keeper-protected but not under any expected prefix: ${prefixes.join(', ')}`
		);
	}
};

// --- Aggregate runners ---

/**
 * Run all structural invariants. Options-free — applies universally.
 *
 * Catches schema/surface generation bugs: missing 401/403/400 declarations,
 * empty descriptions, duplicate routes, middleware-injected error codes
 * unpropagated to routes, an error that doesn't name its code or whose code
 * is not one, and error codes appearing at multiple statuses.
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
	assert_error_codes_specific(surface);
	assert_error_codes_well_formed(surface);
	assert_error_code_status_consistency(surface);
};

/**
 * Run all RPC / WS structural invariants. Options-free — applies
 * universally to the `surface.rpc_endpoints` and `surface.ws_endpoints`
 * slots produced by `generate_app_surface`.
 *
 * Parallel of `assert_surface_invariants` for the non-REST surfaces.
 * Within-endpoint duplicate method names and the auth-shape biconditional
 * are already enforced at startup by `compile_action_registry` (see
 * `actions/CLAUDE.md` §Registry compile) — these assertions cover only
 * the contract-surface concerns that a runtime registration check
 * cannot: empty descriptions, missing protocol-action spread on WS
 * endpoints, kind ⇔ auth drift on WS methods, and a `_testing_*`
 * backdoor action leaking onto the declared surface.
 *
 * @throws AssertionError on the first invariant violation; the message
 *   names the offending endpoint, method, and field.
 */
export const assert_rpc_ws_surface_invariants = (surface: AppSurface): void => {
	assert_rpc_method_descriptions_present(surface);
	assert_ws_method_descriptions_present(surface);
	assert_ws_endpoints_include_protocol_actions(surface);
	assert_ws_notifications_have_null_auth(surface);
	assert_no_testing_methods(surface);
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
	options: SurfaceSecurityPolicyOptions = {}
): void => {
	assert_sensitive_routes_rate_limited(surface, options.sensitive_route_patterns);
	assert_no_unexpected_public_mutations(surface, options.public_mutation_allowlist);
	assert_mutation_routes_use_post(surface);
	assert_keeper_routes_under_prefix(surface, options.keeper_route_prefixes);
};
