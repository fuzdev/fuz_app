/**
 * Auth guard resolver for the route spec system.
 *
 * Maps the five-axis `RouteAuth` (`account` / `actor` / `roles` /
 * `credential_types` / `required_scope`) to two-phase middleware sets that
 * `apply_route_specs` weaves into the per-route pipeline:
 *
 * - `pre_authorization` runs before the authorization phase, and holds every
 *   gate that reads only what the auth middleware already set: `require_auth`
 *   whenever `auth.account === 'required'` or `auth.actor === 'required'`
 *   (per registry-time invariant 3, `actor: 'required'` today implies a
 *   credential — accountless actors are out of scope for v1),
 *   `require_credential_types(types)` whenever `auth.credential_types?.length`,
 *   and the token-scope guard whenever `auth.required_scope` names a capability.
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
	require_token_scope
} from './request_context.ts';
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
 * - `required_scope` → pre-authorization `require_token_scope(capability)`
 * - `roles?.length` → post-authorization `require_role(roles)` (multi-role any-of)
 *
 * Guards run in declaration order, which is the coarse-to-fine order above:
 * presence first (an anonymous caller holds neither a credential type nor a
 * scope to check), then the channel, then the scope, then the role — the last
 * being the only one that needs the resolved `RequestContext`.
 *
 * @throws Error if `auth.required_scope` is not a well-formed capability string
 *   (via `require_token_scope`) — `RouteAuth` types it as a plain string to keep
 *   `http/` free of an `auth/` import, so this is where the value is checked.
 *   The check is on *shape*, not membership: the vocabulary is deliberately open
 *   so a consumer can name its own surface, and a `surface:` name decides
 *   nothing (rule 3 is all-or-nothing), so the closed set would only have been
 *   a spelling check on a diagnostic string. fuz_app's own declarations are
 *   pinned to the surfaces it actually mounts by the surface census.
 * @throws Error if `auth.required_scope` sits on an unrestricted route
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
	if (auth.required_scope !== undefined) {
		if (is_public_auth(auth)) {
			throw new Error(
				`auth.required_scope "${auth.required_scope}" on an unrestricted route (account: 'none', actor: 'none') — the same holder reaches it by dropping the credential, so the guard would enforce nothing. Gate the route on a credential, or drop the field.`
			);
		}
		pre_authorization.push(require_token_scope(auth.required_scope));
	}
	if (auth.roles?.length) {
		post_authorization.push(require_role(auth.roles));
	}

	return { pre_authorization, post_authorization };
};
