/**
 * Auth guard resolver for the route spec system.
 *
 * Maps the five-axis `RouteAuth` (`account` / `actor` / `roles` /
 * `credential_types` / `token_surface`) to two-phase middleware sets that
 * `apply_route_specs` weaves into the per-route pipeline:
 *
 * - `pre_authorization` runs before the authorization phase, and holds every
 *   gate that reads only what the auth middleware already set: `require_auth`
 *   whenever `auth.account === 'required'` or `auth.actor === 'required'`
 *   (per registry-time invariant 3, `actor: 'required'` today implies a
 *   credential — accountless actors are out of scope for v1),
 *   `require_credential_types(types)` whenever `auth.credential_types?.length`,
 *   and the rule-3 scope guard whenever `auth.token_surface` names a surface.
 *   All three fire before any body parsing, so a caller they refuse never sees
 *   route-shape information — and before the authorization phase, so a wrong
 *   channel costs no actor resolution.
 * - `post_authorization` runs after the dispatcher's authorization phase has
 *   populated `RequestContext`, and holds the one gate that needs it:
 *   `require_role(roles)`, whenever `auth.roles?.length`, reads
 *   `c.var.request_context.role_grants`.
 *
 * The resulting order — credential presence, then credential type, then scope,
 * then role — is the spine's canonical coarse-to-fine ordering, the same one
 * `check_action_auth_post_authorization` runs for actions. A route declaring
 * both a credential gate and a surface gate therefore answers with the
 * coarser fact ("this channel may never call me") rather than the finer one
 * ("your token is scoped"), on both dispatch surfaces alike.
 *
 * Public routes (`auth.account === 'none' && auth.actor === 'none'`)
 * yield empty guard arrays. `'optional'` axes contribute no
 * pre-authorization 401; the authorization phase sets `RequestContext`
 * to whatever the credential supports and the post-authorization
 * gates decide whether the actor's role_grants / credential type match.
 *
 * @module
 */

import {
	require_auth,
	require_credential_types,
	require_role,
	require_token_surface
} from './request_context.ts';
import { is_token_surface, TOKEN_SURFACE_CAPABILITIES } from './token_scope.ts';
import { is_public_auth } from '../http/auth_shape.ts';
import type { AuthGuardResolver } from '../http/route_spec.ts';

/**
 * Standard auth guard resolver for fuz_app.
 *
 * Reads each axis of the `RouteAuth` shape and emits the corresponding
 * middleware:
 *
 * - `account === 'required'` or `actor === 'required'` → pre-authorization `require_auth`
 * - `credential_types?.length` → pre-authorization `require_credential_types(types)`
 * - `token_surface` → pre-authorization `require_token_surface(surface)` (rule 3)
 * - `roles?.length` → post-authorization `require_role(roles)` (multi-role any-of)
 *
 * Guards run in declaration order, which is the coarse-to-fine order above:
 * presence first (an anonymous caller holds neither a credential type nor a
 * scope to check), then the channel, then the scope, then the role — the last
 * being the only one that needs the resolved `RequestContext`.
 *
 * @throws Error if `auth.token_surface` names a surface that doesn't exist —
 *   `RouteAuth` types it as a plain string to keep `http/` free of an `auth/`
 *   import, so this is where the value is checked. A typo would otherwise
 *   mount a guard that denies with an undefined capability string.
 * @throws Error if `auth.token_surface` sits on an unrestricted route
 *   (`account: 'none' && actor: 'none'`). The same holder reaches that route
 *   by dropping the credential, so the guard reads as a control and enforces
 *   nothing — the shape `compile_action_registry` refuses on an `ActionSpec`
 *   for the same reason. Extends `RouteAuth`'s leaf invariant, which the
 *   route pipeline never parses.
 */
export const fuz_auth_guard_resolver: AuthGuardResolver = (auth) => {
	const pre_authorization = [];
	const post_authorization = [];

	if (auth.account === 'required' || auth.actor === 'required') {
		pre_authorization.push(require_auth);
	}
	if (auth.credential_types?.length) {
		pre_authorization.push(require_credential_types(auth.credential_types));
	}
	if (auth.token_surface !== undefined) {
		if (!is_token_surface(auth.token_surface)) {
			throw new Error(
				`auth.token_surface "${auth.token_surface}" is not a known token surface — expected one of ${Object.keys(TOKEN_SURFACE_CAPABILITIES).join(', ')}`
			);
		}
		if (is_public_auth(auth)) {
			throw new Error(
				`auth.token_surface "${auth.token_surface}" on an unrestricted route (account: 'none', actor: 'none') — the same holder reaches it by dropping the credential, so the guard would enforce nothing. Gate the route on a credential, or drop the field.`
			);
		}
		pre_authorization.push(require_token_surface(auth.token_surface));
	}
	if (auth.roles?.length) {
		post_authorization.push(require_role(auth.roles));
	}

	return { pre_authorization, post_authorization };
};
