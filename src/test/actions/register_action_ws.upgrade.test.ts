/**
 * Tests for `register_action_ws`'s upgrade route — the guard chain (origin,
 * auth, token scope, acting actor, optional role) ahead of the upgrade.
 *
 * Drives the endpoint via `app.fetch()` so the actual pre-upgrade middleware
 * chain is exercised. Rejection cases (bad origin, missing auth, wrong role)
 * never reach the dispatcher — `create_stub_upgrade` stays inert because
 * those paths return early. The pass-through case asserts that the stub's
 * `createEvents` factory was reached (no pre-upgrade rejection).
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Hono } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { register_action_ws } from '#lib/actions/register_action_ws.ts';
import { heartbeat_action } from '#lib/actions/heartbeat.ts';
import { parse_allowed_origins } from '#lib/http/origin.ts';
import { REQUEST_CONTEXT_KEY } from '#lib/auth/request_context.ts';
import { ROLE_ADMIN, type RoleName } from '#lib/auth/role_schema.ts';
import { RESOLVED_AUTH_KEY, TEST_CONTEXT_PRESET_KEY } from '#lib/hono_context.ts';
import { create_test_resolved_auth } from '#lib/testing/resolved_auth.ts';
import { token_scope_denied_body, token_scope_methods } from '#lib/auth/token_scope.ts';
import { create_stub_upgrade } from '#lib/testing/ws_round_trip.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';
import { create_test_request_context } from '#lib/testing/auth_apps.ts';

/** Parse an allowlist the test knows is valid. */
const parse_origins = (raw: string): Array<RegExp> => {
	const result = parse_allowed_origins(raw);
	if (!result.ok) throw new Error(`invalid allowlist: ${raw}`);
	return result.origins;
};

const log = new Logger('test', { level: 'off' });

const ALLOWED_ORIGIN = 'http://localhost:3000';

interface BuildOptions {
	required_roles?: ReadonlyArray<RoleName>;
	role?: RoleName;
	authenticated?: boolean;
	/** Narrow the caller's credential to these RPC methods. */
	scoped_methods?: Array<string>;
}

/**
 * Inject a request context upstream of the endpoint to simulate what
 * fuz_app's session middleware populates in production, to drive the route's
 * `require_auth` / token-scope / `require_role` decisions.
 */
const build_app = (opts: BuildOptions = {}) => {
	const { required_roles, role, authenticated = true, scoped_methods } = opts;
	const app = new Hono();

	app.use('*', async (c, next) => {
		if (authenticated) {
			const ctx = create_test_request_context(role);
			c.set(REQUEST_CONTEXT_KEY, ctx);
			// a scope belongs to an API token alone
			c.set(
				RESOLVED_AUTH_KEY,
				scoped_methods
					? create_test_resolved_auth({
							credential_type: 'api_token',
							account_id: ctx.account.id,
							scope: token_scope_methods(scoped_methods)
						})
					: create_test_resolved_auth({ credential_type: 'session', account_id: ctx.account.id })
			);
			c.set(TEST_CONTEXT_PRESET_KEY, true);
		}
		await next();
	});

	const stub = create_stub_upgrade();

	const stub_db = create_stub_db();
	register_action_ws({
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: '/api/ws',
		connection_closer: null,
		app,
		upgradeWebSocket: stub.upgradeWebSocket,
		actions: [heartbeat_action],
		allowed_origins: parse_origins(ALLOWED_ORIGIN),
		db: stub_db,
		required_roles,
		log
	});

	return { app, stub };
};

describe('origin verification', () => {
	test('rejects disallowed origin with 403', async () => {
		const { app } = build_app();
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: { Origin: 'http://evil.example' }
			})
		);
		assert.strictEqual(res.status, 403);
	});

	test('missing-origin passes through (direct access — curl/CLI)', async () => {
		const { app, stub } = build_app();
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', { headers: { Upgrade: 'websocket' } })
		);
		// verify_request_source is permissive for no-origin requests (token
		// auth is the primary control there); downstream require_auth still
		// ran and accepted our injected session context.
		assert.notStrictEqual(res.status, 401);
		assert.notStrictEqual(res.status, 403);
		assert.strictEqual(stub.upgrades.length, 1);
	});
});

describe('authentication', () => {
	test('rejects unauthenticated request with 401', async () => {
		const { app } = build_app({ authenticated: false });
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: { Origin: ALLOWED_ORIGIN, Upgrade: 'websocket' }
			})
		);
		assert.strictEqual(res.status, 401);
	});
});

describe('required_roles', () => {
	test('rejects authenticated request missing the role with 403', async () => {
		const { app } = build_app({ required_roles: [ROLE_ADMIN] });
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: { Origin: ALLOWED_ORIGIN, Upgrade: 'websocket' }
			})
		);
		assert.strictEqual(res.status, 403);
	});

	test('passes through when the authenticated account has the role', async () => {
		const { app, stub } = build_app({ required_roles: [ROLE_ADMIN], role: ROLE_ADMIN });
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: { Origin: ALLOWED_ORIGIN, Upgrade: 'websocket' }
			})
		);

		// Pre-upgrade chain passed — the stub recorded the upgrade.
		assert.notStrictEqual(res.status, 401);
		assert.notStrictEqual(res.status, 403);
		assert.strictEqual(stub.upgrades.length, 1);
	});

	test('omitting required_roles only gates on authentication', async () => {
		const { app, stub } = build_app();
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: { Origin: ALLOWED_ORIGIN, Upgrade: 'websocket' }
			})
		);

		assert.notStrictEqual(res.status, 401);
		assert.notStrictEqual(res.status, 403);
		assert.strictEqual(stub.upgrades.length, 1);
	});

	test('empty required_roles array skips the role gate', async () => {
		// `[]` is the same as undefined — gate is skipped. Documents the
		// "empty is opt-out" branch on the rename so it doesn't regress.
		const { app, stub } = build_app({ required_roles: [] });
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: { Origin: ALLOWED_ORIGIN, Upgrade: 'websocket' }
			})
		);

		assert.notStrictEqual(res.status, 401);
		assert.notStrictEqual(res.status, 403);
		assert.strictEqual(stub.upgrades.length, 1);
	});
});

describe('composition', () => {
	test('middleware order: origin is checked before auth', async () => {
		// A bad origin on an authenticated request still returns 403 from the
		// origin middleware — proving verify_request_source runs first.
		const { app } = build_app();
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: { Origin: 'http://evil.example' }
			})
		);
		assert.strictEqual(res.status, 403);
	});

	test('returns the transport', () => {
		const app = new Hono();
		const stub = create_stub_upgrade();

		const stub_db = create_stub_db();
		const result = register_action_ws({
			action_ip_rate_limiter: null,
			action_account_rate_limiter: null,
			path: '/api/ws',
			connection_closer: null,
			app,
			upgradeWebSocket: stub.upgradeWebSocket,
			actions: [heartbeat_action],
			allowed_origins: parse_origins(ALLOWED_ORIGIN),
			db: stub_db,
			log
		});

		assert.ok(result.registry);
	});
});

describe('token scope', () => {
	test('a narrowed token is refused the upgrade with the surface denial', async () => {
		const { app, stub } = build_app({ scoped_methods: ['heartbeat'] });
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: { Origin: ALLOWED_ORIGIN, Upgrade: 'websocket' }
			})
		);
		assert.strictEqual(res.status, 403);
		assert.deepStrictEqual(await res.json(), token_scope_denied_body('surface:ws_upgrade'));
		assert.strictEqual(stub.upgrades.length, 0);
	});

	test('the scope is decided before the role gate', async () => {
		const { app } = build_app({ required_roles: [ROLE_ADMIN], scoped_methods: ['heartbeat'] });
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: { Origin: ALLOWED_ORIGIN, Upgrade: 'websocket' }
			})
		);
		assert.strictEqual(res.status, 403);
		assert.deepStrictEqual(
			await res.json(),
			token_scope_denied_body('surface:ws_upgrade'),
			'a narrowed token lacking the role hears about its scope, not the role'
		);
	});
});

describe('one route', () => {
	/**
	 * The guards ride the `GET` route rather than an `app.use` on the path, so a
	 * method the endpoint never serves is Hono's 404 — not a 401 or 403 from a
	 * guard that ran for nothing.
	 */
	test('a method other than GET on the path is a 404', async () => {
		for (const authenticated of [true, false]) {
			const { app, stub } = build_app({ authenticated, required_roles: [ROLE_ADMIN] });
			for (const method of ['POST', 'PUT', 'DELETE']) {
				const res = await app.fetch(
					new Request('http://localhost:3000/api/ws', {
						method,
						headers: { Origin: ALLOWED_ORIGIN, Upgrade: 'websocket' }
					})
				);
				assert.strictEqual(res.status, 404, `${method} (authenticated: ${authenticated})`);
			}
			assert.strictEqual(stub.upgrades.length, 0);
		}
	});

	/**
	 * Hono serves `HEAD` through the `GET` route, so a `HEAD` runs the same
	 * guards — an anonymous one is the 401, an allowed one never upgrades.
	 */
	test('HEAD on the path runs the GET route guards', async () => {
		const { app, stub } = build_app({ authenticated: false });
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				method: 'HEAD',
				headers: { Origin: ALLOWED_ORIGIN, Upgrade: 'websocket' }
			})
		);
		assert.strictEqual(res.status, 401);
		assert.strictEqual(stub.upgrades.length, 0);
	});

	/**
	 * The `acting` selector is read off the query by `parse_acting` with no
	 * query schema on the route, so a malformed one never turns an anonymous
	 * upgrade into a 400 that describes the route — it reaches `require_auth`.
	 */
	test('an anonymous upgrade with a malformed acting selector is a 401', async () => {
		const { app } = build_app({ authenticated: false });
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws?acting=garbage', {
				headers: { Origin: ALLOWED_ORIGIN, Upgrade: 'websocket' }
			})
		);
		assert.strictEqual(res.status, 401);
	});
});
