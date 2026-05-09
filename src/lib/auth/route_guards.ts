/**
 * Auth guard resolver for the route spec system under the new flat-record
 * `RouteAuth` shape.
 *
 * Maps the four-axis auth (`account` / `actor` / `roles` /
 * `credential_types`) to two-phase middleware sets that
 * `apply_route_specs` weaves into the per-route pipeline:
 *
 * - `pre_validation` runs before input validation. `require_auth` lands
 *   here whenever `auth.account === 'required'` or `auth.actor ===
 *   'required'` (per registry-time invariant 3, `actor: 'required'`
 *   today implies a credential — accountless actors are out of scope
 *   for v1). Pre-validation 401 fires before any body parsing so
 *   unauthenticated callers never see route-shape information from
 *   parse failures.
 * - `post_authorization` runs after the dispatcher's authorization
 *   phase has populated `RequestContext`. `require_role(roles)` fires
 *   whenever `auth.roles?.length`. `require_credential_types(types)`
 *   fires whenever `auth.credential_types?.length`.
 *
 * Public routes (`auth.account === 'none' && auth.actor === 'none'`)
 * yield empty guard arrays. `'optional'` axes contribute no
 * pre-validation 401; the authorization phase sets `RequestContext`
 * to whatever the credential supports and the post-authorization
 * gates decide whether the actor's role_grants / credential type match.
 *
 * @module
 */

import {
	input_schema_declares_acting,
	require_auth,
	require_credential_types,
	require_role,
} from './request_context.js';
import type {AuthGuardResolver, RouteSpec, RouteSpecValidator} from '../http/route_spec.js';
import {needs_actor} from '../http/auth_shape.js';

/**
 * Standard auth guard resolver for fuz_app.
 *
 * Reads each axis of the four-axis `RouteAuth` shape and emits the
 * corresponding middleware:
 *
 * - `account === 'required'` or `actor === 'required'` → pre-validation `require_auth`
 * - `roles?.length` → post-authorization `require_role(roles)` (multi-role any-of)
 * - `credential_types?.length` → post-authorization `require_credential_types(types)`
 *
 * Multiple post-authorization guards run in declaration order: credential
 * type check first (since failing it implies the request can never
 * resolve a usable identity), role check second.
 */
export const fuz_auth_guard_resolver: AuthGuardResolver = (auth) => {
	const pre_validation = [];
	const post_authorization = [];

	if (auth.account === 'required' || auth.actor === 'required') {
		pre_validation.push(require_auth);
	}
	if (auth.credential_types?.length) {
		post_authorization.push(require_credential_types(auth.credential_types));
	}
	if (auth.roles?.length) {
		post_authorization.push(require_role(auth.roles));
	}

	return {pre_validation, post_authorization};
};

/**
 * Standard registry-time validator for fuz_app route specs. Pass to
 * `apply_route_specs` as `validate_spec` to enforce the auth-shape
 * biconditional `auth.actor !== 'none' ⟺ input or query declares
 * acting?: ActingActor` on every REST route — same invariant the
 * action-dispatcher registries (`compile_action_registry`) already
 * enforce on RPC + WS.
 *
 * REST is bi-located: GETs declare `acting` on `query`, mutations on
 * `input`. The authorization phase reads from either
 * (`validated_query.acting` falls through to `validated_input.acting`),
 * so the validator accepts a declaration on either schema. Action
 * specs have only `input`, so the dispatcher-side biconditional in
 * `compile_action_registry` stays single-schema.
 *
 * Lives in this module rather than `http/` because the underlying
 * `input_schema_declares_acting` does reference-equality against the
 * `ActingActor` schema in `auth/account_schema.ts` — keeping it
 * auth-side preserves the http/ → auth/ no-dep direction.
 */
export const fuz_validate_route_spec: RouteSpecValidator = (spec: RouteSpec): void => {
	const wants_actor = needs_actor(spec.auth);
	const declares_acting =
		input_schema_declares_acting(spec.input) ||
		(spec.query !== undefined && input_schema_declares_acting(spec.query));
	const context = `Route "${spec.method} ${spec.path}"`;
	if (wants_actor && !declares_acting) {
		throw new Error(
			`${context}: auth.actor === '${spec.auth.actor}' requires the input or query schema to declare 'acting?: ActingActor' (registry-time invariant 2)`,
		);
	}
	if (!wants_actor && declares_acting) {
		throw new Error(
			`${context}: input or query declares 'acting?: ActingActor' but auth.actor === 'none' (registry-time invariant 2)`,
		);
	}
};
