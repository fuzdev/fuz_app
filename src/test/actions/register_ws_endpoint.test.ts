/**
 * Tests for `register_ws_endpoint` — the composed upgrade stack (origin +
 * auth + optional role) wrapping `register_action_ws`.
 *
 * Drives the endpoint via `app.fetch()` so the actual pre-upgrade middleware
 * chain is exercised. Rejection cases (bad origin, missing auth, wrong role)
 * never reach the dispatcher — `create_stub_upgrade` stays inert because
 * those paths return early. The pass-through case asserts that the stub's
 * `createEvents` factory was reached (no pre-upgrade rejection).
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {Hono} from 'hono';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {register_ws_endpoint} from '$lib/actions/register_ws_endpoint.js';
import type {BaseHandlerContext} from '$lib/actions/register_action_ws.js';
import {heartbeat_action} from '$lib/actions/heartbeat.js';
import {parse_allowed_origins} from '$lib/http/origin.js';
import {REQUEST_CONTEXT_KEY} from '$lib/auth/request_context.js';
import {ROLE_ADMIN, type RoleName} from '$lib/auth/role_schema.js';
import {ACCOUNT_ID_KEY, CREDENTIAL_TYPE_KEY, TEST_CONTEXT_PRESET_KEY} from '$lib/hono_context.js';
import {create_stub_upgrade} from '$lib/testing/ws_round_trip.js';
import {create_stub_db} from '$lib/testing/stubs.js';
import {create_test_request_context} from '$lib/testing/auth_apps.js';

const log = new Logger('test', {level: 'off'});

const ALLOWED_ORIGIN = 'http://localhost:3000';

interface BuildOptions {
	required_role?: RoleName;
	role?: RoleName;
	authenticated?: boolean;
}

/**
 * Inject a request context upstream of `register_ws_endpoint` to simulate
 * what fuz_app's session middleware populates in production. The endpoint
 * itself only wires origin + require_auth + require_role + register_action_ws,
 * so we need this shim to drive `require_auth` / `require_role` decisions.
 */
const build_app = (opts: BuildOptions = {}) => {
	const {required_role, role, authenticated = true} = opts;
	const app = new Hono();

	app.use('*', async (c, next) => {
		if (authenticated) {
			const ctx = create_test_request_context(role);
			c.set(REQUEST_CONTEXT_KEY, ctx);
			c.set(ACCOUNT_ID_KEY, ctx.account.id);
			c.set(CREDENTIAL_TYPE_KEY, 'session');
			c.set(TEST_CONTEXT_PRESET_KEY, true);
		}
		await next();
	});

	const stub = create_stub_upgrade();

	register_ws_endpoint<BaseHandlerContext>({
		path: '/api/ws',
		app,
		upgradeWebSocket: stub.upgradeWebSocket,
		actions: [heartbeat_action],
		extend_context: (base) => base,
		allowed_origins: parse_allowed_origins(ALLOWED_ORIGIN),
		db: create_stub_db(),
		required_role,
		log,
	});

	return {app, stub};
};

describe('origin verification', () => {
	test('rejects disallowed origin with 403', async () => {
		const {app} = build_app();
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: {Origin: 'http://evil.example'},
			}),
		);
		assert.strictEqual(res.status, 403);
	});

	test('missing-origin passes through (direct access — curl/CLI)', async () => {
		const {app, stub} = build_app();
		const res = await app.fetch(new Request('http://localhost:3000/api/ws'));
		// verify_request_source is permissive for no-origin requests (token
		// auth is the primary control there); downstream require_auth still
		// ran and accepted our injected session context.
		assert.notStrictEqual(res.status, 401);
		assert.notStrictEqual(res.status, 403);
		assert.strictEqual(typeof stub.get_create_events(), 'function');
	});
});

describe('authentication', () => {
	test('rejects unauthenticated request with 401', async () => {
		const {app} = build_app({authenticated: false});
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: {Origin: ALLOWED_ORIGIN},
			}),
		);
		assert.strictEqual(res.status, 401);
	});
});

describe('required_role', () => {
	test('rejects authenticated request missing the role with 403', async () => {
		const {app} = build_app({required_role: ROLE_ADMIN});
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: {Origin: ALLOWED_ORIGIN},
			}),
		);
		assert.strictEqual(res.status, 403);
	});

	test('passes through when the authenticated account has the role', async () => {
		const {app, stub} = build_app({required_role: ROLE_ADMIN, role: ROLE_ADMIN});
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: {Origin: ALLOWED_ORIGIN},
			}),
		);

		// Pre-upgrade chain passed — stub `upgradeWebSocket` factory ran.
		// The stub returns an inert middleware that falls through to a 404
		// since it can't perform the actual upgrade in Node.
		assert.notStrictEqual(res.status, 401);
		assert.notStrictEqual(res.status, 403);
		assert.strictEqual(typeof stub.get_create_events(), 'function');
	});

	test('omitting required_role only gates on authentication', async () => {
		const {app, stub} = build_app();
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: {Origin: ALLOWED_ORIGIN},
			}),
		);

		assert.notStrictEqual(res.status, 401);
		assert.notStrictEqual(res.status, 403);
		assert.strictEqual(typeof stub.get_create_events(), 'function');
	});
});

describe('composition', () => {
	test('middleware order: origin is checked before auth', async () => {
		// A bad origin on an authenticated request still returns 403 from the
		// origin middleware — proving verify_request_source runs first.
		const {app} = build_app();
		const res = await app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: {Origin: 'http://evil.example'},
			}),
		);
		assert.strictEqual(res.status, 403);
	});

	test('returns the transport from register_action_ws', () => {
		const app = new Hono();
		const stub = create_stub_upgrade();

		const result = register_ws_endpoint<BaseHandlerContext>({
			path: '/api/ws',
			app,
			upgradeWebSocket: stub.upgradeWebSocket,
			actions: [heartbeat_action],
			extend_context: (base) => base,
			allowed_origins: parse_allowed_origins(ALLOWED_ORIGIN),
			db: create_stub_db(),
			log,
		});

		assert.ok(result.transport);
	});
});
