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
 *    Role checks read the actor's permits, so a role-gated spec without
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
					"auth.roles requires auth.actor === 'required' (role checks read the actor's permits)",
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
