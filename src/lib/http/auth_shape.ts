/**
 * Canonical four-axis auth shape for action specs and route specs.
 *
 * Replaces the discriminated `'public' | 'authenticated' | 'keeper' | {role}`
 * literal that conflated authentication, account resolution, actor resolution,
 * and authorization into a single value. The flat record names each axis
 * the dispatcher actually walks:
 *
 * - `account` — does the dispatcher require / load / skip the account?
 * - `actor` — does the dispatcher require / load / skip the acting actor?
 * - `roles` — disjunction of permitted roles (any-of); absent = no role check.
 * - `credential_types` — restricts the credential channel (e.g. daemon_token);
 *   absent = any authenticated credential.
 *
 * The same shape governs both `ActionSpec.auth` (in `actions/action_spec.ts`)
 * and `RouteSpec.auth` (in `http/route_spec.ts`). Both surfaces converged on
 * the design after `TODO_AUTH_SHAPE.md`; the canonical schema lives here in
 * `http/` because that preserves the existing `actions → http` dependency
 * direction (and `error_schemas.ts` / `surface.ts` consume the type).
 *
 * Registry-time invariants 1, 3, and 4 from `TODO_AUTH_SHAPE.md` live on
 * the schema's `.superRefine` so any spec that fails them throws at the
 * Zod parse boundary. Invariant 2 (the `actor !== 'none' ⟺ input declares
 * acting?: ActingActor` biconditional) needs introspection of the spec's
 * input schema, so it is enforced at registration time inside the
 * dispatcher loops (`apply_route_specs`, `create_rpc_endpoint`,
 * `register_action_ws`) — see the `assert_route_auth_acting_biconditional`
 * helper in `auth/request_context.ts`.
 *
 * @module
 */

import {z} from 'zod';

/**
 * Per-axis auth state — names the dispatcher's behavior on `account` and
 * `actor` independently:
 *
 * - `'none'` — explicitly skipped, even when the credential provides it.
 *   Public actions (no auth surface) and notifications declare this.
 * - `'optional'` — surfaced if the credential provides it, null otherwise.
 *   Identity-aware reads with anonymous fallback (cell_get-style) declare
 *   this on `account` / `actor`.
 * - `'required'` — must be resolved; the dispatcher rejects requests that
 *   fail to provide it (401 for `account === 'required'` without a
 *   credential; the authorization phase 4xx for `actor === 'required'`
 *   without an actor binding).
 */
export const AuthAxisState = z.enum(['none', 'optional', 'required']);
export type AuthAxisState = z.infer<typeof AuthAxisState>;

/**
 * The canonical four-axis auth shape used by both `ActionSpec.auth` and
 * `RouteSpec.auth`.
 *
 * Cross-axis registry invariants enforced via `.superRefine`:
 *
 * 1. **Roles imply actor.** `roles?.length` ⟹ `actor === 'required'`.
 *    Role checks read the actor's role_grants, so a role-gated spec without
 *    a resolved actor would have nothing to check.
 * 3. **No accountless actors yet.** `account === 'none' && actor !== 'none'`
 *    is invalid in v1. The credential resolver always binds account before
 *    actor today; agent-token / group-actor credentials will lift this.
 * 4. **Unrestricted is leaf.** `account === 'none' && actor === 'none'`
 *    ⟹ no `roles`, no `credential_types` (nothing left to gate).
 *
 * Invariant 2 from `TODO_AUTH_SHAPE.md` — the `actor !== 'none' ⟺ input
 * declares acting?: ActingActor` biconditional — needs introspection of
 * the spec's input schema, so it is checked at registration time, not on
 * this schema. See `assert_route_auth_acting_biconditional` in
 * `auth/request_context.ts`.
 */
export const RouteAuth = z
	.strictObject({
		account: AuthAxisState,
		actor: AuthAxisState,
		roles: z.array(z.string()).readonly().optional(),
		credential_types: z.array(z.string()).readonly().optional(),
	})
	.superRefine((value, ctx) => {
		// invariant 1: roles imply actor
		if (value.roles?.length && value.actor !== 'required') {
			ctx.addIssue({
				code: 'custom',
				message:
					"auth.roles requires auth.actor === 'required' (role checks read the actor's role_grants)",
				path: ['roles'],
			});
		}
		// invariant 3: no accountless actors yet
		if (value.account === 'none' && value.actor !== 'none') {
			ctx.addIssue({
				code: 'custom',
				message:
					"auth.account === 'none' && auth.actor !== 'none' is not yet supported — accountless credentials (agent-token, group-actor) are out of scope for v1",
				path: ['actor'],
			});
		}
		// invariant 4: unrestricted is leaf
		if (value.account === 'none' && value.actor === 'none') {
			if (value.roles?.length) {
				ctx.addIssue({
					code: 'custom',
					message:
						"unrestricted auth (account === 'none' && actor === 'none') cannot declare roles — nothing to gate",
					path: ['roles'],
				});
			}
			if (value.credential_types?.length) {
				ctx.addIssue({
					code: 'custom',
					message:
						"unrestricted auth (account === 'none' && actor === 'none') cannot declare credential_types — nothing to gate",
					path: ['credential_types'],
				});
			}
		}
	});
export type RouteAuth = z.infer<typeof RouteAuth>;

// --- Predicates over the four-axis shape ---
//
// Pure derived reads of `RouteAuth`. Live here so every consumer that
// branches on the shape (the dispatcher's authorization phase, route
// guards, `merge_error_schemas`, `surface_query`, the surface explorer
// UI, and the testing harnesses) goes through one source of truth
// instead of inlining axis comparisons that drift over time.

/**
 * True iff the route is fully public — both account and actor axes
 * are `'none'`. Public routes skip the dispatcher's authorization
 * phase entirely (per registry-time invariant 4 they also cannot
 * declare roles or credential gates).
 */
export const is_public_auth = (auth: RouteAuth): boolean =>
	auth.account === 'none' && auth.actor === 'none';

/**
 * True iff the route declares an actor axis (`'optional'` or
 * `'required'`). Equivalent to "the dispatcher's authorization phase
 * may resolve an actor for this request" — which by registry-time
 * invariant 2 also means the input (or query, on REST GETs) declares
 * `acting?: ActingActor`.
 */
export const needs_actor = (auth: RouteAuth): boolean => auth.actor !== 'none';

/**
 * True iff the route declares an account axis (`'optional'` or
 * `'required'`). Per registry-time invariant 3 this is implied by
 * `needs_actor(auth)` in v1 (no accountless actors yet).
 */
export const needs_account = (auth: RouteAuth): boolean => auth.account !== 'none';

/** True iff the route declares any role gate (`auth.roles?.length`). */
export const is_role_auth = (auth: RouteAuth): boolean => !!auth.roles?.length;

/** True iff the route declares any credential-type gate (`auth.credential_types?.length`). */
export const is_credential_gated_auth = (auth: RouteAuth): boolean =>
	!!auth.credential_types?.length;

/**
 * True iff the route is the keeper bucket — credential gate restricted
 * to `daemon_token`. Keeper is the only credential gate today; if more
 * land, this filter widens. Knows the `'daemon_token'` literal directly
 * (the keeper composition is fuz_app's only registered credential gate).
 */
export const is_keeper_auth = (auth: RouteAuth): boolean =>
	auth.credential_types?.includes('daemon_token') ?? false;

/**
 * True iff the route is plain authenticated — `account === 'required'`
 * with no role gate and no credential gate. Account-grain authenticated
 * routes (logout, password change, account self-service) fall here.
 */
export const is_plain_authenticated_auth = (auth: RouteAuth): boolean =>
	auth.account === 'required' && !is_role_auth(auth) && !is_credential_gated_auth(auth);
