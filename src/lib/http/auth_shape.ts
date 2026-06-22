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
 * and `RouteSpec.auth` (in `http/route_spec.ts`). The canonical schema
 * lives here in `http/` because that preserves the existing
 * `actions → http` dependency direction (and `http/error_schemas.ts` /
 * `http/surface.ts` consume the type).
 *
 * Registry-time invariants 1, 3, and 4 live on the schema's
 * `.superRefine` so any spec that fails them throws at the Zod parse
 * boundary. Invariant 2 (the `actor !== 'none' ⟺ input or query
 * declares acting?: ActingActor` biconditional) needs introspection of
 * the spec's input/query schemas, so it is enforced at registration
 * time inside the dispatcher loops (`apply_route_specs`,
 * `create_rpc_endpoint`, `register_action_ws`) via the
 * `assert_route_auth_acting_biconditional` helper exported below.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.ts';
import {zod_unwrap_to_object} from '@fuzdev/fuz_util/zod.ts';

/**
 * `acting` field shared by every input that needs the caller's acting actor.
 * Declaring `acting: ActingActor` on a route or action input signals to the
 * dispatcher's authorization phase to resolve an actor against the
 * authenticated account: it runs `resolve_acting_actor`, builds the
 * actor-bound `RequestContext`, and loads role_grants before auth guards fire.
 *
 * Resolution rules: omitted + 1 actor → use it; omitted + multiple actors →
 * `actor_required` with the available list; supplied + on the account → use
 * it; supplied + foreign actor → `actor_not_on_account`.
 *
 * Account-grain routes — input doesn't declare `acting` and auth doesn't
 * require role_grants — skip resolution entirely; their `RequestContext.actor`
 * is `null` and the audit envelope's `actor_id` stays null.
 *
 * Lives next to `RouteAuth` because the two are paired by registry-time
 * invariant 2: `auth.actor !== 'none'` ⟺ input (or query, on REST GETs)
 * declares `acting?: ActingActor`. Keeping the contract in one module
 * removes the http/ → auth/ import that an earlier split forced.
 */
export const ActingActor = Uuid.optional().meta({
	description:
		'Actor on the authenticated account that this request acts as. Omit on single-actor accounts; required on multi-actor.',
});
export type ActingActor = z.infer<typeof ActingActor>;

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
 * Invariant 2 — the `actor !== 'none' ⟺ input or query declares
 * acting?: ActingActor` biconditional — needs introspection of the
 * spec's input/query schemas, so it is checked at registration time,
 * not on this schema. See `assert_route_auth_acting_biconditional`
 * below.
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

// --- Registry-time invariant 2 enforcement ---
//
// The biconditional `auth.actor !== 'none' ⟺ input (or query, on REST
// GETs) declares acting?: ActingActor`. Cannot live on the `RouteAuth`
// schema's `.superRefine` because it requires introspecting the spec's
// input/query schemas for reference equality with the canonical
// `ActingActor` schema above. Enforced at registration time by every
// dispatcher loop (`apply_route_specs`, `compile_action_registry` for
// `create_rpc_endpoint` + `register_action_ws`).

/**
 * Whether a schema declares the canonical `acting?: ActingActor` field.
 * Reference-equality on the exported `ActingActor` schema — consumer
 * schemas with unrelated `acting` fields don't trip this check.
 *
 * Peels through Zod wrappers (`optional`, `nullable`, `default`,
 * `transform`, `pipe`, `prefault`) via `zod_unwrap_to_object` so a spec
 * authored as `z.optional(z.strictObject({acting: ActingActor}))` or
 * `z.strictObject({acting: ActingActor}).default({})` still trips the
 * predicate.
 */
export const input_schema_declares_acting = (schema: z.ZodType): boolean => {
	const obj = zod_unwrap_to_object(schema);
	if (!obj) return false;
	return (obj.shape as Record<string, z.ZodType | undefined>).acting === ActingActor;
};

/**
 * Slots where a spec may declare the `acting?: ActingActor` field —
 * input for both REST + actions; query for REST GETs that bi-locate
 * `acting` on the query schema (actions have no `query` shape, so the
 * field is omitted on action call sites).
 */
export interface ActingSlots {
	input: z.ZodType;
	query?: z.ZodType;
}

/**
 * Registry-time biconditional check: `auth.actor !== 'none' ⟺ some
 * supplied slot declares acting?: ActingActor`. Throws on violation.
 *
 * The slot set differs by surface: REST passes `{input, query}` (both
 * locatable, query only set for GETs); action dispatchers pass `{input}`
 * (no query shape on `ActionSpec`). The throw message lists the slots
 * that were actually in play, so an actor-required action without
 * `acting` doesn't point the operator at a query slot that doesn't
 * exist on their spec.
 *
 * Called by every dispatcher registration loop (`apply_route_specs`,
 * `compile_action_registry`) on every spec it accepts.
 *
 * @param auth - the route/action's auth shape
 * @param slots - the spec's `acting`-bearing schemas; `query` omitted on action call sites
 * @param context - identifier for the throwing message (route key, RPC method, etc.)
 * @throws Error when the biconditional is violated
 */
export const assert_route_auth_acting_biconditional = (
	auth: RouteAuth,
	slots: ActingSlots,
	context: string,
): void => {
	const wants_actor = needs_actor(auth);
	const declares_acting =
		input_schema_declares_acting(slots.input) ||
		(slots.query !== undefined && input_schema_declares_acting(slots.query));
	if (wants_actor === declares_acting) return;
	const slot_phrase = slots.query !== undefined ? 'input or query schema' : 'input schema';
	if (wants_actor) {
		throw new Error(
			`${context}: auth.actor === '${auth.actor}' requires the ${
				slot_phrase
			} to declare 'acting?: ActingActor' (registry-time invariant 2)`,
		);
	}
	throw new Error(
		`${context}: ${
			slot_phrase
		} declares 'acting?: ActingActor' but auth.actor === 'none' (registry-time invariant 2)`,
	);
};
