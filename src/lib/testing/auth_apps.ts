import './assert_dev_env.ts';

/**
 * Auth test app factories for adversarial testing.
 *
 * Creates Hono test apps at each auth level (public, authenticated, keeper,
 * per-role) for use in adversarial auth enforcement and input validation tests.
 *
 * @module
 */

import { Hono } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { apply_route_specs, type RouteSpec } from '../http/route_spec.ts';
import { is_public_auth, type RouteAuth } from '../http/auth_shape.ts';
import {
	CREDENTIAL_TYPE_DAEMON_TOKEN,
	CREDENTIAL_TYPE_SESSION
} from '../auth/credential_type_schema.ts';
import { ROLE_KEEPER } from '../auth/role_schema.ts';
import { fuz_auth_guard_resolver } from '../auth/auth_guard_resolver.ts';
import {
	REQUEST_CONTEXT_KEY,
	create_fuz_authorization_handler,
	type RequestContext
} from '../auth/request_context.ts';
import {
	ACCOUNT_ID_KEY,
	CREDENTIAL_TYPES,
	CREDENTIAL_TYPE_KEY,
	TEST_CONTEXT_PRESET_KEY,
	type CredentialType
} from '../hono_context.ts';
import { create_stub_db } from './stubs.ts';
import { create_test_account, create_test_actor, create_test_role_grant } from './entities.ts';

/**
 * Create a mock `RequestContext` with optional role role_grant.
 */
export const create_test_request_context = (role?: string): RequestContext => ({
	account: create_test_account({ id: 'acc_1', username: 'testuser' }),
	actor: create_test_actor({ id: 'act_1', account_id: 'acc_1', name: 'testuser' }),
	role_grants: role ? [create_test_role_grant({ id: 'perm_1', actor_id: 'act_1', role })] : []
});

/**
 * Create a Hono test app from route specs with optional auth context.
 *
 * @param route_specs - the route specs to register
 * @param auth_ctx - optional request context to inject via middleware
 * @param credential_type - optional credential type (default: `'session'` when `auth_ctx` provided)
 */
export const create_test_app_from_specs = (
	route_specs: Array<RouteSpec>,
	auth_ctx?: RequestContext,
	credential_type?: CredentialType
): Hono => {
	const app = new Hono();
	const db = create_stub_db();
	app.use('/*', async (c, next) => {
		c.set('pending_effects', []);
		c.set('post_commit_effects', []);
		if (auth_ctx) {
			c.set(ACCOUNT_ID_KEY, auth_ctx.account.id);
			c.set(REQUEST_CONTEXT_KEY, auth_ctx);
			c.set(CREDENTIAL_TYPE_KEY, credential_type ?? CREDENTIAL_TYPE_SESSION);
			c.set(TEST_CONTEXT_PRESET_KEY, true);
		}
		await next();
	});
	apply_route_specs(
		app,
		route_specs,
		fuz_auth_guard_resolver,
		new Logger('test', { level: 'off' }),
		db,
		create_fuz_authorization_handler({ db })
	);
	return app;
};

/** Pre-built Hono apps for each auth level, shared across adversarial test suites. */
export interface AuthTestApps {
	public: Hono;
	authed: Hono;
	keeper: Hono;
	/**
	 * One authenticated app per builtin credential type, each holding the
	 * keeper role — the channel axis, where `by_role` is the authority axis.
	 *
	 * A credential gate is pre-authorization, so probing it needs an app on a
	 * channel the route refuses, and proving a gated route still works needs
	 * one on a channel it admits. `keeper` is the `'daemon_token'` entry of
	 * this map, not a second app.
	 */
	by_credential_type: Map<CredentialType, Hono>;
	by_role: Map<string, Hono>;
}

/**
 * Create one Hono test app per auth level.
 *
 * @param route_specs - the route specs to register
 * @param roles - all roles in the app
 */
export const create_auth_test_apps = (
	route_specs: Array<RouteSpec>,
	roles: Array<string>
): AuthTestApps => {
	const by_role = new Map<string, Hono>();
	for (const role of roles) {
		by_role.set(role, create_test_app_from_specs(route_specs, create_test_request_context(role)));
	}
	const by_credential_type = new Map<CredentialType, Hono>(
		CREDENTIAL_TYPES.map((credential_type) => [
			credential_type,
			create_test_app_from_specs(
				route_specs,
				create_test_request_context(ROLE_KEEPER),
				credential_type
			)
		])
	);
	return {
		public: create_test_app_from_specs(route_specs),
		authed: create_test_app_from_specs(route_specs, create_test_request_context()),
		keeper: by_credential_type.get(CREDENTIAL_TYPE_DAEMON_TOKEN)!,
		by_credential_type,
		by_role
	};
};

/**
 * Select the Hono test app with correct auth for a route.
 *
 * The credential channel is decided first, because the channel gate is
 * pre-authorization: an app whose credential the route refuses never reaches
 * the role gate, so a role-correct app on the wrong channel answers
 * `credential_type_required`, and a "correct auth passes guard" case reads it
 * as a failure of the role gate that never ran.
 *
 * A gate admitting `'session'` falls through to the `by_role` /
 * `authed` apps, which carry that channel. Any other gate leaves the
 * `by_credential_type` app as the only candidate — those hold the keeper
 * role, which is why a route pairing a non-session channel with some *other*
 * role has no app and says so.
 *
 * @throws Error if `auth.roles` names a role not present in `apps.by_role` —
 *   surfaces a missing entry in the `roles` array passed to
 *   `create_auth_test_apps`.
 * @throws Error if the route pairs a non-session channel with a role the
 *   channel apps don't hold. Silently handing back a session app would turn
 *   every case on the route into a misattributed 403.
 */
export const select_auth_app = (apps: AuthTestApps, auth: RouteAuth): Hono => {
	if (is_public_auth(auth)) return apps.public;
	const credential_types = auth.credential_types;
	if (credential_types?.length && !credential_types.includes(CREDENTIAL_TYPE_SESSION)) {
		const channel = CREDENTIAL_TYPES.find((t) => credential_types.includes(t));
		const app = channel === undefined ? undefined : apps.by_credential_type.get(channel);
		const roles = auth.roles;
		if (app && (!roles?.length || roles.includes(ROLE_KEEPER))) return app;
		throw new Error(
			`No test app for credential types '${credential_types.join("', '")}'${
				roles?.length ? ` with roles '${roles.join("', '")}'` : ''
			} — the channel apps hold the '${ROLE_KEEPER}' role, and only the session channel has per-role apps`
		);
	}
	if (auth.roles?.length) {
		// Multi-role disjunction: any of the named roles admits the caller.
		// Tests pick the first role's app; consumers wanting per-role coverage
		// should hit each role's app explicitly.
		const role = auth.roles[0]!;
		const app = apps.by_role.get(role);
		if (!app) throw new Error(`No test app for role '${role}' — is it in the roles array?`);
		return app;
	}
	return apps.authed;
};

/**
 * Build the skip predicate an adversarial suite applies from its
 * `skip_routes` option — routes named in `'METHOD /path'` form, the surface
 * key. `undefined` skips nothing.
 */
export const create_route_skip_filter = (
	skip_routes: Array<string> | undefined
): ((route: { method: string; path: string }) => boolean) => {
	const skip_set = new Set(skip_routes);
	return (route) => skip_set.has(`${route.method} ${route.path}`);
};
