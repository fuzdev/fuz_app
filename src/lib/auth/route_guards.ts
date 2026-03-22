/**
 * Auth guard resolver for the route spec system.
 *
 * Maps `RouteAuth` discriminants to auth middleware handlers.
 * Injected into `apply_route_specs` to decouple the generic HTTP
 * framework (`route_spec.ts`) from auth-specific middleware.
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
 * - `authenticated` → `require_auth`
 * - `role` → `require_role(role)`
 * - `keeper` → `require_keeper`
 */
export const fuz_auth_guard_resolver: AuthGuardResolver = (auth) => {
	switch (auth.type) {
		case 'none':
			return [];
		case 'authenticated':
			return [require_auth];
		case 'role':
			return [require_role(auth.role)];
		case 'keeper':
			return [require_keeper];
	}
};
