/**
 * Tests for middleware/auth - auth middleware stack factory.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';

import {
	assert_credential_routes_in_auth_scope,
	create_auth_middleware_specs,
	type AuthMiddlewareOptions
} from '#lib/auth/middleware.ts';
import {
	account_status_route_shape,
	create_account_route_shapes
} from '#lib/auth/account_route_schema.ts';
import { create_signup_route_shape } from '#lib/auth/signup_route_schema.ts';
import { bootstrap_route_shape } from '#lib/auth/bootstrap_route_schema.ts';
import { create_health_route_spec } from '#lib/http/common_routes.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import type { MiddlewareCarveOut } from '#lib/http/middleware_spec.ts';
import { create_stub_app_deps } from '#lib/testing/stubs.ts';
import { create_serve_cell_fact_route_spec } from '#lib/server/serve_fact_route.ts';
import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { RESOLVED_AUTH_KEY } from '#lib/hono_context.ts';
import { get_resolved_auth } from '#lib/auth/resolved_auth.ts';
import { create_test_resolved_auth } from '#lib/testing/resolved_auth.ts';

const create_options = (overrides?: Partial<AuthMiddlewareOptions>): AuthMiddlewareOptions => ({
	allowed_origins: [],
	session_options: {
		cookie_name: 'test_session',
		context_key: 'session_identity',
		encode_identity: (id: string) => id,
		decode_identity: (payload: string) => payload
	},
	...overrides
});

describe('create_auth_middleware_specs', () => {
	test('returns 4 middleware specs by default', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options());
		assert.strictEqual(specs.length, 4);
	});

	test('middleware names are origin, session, request_context, bearer_auth', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options());
		const names = specs.map((s) => s.name);
		assert.deepStrictEqual(names, ['origin', 'session', 'request_context', 'bearer_auth']);
	});

	test('origin covers every path, the rest of the stack the default /api/* path', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options());
		for (const spec of specs) {
			assert.strictEqual(spec.path, spec.name === 'origin' ? '*' : '/api/*', spec.name);
		}
	});

	test('a custom path moves the stack, never the origin check', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options({ path: '/custom/*' }));
		for (const spec of specs) {
			assert.strictEqual(spec.path, spec.name === 'origin' ? '*' : '/custom/*', spec.name);
		}
	});

	test('origin carve-outs are recorded on the origin spec alone', async () => {
		const deps = create_stub_app_deps();
		const carve_outs = [{ path: '/hooks/*', reason: 'refuses browser callers itself' }];
		const specs = await create_auth_middleware_specs(
			deps,
			create_options({ origin_carve_outs: carve_outs })
		);
		for (const spec of specs) {
			assert.deepStrictEqual(spec.carve_outs, spec.name === 'origin' ? carve_outs : undefined);
		}
		const plain = await create_auth_middleware_specs(deps, create_options());
		assert.ok(plain.every((spec) => spec.carve_outs === undefined));
	});

	test('the carve-outs are copied at assembly, so a later mutation changes nothing', async () => {
		const deps = create_stub_app_deps();
		const hook: { path: string; reason: string } = {
			path: '/hooks/*',
			reason: 'refuses browser callers itself'
		};
		const carve_outs: Array<MiddlewareCarveOut> = [hook];
		const specs = await create_auth_middleware_specs(
			deps,
			create_options({
				allowed_origins: [/^https:\/\/app\.example$/],
				origin_carve_outs: carve_outs
			})
		);
		const origin = specs.find((spec) => spec.name === 'origin')!;
		// the caller widens its carve-outs after assembly, past the scope rule
		hook.path = '/api/*';
		carve_outs.push({ path: '/api/account/*', reason: 'added after assembly' });

		assert.deepStrictEqual(origin.carve_outs, [
			{ path: '/hooks/*', reason: 'refuses browser callers itself' }
		]);
		assert.ok(Object.isFrozen(origin.carve_outs));
		assert.ok(origin.carve_outs!.every((carve_out) => Object.isFrozen(carve_out)));

		const app = new Hono();
		app.use(origin.path, origin.handler);
		app.all('*', (c) => c.text('ok'));
		const status = async (path: string): Promise<number> =>
			(await app.request(path, { method: 'POST', headers: { origin: 'https://evil.example' } }))
				.status;
		assert.strictEqual(await status('/api/account/login'), 403);
		assert.strictEqual(await status('/api/rpc'), 403);
		assert.strictEqual(await status('/hooks/push'), 200);
	});

	test('a carve-out with no path or no reason is refused at assembly', async () => {
		const deps = create_stub_app_deps();
		for (const carve_out of [
			{ path: 'hooks/*', reason: 'refuses browser callers itself' },
			{ path: '/hooks/*', reason: '  ' }
		]) {
			let error: unknown;
			try {
				await create_auth_middleware_specs(
					deps,
					create_options({ origin_carve_outs: [carve_out] })
				);
			} catch (e) {
				error = e;
			}
			assert.ok(error instanceof Error, JSON.stringify(carve_out));
		}
	});

	test('mounts daemon_token first among the credential legs when daemon_token_state is provided', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(
			deps,
			create_options({
				daemon_token_state: {
					current_token: 'tok123',
					previous_token: null,
					rotated_at: new Date(),
					keeper_account_id: null
				}
			})
		);
		// the credential legs in the Rust spine's order: daemon token, then
		// session cookie, then bearer — the first that authenticates wins
		assert.deepStrictEqual(
			specs.map((s) => s.name),
			['origin', 'daemon_token', 'session', 'request_context', 'bearer_auth']
		);
	});

	test('daemon_token middleware uses the configured custom path', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(
			deps,
			create_options({
				path: '/custom/*',
				daemon_token_state: {
					current_token: 'tok',
					previous_token: null,
					rotated_at: new Date(),
					keeper_account_id: null
				}
			})
		);
		const daemon = specs.find((s) => s.name === 'daemon_token');
		assert.ok(daemon);
		assert.strictEqual(daemon.path, '/custom/*');
	});

	test('origin middleware has 403 error schema', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options());
		const origin = specs.find((s) => s.name === 'origin')!;
		assert.ok(origin.errors);
		assert.ok(origin.errors[403]);
	});

	test('bearer_auth middleware declares no errors (soft-fails on every path)', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options());
		const bearer = specs.find((s) => s.name === 'bearer_auth')!;
		assert.ok(bearer.errors);
		// The layer returns no status of its own: invalid tokens soft-fail to "no
		// credential" and it carries no rate limiter, so not even a 429. Auth
		// enforcement happens downstream (check_action_auth / require_auth).
		assert.strictEqual(Object.keys(bearer.errors).length, 0);
	});

	test('session and request_context have no error schemas', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options());
		const session = specs.find((s) => s.name === 'session')!;
		const rc = specs.find((s) => s.name === 'request_context')!;
		assert.strictEqual(session.errors, undefined);
		assert.strictEqual(rc.errors, undefined);
	});

	test('daemon_token middleware declares no error schemas (soft-fails through)', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(
			deps,
			create_options({
				daemon_token_state: {
					current_token: 'tok',
					previous_token: null,
					rotated_at: new Date(),
					keeper_account_id: null
				}
			})
		);
		const dt = specs.find((s) => s.name === 'daemon_token')!;
		// The middleware soft-fails (discards) on every non-success path — browser
		// context, malformed/invalid token, and no-keeper all `next()` through to
		// the dispatcher's credential gate — so it returns no error response of its
		// own and declares none.
		assert.ok(dt.errors);
		assert.strictEqual(Object.keys(dt.errors).length, 0);
	});

	test('all specs have handler functions', async () => {
		const deps = create_stub_app_deps();
		const specs = await create_auth_middleware_specs(deps, create_options());
		for (const spec of specs) {
			assert.strictEqual(typeof spec.handler, 'function');
		}
	});
});

describe('create_auth_middleware_specs — the chain starts from a clean slate', () => {
	for (const with_daemon_token of [true, false]) {
		test(`a credential set before the stack is cleared (daemon_token: ${with_daemon_token})`, async () => {
			const specs = await create_auth_middleware_specs(
				create_stub_app_deps(),
				create_options(
					with_daemon_token
						? {
								daemon_token_state: {
									current_token: 'tok123',
									previous_token: null,
									rotated_at: new Date(),
									keeper_account_id: null
								}
							}
						: undefined
				)
			);
			const app = new Hono();
			// a layer mounted before the credential legs pre-setting an identity,
			// which every leg would otherwise see as resolved and skip past
			app.use('/*', async (c, next) => {
				c.set(
					RESOLVED_AUTH_KEY,
					create_test_resolved_auth({ credential_type: 'daemon_token', account_id: 'acct-preset' })
				);
				await next();
			});
			for (const spec of specs) app.use(spec.path, spec.handler);
			app.get('/api/test', (c) => c.json({ resolved: get_resolved_auth(c) }));

			const res = await app.request('/api/test');
			assert.strictEqual(res.status, 200);
			assert.strictEqual((await res.json()).resolved, null);
		});
	}
});

describe('assert_credential_routes_in_auth_scope', () => {
	const route = (path: string, extra?: Partial<RouteSpec>): RouteSpec => ({
		...create_health_route_spec(),
		path,
		...extra
	});

	test('passes public routes anywhere and credentialed ones under the scope', () => {
		assert_credential_routes_in_auth_scope([
			route('/health'),
			route('/hooks/push'),
			route('/api/account/login', { mints_credential: true }),
			route('/api/me', { auth: { account: 'required', actor: 'none' } }),
			route('/api', { auth: { account: 'optional', actor: 'none' } })
		]);
	});

	test('refuses a minting route outside the scope', () => {
		assert.throws(
			() =>
				assert_credential_routes_in_auth_scope([route('/auth/login', { mints_credential: true })]),
			/route GET \/auth\/login mints a credential but is outside the auth middleware's scope/
		);
	});

	test('refuses a reading route outside the scope, optional account included', () => {
		for (const account of ['required', 'optional'] as const) {
			assert.throws(
				() =>
					assert_credential_routes_in_auth_scope([
						route('/apix/me', { auth: { account, actor: 'none' } })
					]),
				/route GET \/apix\/me reads a credential/
			);
		}
	});

	test('refuses a route marked reads_credential outside the scope', () => {
		assert.throws(
			() => assert_credential_routes_in_auth_scope([route('/status', { reads_credential: true })]),
			/route GET \/status reads a credential but is outside the auth middleware's scope/
		);
		assert_credential_routes_in_auth_scope([route('/api/status', { reads_credential: true })]);
	});

	// account status declares no gate (its handler answers an anonymous caller
	// with its own 401) but reads the resolved account
	test('the account status shape is marked as reading', () => {
		assert.strictEqual(account_status_route_shape.auth.account, 'none');
		assert.isTrue(account_status_route_shape.reads_credential);
	});

	// both declare no auth gate and answer an anonymous caller themselves, so
	// the flag alone holds them in the scope: off `/api` they would read every
	// caller as anonymous
	test('the cell-scoped fact read is marked as reading, and refused off /api', () => {
		const spec = create_serve_cell_fact_route_spec({
			facts_dir: '/tmp/facts',
			log: new Logger('test', { level: 'off' })
		});
		assert.strictEqual(spec.auth.account, 'none');
		assert.isTrue(spec.reads_credential);
		assert_credential_routes_in_auth_scope([spec]);
		assert.throws(
			() =>
				assert_credential_routes_in_auth_scope([{ ...spec, path: '/cells/:cell_id/facts/:hash' }]),
			/route GET \/cells\/:cell_id\/facts\/:hash reads a credential/
		);
	});

	test('the JSON-RPC endpoint pair is marked as reading, and refused off /api', () => {
		const log = new Logger('test', { level: 'off' });
		const in_scope = create_rpc_endpoint({
			path: '/api/rpc',
			actions: [],
			log,
			action_ip_rate_limiter: null,
			action_account_rate_limiter: null
		});
		assert.strictEqual(in_scope.length, 2);
		for (const spec of in_scope) {
			assert.strictEqual(spec.auth.account, 'none');
			assert.isTrue(spec.reads_credential, `${spec.method} ${spec.path}`);
		}
		assert_credential_routes_in_auth_scope(in_scope);
		// a consumer mounting the pair through `create_route_specs` at a bare path
		const off_api = create_rpc_endpoint({
			path: '/rpc',
			actions: [],
			log,
			action_ip_rate_limiter: null,
			action_account_rate_limiter: null
		});
		for (const spec of off_api) {
			assert.throws(
				() => assert_credential_routes_in_auth_scope([spec]),
				new RegExp(`route ${spec.method} /rpc reads a credential`)
			);
		}
	});

	// the flag is what holds a relative, consumer-prefixed spec in the scope
	test('the login, signup, and bootstrap shapes are marked as minting', () => {
		const [, login] = create_account_route_shapes({ login_account_rate_limited: false });
		assert.isTrue(login.mints_credential);
		assert.isTrue(
			create_signup_route_shape({ signup_account_rate_limited: false }).mints_credential
		);
		assert.isTrue(bootstrap_route_shape.mints_credential);
	});
});
