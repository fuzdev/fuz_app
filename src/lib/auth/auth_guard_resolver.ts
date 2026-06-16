/**
 * Auth guard resolver for the route spec system.
 *
 * Maps the four-axis `RouteAuth` (`account` / `actor` / `roles` /
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

import {require_auth, require_credential_types, require_role} from './request_context.ts';
import type {AuthGuardResolver} from '../http/route_spec.ts';

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
