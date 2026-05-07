import './assert_dev_env.js';

/**
 * Auth test app factories for adversarial testing.
 *
 * Creates Hono test apps at each auth level (public, authenticated, keeper,
 * per-role) for use in adversarial auth enforcement and input validation tests.
 *
 * @module
 */

import {Hono} from 'hono';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {apply_route_specs, type RouteSpec, type RouteAuth} from '../http/route_spec.js';
import {fuz_auth_guard_resolver} from '../auth/route_guards.js';
import {
	REQUEST_CONTEXT_KEY,
	create_fuz_authorization_handler,
	type RequestContext,
} from '../auth/request_context.js';
import {
	ACCOUNT_ID_KEY,
	CREDENTIAL_TYPE_KEY,
	TEST_CONTEXT_PRESET_KEY,
	type CredentialType,
} from '../hono_context.js';
import {create_stub_db} from './stubs.js';
import {create_test_account, create_test_actor, create_test_permit} from './entities.js';

/**
 * Create a mock `RequestContext` with optional role permit.
 */
export const create_test_request_context = (role?: string): RequestContext => ({
	account: create_test_account({id: 'acc_1', username: 'testuser'}),
	actor: create_test_actor({id: 'act_1', account_id: 'acc_1', name: 'testuser'}),
	permits: role ? [create_test_permit({id: 'perm_1', actor_id: 'act_1', role})] : [],
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
		if (auth_ctx) {
			(c as any).set(ACCOUNT_ID_KEY, auth_ctx.account.id);
			(c as any).set(REQUEST_CONTEXT_KEY, auth_ctx);
			(c as any).set(CREDENTIAL_TYPE_KEY, credential_type ?? 'session');
			(c as any).set(TEST_CONTEXT_PRESET_KEY, true);
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
 * @throws Error if `auth.type === 'role'` and `auth.role` is not present in
 *   `apps.by_role` — surfaces a missing entry in the `roles` array passed to
 *   `create_auth_test_apps`.
 */
export const select_auth_app = (apps: AuthTestApps, auth: RouteAuth): Hono => {
	switch (auth.type) {
		case 'none':
			return apps.public;
		case 'authenticated':
			return apps.authed;
		case 'keeper':
			return apps.keeper;
		case 'role': {
			const app = apps.by_role.get(auth.role);
			if (!app) throw new Error(`No test app for role '${auth.role}' — is it in the roles array?`);
			return app;
		}
	}
};

/** Replace Hono route params (`:foo`) with dummy values for HTTP testing. */
export const resolve_test_path = (path: string): string => path.replace(/:(\w+)/g, 'test_$1');
