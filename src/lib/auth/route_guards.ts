/**
 * Auth guard resolver for the route spec system.
 *
 * Maps `RouteAuth` discriminants to two-phase auth middleware sets.
 * `pre_validation` carries the 401 check (`require_auth`) so
 * unauthenticated callers never see route-shape information from input
 * parse failures. `post_authorization` carries the 403 role / keeper
 * checks because they read the `RequestContext` populated by the
 * dispatcher's authorization phase.
 *
 * Injected into `apply_route_specs` to decouple the generic HTTP
 * framework (`http/route_spec.ts`) from auth-specific middleware.
 *
 * @module
 */

import {require_auth, require_role} from './request_context.js';
import {require_keeper} from './require_keeper.js';
import type {AuthGuardResolver} from '../http/route_spec.js';

/**
 * Standard auth guard resolver for fuz_app.
 *
 * Maps `RouteAuth` to middleware:
 * - `none` → no guards
 * - `authenticated` → pre-validation `require_auth`
 * - `role` → pre-validation `require_auth` + post-authorization `require_role(role)`
 * - `keeper` → pre-validation `require_auth` + post-authorization `require_keeper`
 */
export const fuz_auth_guard_resolver: AuthGuardResolver = (auth) => {
	switch (auth.type) {
		case 'none':
			return {pre_validation: [], post_authorization: []};
		case 'authenticated':
			return {pre_validation: [require_auth], post_authorization: []};
		case 'role':
			return {pre_validation: [require_auth], post_authorization: [require_role(auth.role)]};
		case 'keeper':
			return {pre_validation: [require_auth], post_authorization: [require_keeper]};
	}
};
