/**
 * Canonical auth shape for action specs and route specs.
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
 * - `required_scope` — the capability an api token's scope must admit to reach
 *   this route (`surface:<name>`); route specs only, absent = no scope gate.
 *
 * The same shape governs both `ActionSpec.auth` (in `actions/action_spec.ts`)
 * and `RouteSpec.auth` (in `http/route_spec.ts`). The canonical schema
 * lives here in `http/` because that preserves the existing
 * `actions → http` dependency direction (and `http/error_schemas.ts` /
 * `http/surface.ts` consume the type).
 *
 * Every registry-time invariant is enforced at registration, inside the
 * dispatcher loops every spec passes (`apply_route_specs` for route specs,
 * `compile_action_registry` for `create_rpc_endpoint` and
 * `register_action_ws`): the cross-axis invariants 1, 3, and 4 by
 * `assert_route_auth_invariants`, which reads the auth shape alone, and
 * invariant 2 (the `actor !== 'none' ⟺ input or query declares
 * acting?: ActingActor` biconditional), which introspects the spec's
 * input/query schemas, by `assert_route_auth_acting_biconditional`. Specs
 * are plain objects that no registration path parses, so both checks live in
 * code rather than on a schema.
 *
 * @module
 */

import { z } from 'zod';
import { is_schema, one_of, parse, type Infer } from '@fuzdev/fuz_schema/schema.ts';
import { get_schema_entries } from '@fuzdev/fuz_schema/introspect.ts';

import { Uuid } from '../primitive_schemas.ts';
import {
	ACTING_ACTOR_DESCRIPTION,
	ActingActor as ActingActorFuz
} from '../primitive_schemas_fuz.ts';
import { zod_unwrap_to_object } from '../zod.ts';
import type { ValidationSchema } from '../schema_issues.ts';

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
 *
 * A fuz_schema input declares the twin in `primitive_schemas_fuz.ts`, which
 * the dispatcher finds the same way.
 */
export const ActingActor = Uuid.optional().meta({ description: ACTING_ACTOR_DESCRIPTION });
export type ActingActor = z.infer<typeof ActingActor>;

/**
 * Read an `acting` selector out of an unvalidated value.
 *
 * The authorization phase runs **before** input validation on both dispatchers
 * (see `http/CLAUDE.md` §Validation pipeline), so it reads the selector raw.
 *
 * **A malformed selector reads as omitted, not as an error.** Safe because
 * `acting` only ever picks among actors the resolved account already owns — a
 * value that names nothing grants nothing — and because the typed input schema
 * rejects it a step later, so the caller still gets a 400. Refusing here
 * instead would put an input-shape complaint ahead of the authority gates,
 * which is the ordering this pipeline exists to avoid.
 *
 * The dispatchers pass through here so that rule has one home: the action
 * dispatcher's `read_acting` and the REST authorization handler's
 * `read_route_acting`. Twin of the Rust dispatcher's `read_acting`. The status
 * route and the WS upgrade read the raw `?acting=` through it too; neither has
 * an input schema behind it, so there a malformed selector is final (the
 * status route answers account-only).
 *
 * The grammar is the fuz_schema twin's, which is the Zod `ActingActor`'s and
 * the Rust spine's, so every value reads as the Zod `ActingActor` would, the
 * max UUID in any case included. The id comes back lowercased. A route
 * declaring `acting` on its Zod `query` schema doesn't read it here: that
 * schema runs ahead of the authorization phase, with the same grammar.
 *
 * @param value - the raw `acting` field, from params / query / body
 * @returns the actor id, or `undefined` when absent or malformed
 */
export const parse_acting = (value: unknown): string | undefined => {
	const parsed = parse(ActingActorFuz, value);
	return parsed.ok ? parsed.value : undefined;
};

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
export const AuthAxisState = one_of(['none', 'optional', 'required']);
export type AuthAxisState = Infer<typeof AuthAxisState>;

/** One broken cross-axis invariant: the offending field and why. */
interface RouteAuthInvariantViolation {
	path: 'roles' | 'actor' | 'credential_types';
	message: string;
}

/**
 * The cross-axis invariants 1, 3, and 4 an auth shape breaks, in that order —
 * the implementation behind `assert_route_auth_invariants`.
 */
const route_auth_invariant_violations = (auth: {
	account: AuthAxisState;
	actor: AuthAxisState;
	roles?: ReadonlyArray<string>;
	credential_types?: ReadonlyArray<string>;
}): Array<RouteAuthInvariantViolation> => {
	const violations: Array<RouteAuthInvariantViolation> = [];
	// invariant 1: roles imply actor
	if (auth.roles?.length && auth.actor !== 'required') {
		violations.push({
			path: 'roles',
			message:
				"auth.roles requires auth.actor === 'required' (role checks read the actor's role_grants)"
		});
	}
	// invariant 3: no accountless actors yet
	if (auth.account === 'none' && auth.actor !== 'none') {
		violations.push({
			path: 'actor',
			message:
				"auth.account === 'none' && auth.actor !== 'none' is not yet supported — accountless credentials (agent-token, group-actor) are out of scope for v1"
		});
	}
	// invariant 4: unrestricted is leaf
	if (auth.account === 'none' && auth.actor === 'none') {
		if (auth.roles?.length) {
			violations.push({
				path: 'roles',
				message:
					"unrestricted auth (account === 'none' && actor === 'none') cannot declare roles — nothing to gate"
			});
		}
		if (auth.credential_types?.length) {
			violations.push({
				path: 'credential_types',
				message:
					"unrestricted auth (account === 'none' && actor === 'none') cannot declare credential_types — nothing to gate"
			});
		}
	}
	return violations;
};

/**
 * The canonical auth shape used by both `ActionSpec.auth` and
 * `RouteSpec.auth`.
 *
 * Cross-axis registry invariants, checked at registration by
 * `assert_route_auth_invariants`:
 *
 * 1. **Roles imply actor.** `roles?.length` ⟹ `actor === 'required'`.
 *    Role checks read the actor's role_grants, so a role-gated spec without
 *    a resolved actor would have nothing to check.
 * 3. **No accountless actors yet.** `account === 'none' && actor !== 'none'`
 *    is invalid in v1. The credential resolver always binds account before
 *    actor today; agent-token / group-actor credentials will lift this.
 * 4. **Unrestricted is leaf.** `account === 'none' && actor === 'none'`
 *    ⟹ no `roles`, no `credential_types` (nothing left to gate). The same
 *    rule covers `required_scope`, but enforcing it needs the capability
 *    vocabulary from `auth/`, so it lives with the other `required_scope`
 *    check in `fuz_auth_guard_resolver`.
 *
 * Invariant 2 — the `actor !== 'none' ⟺ input or query declares
 * acting?: ActingActor` biconditional — needs introspection of the
 * spec's input/query schemas, so it is checked separately at registration.
 * See `assert_route_auth_acting_biconditional` below.
 */
export interface RouteAuth {
	account: AuthAxisState;
	actor: AuthAxisState;
	roles?: ReadonlyArray<string> | undefined;
	credential_types?: ReadonlyArray<string> | undefined;
	/**
	 * The capability a **narrowed** api token's scope must admit to reach this
	 * route, in the `<section>:<id>` vocabulary a denial reports back as
	 * `required_scope`:
	 *
	 * - `surface:<name>` — a non-RPC surface, refused to every narrowed token
	 *   whatever its method list says (token scoping's rule that a narrowed
	 *   token is RPC-only). `surface:audit_stream`, `surface:fact_bare`,
	 *   `surface:account_verify`, and `surface:app_surface` are the spine's
	 *   route-spec ones; a consumer names its own without registering it.
	 *
	 * The `rpc:<method>` arm of that vocabulary is the dispatcher's per-method
	 * gate, which a route never reaches, so a route may not declare it.
	 *
	 * Declaring it makes the guard resolver mount the refusal ahead of the role
	 * gate, instead of the route hand-rolling the check in its handler (which
	 * the auth phase has already role-gated by then, so a narrowed token whose
	 * account lacks the role would be told about the role rather than about the
	 * scope).
	 *
	 * Opt-in rather than blanket: no narrowed token reaches login (which reads
	 * no credential) or logout and the password change (session-only), the
	 * RPC endpoint runs its own per-method check inside the dispatcher, the
	 * `reads_credential` routes that answer anonymous callers (account status,
	 * the cell-scoped fact read) can't take the field and answer a narrowed
	 * token as anonymous in their handler (`get_public_account_id`), and the
	 * server-status route admits a narrowed token by design — and all are
	 * route specs too.
	 *
	 * Typed as a plain string here to keep `http/` from importing `auth/`; the
	 * resolver checks it at registration and throws on anything but a
	 * well-formed `surface:<name>`.
	 */
	required_scope?: string | undefined;
}

// --- Predicates over the flat-record shape ---
//
// Pure derived reads of `RouteAuth`. Live here so every consumer that
// branches on the shape (the dispatcher's authorization phase, route
// guards, `derive_route_errors`, `surface_query`, the surface explorer
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

/** True iff the route declares any role gate (`auth.roles?.length`). */
export const is_role_auth = (auth: RouteAuth): boolean => !!auth.roles?.length;

/** True iff the route declares any credential-type gate (`auth.credential_types?.length`). */
export const is_credential_gated_auth = (auth: RouteAuth): boolean =>
	!!auth.credential_types?.length;

/**
 * True iff the route is the keeper bucket — a credential gate admitting
 * `daemon_token`. Knows the literal directly, because keeper is a named
 * authority level rather than one channel among many: it is the ceiling
 * sessions and api tokens cannot reach.
 *
 * Narrower than `is_credential_gated_auth`, which is true of every channel
 * gate — including the session-only gates pointing the other way (the
 * credential-minting actions, `POST /logout` / `POST /password`, the audit
 * SSE stream). Reach for the general predicate when the question is "does a
 * channel gate answer here"; reach for this one only when the question is
 * about keeper specifically.
 */
export const is_keeper_auth = (auth: RouteAuth): boolean =>
	auth.credential_types?.includes('daemon_token') ?? false;

/**
 * True iff the route is plain authenticated — `account === 'required'`
 * with no role gate and no credential gate: any credential the auth
 * middleware resolved gets in.
 *
 * A channel gate takes a route out of this bucket, which is why the
 * account-grain routes one might expect here are not — `POST /logout`,
 * `POST /password`, and the `account_*` credential-lifecycle actions all
 * declare `credential_types: ['session']` and answer to
 * `is_credential_gated_auth` instead.
 */
export const is_plain_authenticated_auth = (auth: RouteAuth): boolean =>
	auth.account === 'required' && !is_role_auth(auth) && !is_credential_gated_auth(auth);

/**
 * Registry-time check of the cross-axis invariants 1, 3, and 4 (see
 * `RouteAuth`). Throws on violation, naming every invariant the shape breaks.
 *
 * Called by every dispatcher registration loop (`apply_route_specs`,
 * `compile_action_registry`) on every spec it accepts, so a spec that breaks
 * one fails at assembly rather than at its first request.
 *
 * @param auth - the route/action's auth shape
 * @param context - identifier for the throwing message (route key, RPC method, etc.)
 * @throws Error when any cross-axis invariant is violated
 */
export const assert_route_auth_invariants = (auth: RouteAuth, context: string): void => {
	const violations = route_auth_invariant_violations(auth);
	if (violations.length === 0) return;
	throw new Error(
		`${context}: ${violations.map((v) => v.message).join('; ')} (registry-time invariants)`
	);
};

// --- Registry-time invariant 2 enforcement ---
//
// The biconditional `auth.actor !== 'none' ⟺ input (or query, on REST
// GETs) declares acting?: ActingActor`. Checked apart from the cross-axis
// invariants because it introspects the spec's input/query schemas for
// reference equality with the canonical `ActingActor` schema above.
// Enforced at registration time by every dispatcher loop
// (`apply_route_specs`, `compile_action_registry` for `create_rpc_endpoint`
// + `register_action_ws`).

/**
 * Whether a schema declares the canonical `acting?: ActingActor` field.
 * Reference-equality on the exported `ActingActor` schema of the input's
 * library — the Zod one here, the fuz_schema twin in
 * `primitive_schemas_fuz.ts` — so consumer schemas with unrelated `acting`
 * fields don't trip this check, nor does either twin in the other library's
 * object.
 *
 * Peels through Zod wrappers (`optional`, `nullable`, `default`,
 * `transform`, `pipe`, `prefault`) via `zod_unwrap_to_object` so a spec
 * authored as `z.optional(z.strictObject({acting: ActingActor}))` or
 * `z.strictObject({acting: ActingActor}).default({})` still trips the
 * predicate.
 *
 * A `@fuzdev/fuz_schema` schema is read by `get_schema_entries`, which sees
 * through its wrappers (`optional`, `nullable`, the defaults) and a `pipe` to
 * the schema it starts with; a schema that isn't an object under them (a void
 * input, say) answers `false`.
 */
export const input_schema_declares_acting = (schema: ValidationSchema): boolean => {
	if (is_schema(schema)) return get_schema_entries(schema)?.acting === ActingActorFuz;
	const obj = zod_unwrap_to_object(schema as z.ZodType);
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
	input: ValidationSchema;
	query?: ValidationSchema;
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
	context: string
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
			} to declare 'acting?: ActingActor', the Zod one or its fuz_schema twin (registry-time invariant 2)`
		);
	}
	throw new Error(
		`${context}: ${
			slot_phrase
		} declares 'acting?: ActingActor' (Zod or fuz_schema) but auth.actor === 'none' (registry-time invariant 2)`
	);
};
