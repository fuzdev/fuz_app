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
import {REQUEST_CONTEXT_KEY, type RequestContext} from '../auth/request_context.js';
import {CREDENTIAL_TYPE_KEY, type CredentialType} from '../hono_context.js';
import {create_stub_db} from './stubs.js';

/**
 * Create a mock request context with optional role permit.
 *
 * @param role - optional role to grant
 * @returns a valid `RequestContext`
 */
export const create_test_request_context = (role?: string): RequestContext => ({
	account: {
		id: 'acc_1',
		username: 'testuser',
		password_hash: 'hash',
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		created_by: null,
		updated_by: null,
		email: null,
		email_verified: false,
	},
	actor: {
		id: 'act_1',
		account_id: 'acc_1',
		name: 'testuser',
		created_at: new Date().toISOString(),
		updated_at: null,
		updated_by: null,
	},
	permits: role
		? [
				{
					id: 'perm_1',
					actor_id: 'act_1',
					role,
					created_at: new Date().toISOString(),
					expires_at: null,
					revoked_at: null,
					revoked_by: null,
					granted_by: null,
				},
			]
		: [],
});

/**
 * Create a Hono test app from route specs with optional auth context.
 *
 * @param route_specs - the route specs to register
 * @param auth_ctx - optional request context to inject via middleware
 * @param credential_type - optional credential type (default: `'session'` when auth_ctx provided)
 * @returns a configured Hono app
 */
export const create_test_app_from_specs = (
	route_specs: Array<RouteSpec>,
	auth_ctx?: RequestContext,
	credential_type?: CredentialType,
): Hono => {
	const app = new Hono();
	app.use('/*', async (c, next) => {
		c.set('pending_effects', []);
		if (auth_ctx) {
			(c as any).set(REQUEST_CONTEXT_KEY, auth_ctx);
			(c as any).set(CREDENTIAL_TYPE_KEY, credential_type ?? 'session');
		}
		await next();
	});
	apply_route_specs(
		app,
		route_specs,
		fuz_auth_guard_resolver,
		new Logger('test', {level: 'off'}),
		create_stub_db(),
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
 * @returns apps keyed by auth level
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
 * @param apps - the pre-built auth test apps
 * @param auth - the route's auth options
 * @returns the correctly-authenticated Hono app
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
