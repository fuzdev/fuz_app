import './assert_dev_env.ts';

/**
 * Auth test app factories for adversarial testing.
 *
 * Creates Hono test apps at each auth level (public, authenticated, keeper,
 * per-role) for use in adversarial auth enforcement and input validation tests.
 *
 * @module
 */

import {Hono} from 'hono';
import {Logger} from '@fuzdev/fuz_util/log.ts';

import {apply_route_specs, type RouteSpec} from '../http/route_spec.ts';
import {is_public_auth, type RouteAuth} from '../http/auth_shape.ts';
import {fuz_auth_guard_resolver} from '../auth/auth_guard_resolver.ts';
import {
	REQUEST_CONTEXT_KEY,
	create_fuz_authorization_handler,
	type RequestContext,
} from '../auth/request_context.ts';
import {
	ACCOUNT_ID_KEY,
	CREDENTIAL_TYPE_KEY,
	TEST_CONTEXT_PRESET_KEY,
	type CredentialType,
} from '../hono_context.ts';
import {create_stub_db} from './stubs.ts';
import {create_test_account, create_test_actor, create_test_role_grant} from './entities.ts';

/**
 * Create a mock `RequestContext` with optional role role_grant.
 */
export const create_test_request_context = (role?: string): RequestContext => ({
	account: create_test_account({id: 'acc_1', username: 'testuser'}),
	actor: create_test_actor({id: 'act_1', account_id: 'acc_1', name: 'testuser'}),
	role_grants: role ? [create_test_role_grant({id: 'perm_1', actor_id: 'act_1', role})] : [],
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
	credential_type?: CredentialType,
): Hono => {
	const app = new Hono();
	const db = create_stub_db();
	app.use('/*', async (c, next) => {
		c.set('pending_effects', []);
		c.set('post_commit_effects', []);
		if (auth_ctx) {
			c.set(ACCOUNT_ID_KEY, auth_ctx.account.id);
			c.set(REQUEST_CONTEXT_KEY, auth_ctx);
			c.set(CREDENTIAL_TYPE_KEY, credential_type ?? 'session');
			c.set(TEST_CONTEXT_PRESET_KEY, true);
		}
		await next();
	});
	apply_route_specs(
		app,
		route_specs,
		fuz_auth_guard_resolver,
		new Logger('test', {level: 'off'}),
		db,
		create_fuz_authorization_handler({db}),
	);
	return app;
};

/** Pre-built Hono apps for each auth level, shared across adversarial test suites. */
export interface AuthTestApps {
	public: Hono;
	authed: Hono;
	keeper: Hono;
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
	roles: Array<string>,
): AuthTestApps => {
	const by_role = new Map<string, Hono>();
	for (const role of roles) {
		by_role.set(role, create_test_app_from_specs(route_specs, create_test_request_context(role)));
	}
	return {
		public: create_test_app_from_specs(route_specs),
		authed: create_test_app_from_specs(route_specs, create_test_request_context()),
		keeper: create_test_app_from_specs(
			route_specs,
			create_test_request_context('keeper'),
			'daemon_token',
		),
		by_role,
	};
};

/**
 * Select the Hono test app with correct auth for a route.
 *
 * @throws Error if `auth.roles` names a role not present in `apps.by_role` —
 *   surfaces a missing entry in the `roles` array passed to
 *   `create_auth_test_apps`.
 */
export const select_auth_app = (apps: AuthTestApps, auth: RouteAuth): Hono => {
	if (is_public_auth(auth)) return apps.public;
	if (auth.credential_types?.includes('daemon_token')) return apps.keeper;
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

/** Replace Hono route params (`:foo`) with dummy values for HTTP testing. */
export const resolve_test_path = (path: string): string => path.replace(/:(\w+)/g, 'test_$1');
