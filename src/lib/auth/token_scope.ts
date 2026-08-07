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
 * 3. **A narrowed token is RPC-only.** `methods` denies every non-RPC spine
 *    surface outright — the db-admin browser, the bare-hash fact read, the
 *    audit SSE stream, and the WS upgrade. See `token_scope_admits_non_rpc`.
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

/** Build the stored scope from a mint-time input. */
export const token_scope_from_input = (input: TokenScopeInput): TokenScope =>
	input.kind === 'full' ? token_scope_full() : token_scope_methods(input.methods);

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
 * **A narrowed token reaches no non-RPC surface at all** — the load-bearing
 * half of token scoping, and what "rule 3" names wherever this module's
 * callers and the Rust twin use that shorthand. See ../../../docs/security.md
 * §Token scoping.
 *
 * A method-name allowlist alone would have been a false promise: the db-admin
 * browser serves paginated rows of any `public` table (including
 * `account.password_hash`, `auth_session`, and `api_token`) plus row `DELETE`,
 * gated on a global role a bearer credential satisfies. A token whose UI badge
 * read "scoped to `cell_get`" could still delete an account row.
 *
 * Denying every non-RPC surface outright is strictly more restrictive than
 * naming each one, keeps no vocabulary to maintain, and fits in one sentence a
 * user can hold: *a scoped token is RPC-only*.
 */
export const token_scope_admits_non_rpc = (scope: TokenScope): boolean => scope.kind === 'full';

/**
 * The non-RPC surfaces a narrowed token is refused (rule 3). Capability
 * strings match the Rust `TokenSurface`.
 */
export const TOKEN_SURFACE_CAPABILITIES = {
	db_admin: 'surface:db_admin',
	fact_bare: 'surface:fact_bare',
	audit_stream: 'surface:audit_stream',
	ws_upgrade: 'surface:ws_upgrade'
} as const;
export type TokenSurface = keyof typeof TOKEN_SURFACE_CAPABILITIES;

/**
 * Is `value` one of the named surfaces?
 *
 * `RouteAuth.token_surface` is typed as a plain string so `http/` needs no
 * `auth/` import, which makes a typo a value error rather than a type error.
 * This is what turns it back into one, at the single point where a declared
 * surface becomes a mounted guard — so the check and the narrowing can't drift
 * apart the way a separate `in` test plus an `as` cast can.
 */
export const is_token_surface = (value: string): value is TokenSurface =>
	value in TOKEN_SURFACE_CAPABILITIES;

/**
 * Build the flat denial body a non-RPC surface returns when a narrowed token
 * reaches it: `{error: 'token_scope_required', required_scope: 'surface:<name>'}`
 * at 403.
 *
 * One shape for every surface, matching the Rust
 * `token_scope_surface_denied_response`. These are REST-ish routes whose
 * sibling denials are already flat, so the JSON-RPC envelope stays with the
 * dispatcher's per-method gate and stops there.
 */
export const token_scope_surface_denied_body = (
	surface: TokenSurface
): { error: 'token_scope_required'; required_scope: string } => ({
	error: 'token_scope_required',
	required_scope: TOKEN_SURFACE_CAPABILITIES[surface]
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
