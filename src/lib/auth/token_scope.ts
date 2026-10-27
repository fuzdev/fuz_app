/**
 * `TokenScope` — the per-credential authority narrowing stored on
 * `api_token.scope`.
 *
 * Twin of the Rust spine's `fuz_auth::token_scope`. The stored document is the
 * wire contract; both spines read the same `api_token.scope` JSONB, so the
 * `kind` strings, the field names, and the version constant must match exactly.
 *
 * ## The whole vocabulary
 *
 * Two variants, and three rules:
 *
 * 1. **`full` must be spelled at mint.** `account_token_create` takes a required
 *    `scope`, the column is `NOT NULL`, and session / daemon-token credentials
 *    resolve to `full` by construction. There is no absent state — which is the
 *    whole point. The 2026-02 `scope` column stored `full` / `read` / `write`
 *    and nothing enforced them; the reason that was worse than nothing is that
 *    the absent/unenforced case was indistinguishable from a decision.
 * 2. **`methods` denies every method it does not list.** An empty list is legal
 *    and renders the token inert for RPC — unlike an empty `credential_types`
 *    allowlist, which is rejected because it renders an *action* unreachable.
 * 3. **A narrowed token is RPC-only.** `methods` denies outright every non-RPC
 *    spine surface that reads account data or carries authority — the
 *    db-admin browser, the bare-hash fact read, the audit SSE stream, the WS
 *    upgrade, the surface explorer, and the `auth_request` probe. See
 *    `token_scope_admits_non_rpc`, and `docs/security.md` §Token scoping for
 *    the reads that answer it as anonymous and the server status read.
 *
 * @module
 */

import { z } from 'zod';

/** Current `TokenScope` document version. Must match the Rust `TOKEN_SCOPE_VERSION`. */
export const TOKEN_SCOPE_VERSION = 1;

/**
 * Serialized-document cap. Matches the Rust `MAX_TOKEN_SCOPE_BYTES` and
 * fuz_forge's `MAX_POLICY_BYTES`.
 */
export const MAX_TOKEN_SCOPE_BYTES = 4 * 1024;

/**
 * The stored `api_token.scope` document.
 *
 * `grandfathered` is a fact about the *row* — the `api_token_scope` migration
 * wrote it; no minter chose it — that only the token list cares about. The
 * enforcement path never branches on it, which is what stops "grandfathered"
 * from becoming a third authority level.
 *
 * Strict on both arms so a v2 document carrying a grant arm a v1 reader doesn't
 * understand is refused rather than parsed as permissively-narrower-than-stored.
 * The discriminated union also refuses the contradiction
 * `{kind: 'full', methods: [...]}`.
 */
export const TokenScope = z.discriminatedUnion('kind', [
	z.strictObject({
		version: z.literal(TOKEN_SCOPE_VERSION),
		kind: z.literal('full'),
		grandfathered: z.boolean().optional()
	}),
	z.strictObject({
		version: z.literal(TOKEN_SCOPE_VERSION),
		kind: z.literal('methods'),
		methods: z.array(z.string()),
		grandfathered: z.boolean().optional()
	})
]);
export type TokenScope = z.infer<typeof TokenScope>;

/**
 * The `scope` input accepted by `account_token_create` — the stored shape minus
 * the row-owned fields.
 *
 * A minter cannot set `version` or `grandfathered`: the first is stamped by
 * `token_scope_full` / `token_scope_methods`, and the second is the migration's
 * mark for tokens that predate scoping. Letting a caller forge `grandfathered`
 * would turn a tracked debt into a laundered one.
 */
export const TokenScopeInput = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('full') }),
	z.strictObject({ kind: z.literal('methods'), methods: z.array(z.string()) })
]);
export type TokenScopeInput = z.infer<typeof TokenScopeInput>;

/** A deliberately-minted full-authority scope. */
export const token_scope_full = (): TokenScope => ({
	version: TOKEN_SCOPE_VERSION,
	kind: 'full'
});

/** A narrowed scope over `methods`. */
export const token_scope_methods = (methods: Array<string>): TokenScope => ({
	version: TOKEN_SCOPE_VERSION,
	kind: 'methods',
	methods
});

/**
 * Build the stored scope from a mint-time input.
 *
 * Duplicate method names collapse into one, first occurrence kept: the set is
 * what the scope admits, and the Rust spine stores a set, so both count the
 * same methods (the `account_token_list` label reads `N methods`).
 */
export const token_scope_from_input = (input: TokenScopeInput): TokenScope =>
	input.kind === 'full' ? token_scope_full() : token_scope_methods([...new Set(input.methods)]);

/**
 * Does `scope` admit dispatching `method`?
 *
 * Consulted by `perform_action` between the credential gate and the role gate.
 */
export const token_scope_admits_method = (scope: TokenScope, method: string): boolean =>
	scope.kind === 'full' || scope.methods.includes(method);

/**
 * Does `scope` admit a non-RPC spine surface?
 *
 * **A narrowed token reaches no non-RPC surface that reads account data or
 * carries authority** — the load-bearing half of token scoping, and what
 * "rule 3" names wherever this module's callers and the Rust twin use that
 * shorthand. See `docs/security.md` §Token scoping.
 *
 * A method-name allowlist alone would have been a false promise: the db-admin
 * browser serves paginated rows of any `public` table (including
 * `account.password_hash`, `auth_session`, and `api_token`) plus row `DELETE`,
 * gated on a global role a bearer credential satisfies. A token whose UI badge
 * read "scoped to `cell_get`" could still delete an account row.
 *
 * The predicate is all-or-nothing: no per-surface vocabulary decides anything,
 * so it fits in one sentence a user can hold — *a scoped token is RPC-only*.
 * Placement is per site: a route that refuses anonymous callers declares
 * `auth.required_scope`, one that answers them reads the credential through
 * `get_public_account_id` and answers a narrowed token as anonymous, and the
 * surface census pins every site.
 */
export const token_scope_admits_non_rpc = (scope: TokenScope): boolean => scope.kind === 'full';

/**
 * The non-RPC surfaces the **spine itself** mounts (rule 3). Twin of the Rust
 * `TokenSurface` enum, name for name, except the two only the TS spine serves:
 * `app_surface`, the opt-in `GET /api/surface` explorer
 * (`server/surface_route.ts`), and `account_verify`, the
 * `GET /api/account/verify` nginx `auth_request` probe
 * (`auth/account_route_schema.ts`).
 *
 * Not a registry a consumer registers into. `RouteAuth.required_scope` accepts
 * any well-formed `surface:<name>` (see `is_route_scope_capability`), so a
 * consumer names its own non-RPC surface without an upstream release. This
 * tuple is what the *spine* may declare, and what its surface census iterates
 * — the closure is a check on fuz_app's own routes, not a vocabulary consumers
 * have to ask permission to extend.
 *
 * A surface name never decides anything: rule 3 is all-or-nothing
 * (`token_scope_admits_non_rpc`), so the name only labels *which* surface
 * refused, in the `required_scope` a denial reports — the same field whose
 * `rpc:<method>` value, in a dispatcher denial, carries arbitrary consumer
 * method names.
 */
export const TOKEN_SURFACES = [
	'db_admin',
	'fact_bare',
	'audit_stream',
	'ws_upgrade',
	'app_surface',
	'account_verify'
] as const;
export type TokenSurface = (typeof TOKEN_SURFACES)[number];

/**
 * Is `value` one of the surfaces the spine mounts?
 *
 * Membership, not well-formedness — `is_route_scope_capability` is the format
 * check the guard resolver runs on a declaration, and it is deliberately looser.
 * Used where the *spine's* own surfaces are the question: the direct-call denial
 * helpers, and the census assertion that fuz_app declares no surface it doesn't
 * mount.
 */
export const is_token_surface = (value: string): value is TokenSurface =>
	(TOKEN_SURFACES as ReadonlyArray<string>).includes(value);

/**
 * Name format for the identifier half of a capability string. Mirrors
 * `RoleName` / `CredentialTypeName` / `ScopeKindName`.
 *
 * Applied to the `surface:` arm only. The `rpc:` arm's identifier is an action
 * method name, whose vocabulary belongs to `ActionSpec` (and includes shapes
 * like `peer/ping` this regex would refuse); the dispatcher computes it from the
 * registered method, so nothing parses one.
 */
export const TOKEN_SURFACE_NAME_REGEX = /^[a-z][a-z_]*[a-z]$|^[a-z]$/;

// Capability-string prefixes. Private: `token_scope_method_capability` builds
// the one capability anything computes, and `is_route_scope_capability` checks
// the one a route declares, so nothing outside this module concatenates these.
const CAPABILITY_RPC_PREFIX = 'rpc:';
const CAPABILITY_SURFACE_PREFIX = 'surface:';

/**
 * The capability string an action method is refused under: `rpc:<method>`.
 *
 * Computed by the dispatcher's per-method gate, where a `surface:` capability is
 * always written as a literal on a route spec, so nothing computes one.
 */
export const token_scope_method_capability = (method: string): string =>
	`${CAPABILITY_RPC_PREFIX}${method}`;

/**
 * Is `value` a capability a route spec may declare as `auth.required_scope`?
 *
 * Only the `surface:<name>` arm: a route is a non-RPC surface, and rule 3 is
 * all-or-nothing there. The `rpc:<method>` arm is the dispatcher's per-method
 * gate (`perform_action`), which a route never reaches — so a route declaring
 * one would put a method name in front of a REST handler that no method gate
 * guards, and is refused at registration.
 *
 * Callers turn `false` into a registration-time throw: `RouteAuth.required_scope`
 * is typed as a plain string so `http/` needs no `auth/` import, and this is the
 * single point where that string becomes a mounted guard, so it is where the
 * value gets checked. The identifier is checked for shape
 * (`TOKEN_SURFACE_NAME_REGEX`), not membership — a consumer names its own surface.
 *
 * @param value - the declared capability string, e.g. `surface:audit_stream`
 * @returns whether `value` is a well-formed `surface:<name>` capability
 */
export const is_route_scope_capability = (value: string): boolean =>
	value.startsWith(CAPABILITY_SURFACE_PREFIX) &&
	TOKEN_SURFACE_NAME_REGEX.test(value.slice(CAPABILITY_SURFACE_PREFIX.length));

/**
 * Build the flat denial body a non-RPC route returns when a narrowed token
 * reaches a capability it lacks:
 * `{error: 'token_scope_required', required_scope: '<section>:<id>'}` at 403.
 *
 * One shape for every capability, matching the Rust
 * `token_scope_surface_denied_response`. These are REST-ish routes whose
 * sibling denials are already flat, so the JSON-RPC envelope stays with the
 * dispatcher's per-method gate and stops there.
 */
export const token_scope_denied_body = (
	capability: string
): { error: 'token_scope_required'; required_scope: string } => ({
	error: 'token_scope_required',
	required_scope: capability
});

/** Stable label for the token list / UI. */
export const token_scope_label = (scope: TokenScope): string => {
	if (scope.kind === 'full') return scope.grandfathered ? 'full (grandfathered)' : 'full';
	return `${scope.methods.length} methods`;
};

/**
 * Parse a stored document, enforcing the size cap and the schema.
 *
 * **Fail-closed**: returns `null` on an unreadable document, and every caller on
 * the enforcement path treats `null` as "refuse the credential" rather than
 * "allow everything". fuz_forge's hydrate path deliberately widens on a DB blip
 * — safe there only because a role gate still applies. Here the scope *is* the
 * gate, so widening on a parse failure would hand a narrowed token full
 * authority exactly when something is already wrong.
 */
export const parse_token_scope = (raw: string): TokenScope | null => {
	if (raw.length > MAX_TOKEN_SCOPE_BYTES) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	const parsed = TokenScope.safeParse(value);
	return parsed.success ? parsed.data : null;
};

/**
 * Serialize for storage, enforcing the size cap.
 *
 * Throws on an over-cap document — the mint path maps that to a 400, matching
 * the Rust side's `TokenScopeError::TooLarge`.
 */
export const serialize_token_scope = (scope: TokenScope): string => {
	const json = JSON.stringify(scope);
	if (json.length > MAX_TOKEN_SCOPE_BYTES) {
		throw new Error(
			`token scope document is ${json.length} bytes, exceeding the ${MAX_TOKEN_SCOPE_BYTES} byte cap`
		);
	}
	return json;
};

/**
 * Read a stored `api_token.scope` value back into a `TokenScope`, or `null`
 * when the document is unreadable.
 *
 * The DB driver may hand `scope` back already-parsed (JSONB → object) or as
 * text depending on backend, so both are normalized here rather than at each
 * call site. Lives here rather than beside the queries so the pure scope module
 * owns every parse — and so mocking the query module doesn't drag this along.
 */
export const parse_stored_token_scope = (value: unknown): TokenScope | null => {
	if (typeof value === 'string') return parse_token_scope(value);
	// `JSON.stringify(undefined)` returns `undefined`, not a string — so a row
	// missing the column entirely must be caught here rather than reaching
	// `parse_token_scope` and throwing on `.length`. Absent is *unreadable*,
	// which is fail-closed: the caller refuses the credential.
	const json = JSON.stringify(value);
	return json === undefined ? null : parse_token_scope(json);
};
