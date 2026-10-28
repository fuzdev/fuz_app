/**
 * The `?acting=` query selector on the two surfaces that read it off the raw
 * query string: `GET /status` (the persona picker) and the WS upgrade.
 *
 * Both go through `parse_acting`, the `ActingActor` schema every other
 * selector passes: an id in any case resolves its actor (the schema
 * lowercases it). A malformed value reads as omitted on the upgrade; on the
 * status route it is a missing persona — account-only, the persona picker's
 * answer, never a default-actor resolve, as on the Rust spine.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { Hono } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_test_app } from '#lib/testing/app_server.ts';
import { query_create_actor } from '#lib/auth/account_queries.ts';
import { create_account_status_route_spec } from '#lib/auth/account_routes.ts';
import { REQUEST_CONTEXT_KEY } from '#lib/auth/request_context.ts';
import { register_action_ws } from '#lib/actions/register_action_ws.ts';
import { heartbeat_action } from '#lib/actions/heartbeat.ts';
import { parse_allowed_origins } from '#lib/http/origin.ts';
import { ACCOUNT_ID_KEY, CREDENTIAL_TYPE_KEY } from '#lib/hono_context.ts';
import { create_stub_upgrade } from '#lib/testing/ws_round_trip.ts';
import { ERROR_ACTOR_REQUIRED } from '#lib/http/error_schemas.ts';
import type { Db } from '#lib/db/db.ts';

import { describe_db } from '../auth_db_default.ts';

const session_options = create_session_config('test_session');
const STATUS_PATH = '/api/account/status';
const ALLOWED_ORIGIN = 'http://localhost:3000';
const log = new Logger('test', { level: 'off' });

const create_route_specs = () => [create_account_status_route_spec({ path: STATUS_PATH })];

/**
 * A WS endpoint over the real database, behind a shim that authenticates
 * `account_id` the way the session middleware would — so the upgrade's
 * authorization phase resolves the acting actor for real.
 */
const build_ws_app = (db: Db, account_id: string) => {
	const app = new Hono();
	app.use('*', async (c, next) => {
		c.set(ACCOUNT_ID_KEY, account_id);
		c.set(CREDENTIAL_TYPE_KEY, 'session');
		await next();
	});
	const stub = create_stub_upgrade();
	const parsed = parse_allowed_origins(ALLOWED_ORIGIN);
	if (!parsed.ok) throw new Error('invalid allowlist');
	register_action_ws({
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		path: '/api/ws',
		connection_closer: null,
		app,
		upgradeWebSocket: stub.upgradeWebSocket,
		actions: [heartbeat_action],
		allowed_origins: parsed.origins,
		db,
		log
	});
	return { app, stub };
};

const upgrade = (app: Hono, query: string): Promise<Response> =>
	Promise.resolve(
		app.fetch(
			new Request(`${ALLOWED_ORIGIN}/api/ws${query}`, {
				headers: { Origin: ALLOWED_ORIGIN, Upgrade: 'websocket' }
			})
		)
	);

describe_db('the ?acting= query selector', (get_db) => {
	describe('GET /status', () => {
		test('an uppercased acting id resolves its actor', async () => {
			const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
			const second = await query_create_actor(
				{ db: get_db() },
				test_app.backend.account.id,
				'second_persona'
			);
			const res = await test_app.app.request(`${STATUS_PATH}?acting=${second.id.toUpperCase()}`, {
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.strictEqual(body.actor?.id, second.id);
		});

		test('a malformed acting reads as omitted: account-only on a multi-actor account', async () => {
			const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
			await query_create_actor({ db: get_db() }, test_app.backend.account.id, 'second_persona');
			const res = await test_app.app.request(`${STATUS_PATH}?acting=not-a-uuid`, {
				headers: test_app.create_session_headers()
			});
			assert.strictEqual(res.status, 200);
			const body = await res.json();
			assert.strictEqual(body.account.id, test_app.backend.account.id);
			assert.strictEqual(body.actor, null);
		});

		test('a malformed acting answers account-only on a single-actor account too', async () => {
			// no default-actor resolve: without a selector this account resolves its one actor
			const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
			for (const acting of ['not-a-uuid', '']) {
				const res = await test_app.app.request(`${STATUS_PATH}?acting=${acting}`, {
					headers: test_app.create_session_headers()
				});
				assert.strictEqual(res.status, 200);
				const body = await res.json();
				assert.strictEqual(body.account.id, test_app.backend.account.id);
				assert.strictEqual(body.actor, null, `?acting=${acting}`);
			}
			const omitted = await test_app.app.request(STATUS_PATH, {
				headers: test_app.create_session_headers()
			});
			assert.strictEqual((await omitted.json()).actor?.id, test_app.backend.actor.id);
		});
	});

	describe('the WS upgrade', () => {
		test('an uppercased acting id resolves its actor', async () => {
			const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
			const second = await query_create_actor(
				{ db: get_db() },
				test_app.backend.account.id,
				'second_persona'
			);
			const { app, stub } = build_ws_app(get_db(), test_app.backend.account.id);
			const res = await upgrade(app, `?acting=${second.id.toUpperCase()}`);
			assert.strictEqual(res.status, 200, await res.clone().text());
			assert.strictEqual(stub.upgrades.length, 1);
			const ctx = stub.upgrades[0]!.c.get(REQUEST_CONTEXT_KEY)!;
			assert.strictEqual(ctx.actor?.id, second.id);
		});

		test('a malformed acting reads as omitted', async () => {
			const test_app = await create_test_app({ session_options, create_route_specs, db: get_db() });
			// single-actor: resolves without a selector, so the upgrade goes ahead
			const single = build_ws_app(get_db(), test_app.backend.account.id);
			const res = await upgrade(single.app, '?acting=not-a-uuid');
			assert.strictEqual(res.status, 200, await res.clone().text());
			const ctx = single.stub.upgrades[0]!.c.get(REQUEST_CONTEXT_KEY)!;
			assert.strictEqual(ctx.actor?.id, test_app.backend.actor.id);
			// multi-actor: no selector is `actor_required`
			await query_create_actor({ db: get_db() }, test_app.backend.account.id, 'second_persona');
			const multi = build_ws_app(get_db(), test_app.backend.account.id);
			const refused = await upgrade(multi.app, '?acting=not-a-uuid');
			assert.strictEqual(refused.status, 400);
			assert.strictEqual((await refused.json()).error, ERROR_ACTOR_REQUIRED);
			assert.strictEqual(multi.stub.upgrades.length, 0);
		});
	});
});
