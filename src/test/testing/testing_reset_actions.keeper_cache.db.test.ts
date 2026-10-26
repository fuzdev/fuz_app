/**
 * `_testing_reset` points the daemon-token cache (`keeper_account_id`) at the
 * keeper it seeds only once its transaction commits. A reset that rolls back
 * after seeding — here an extra account reusing the keeper's username, or a
 * throwing `reset_state` — leaves the cache on the keeper still in the
 * database, so the next reset can still authenticate. And the consumer's
 * `reset_state` runs before the auth wipe, so a domain table with a
 * restricting FK to `actor` doesn't make every later reset fail.
 *
 * @module
 */

import { test, assert, beforeAll, afterAll, beforeEach } from 'vitest';

import {
	DAEMON_TOKEN_HEADER,
	generate_daemon_token,
	type DaemonTokenState
} from '#lib/auth/daemon_token.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_app_server } from '#lib/server/app_server.ts';
import {
	create_test_app_server,
	create_loopback_app_server_options
} from '#lib/testing/app_server.ts';
import { create_testing_actions } from '#lib/testing/cross_backend/testing_reset_actions.ts';
import { auth_truncate_tables } from '#lib/testing/db.ts';

import { default_db_factory } from '../db_fixture.ts';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';
const DAEMON_TOKEN = generate_daemon_token();

let db: Awaited<ReturnType<typeof default_db_factory.create>>;

beforeAll(async () => {
	db = await default_db_factory.create();
	// a consumer-shaped domain table: the FK restricts deletes (no `ON DELETE`)
	await db.query(
		'CREATE TABLE IF NOT EXISTS domain_row (id SERIAL PRIMARY KEY, actor_id UUID NOT NULL REFERENCES actor(id))'
	);
});

beforeEach(async () => {
	await db.query('DELETE FROM domain_row');
	for (const table of auth_truncate_tables) {
		await db.query(`TRUNCATE ${table} CASCADE`);
	}
});

afterAll(async () => {
	await default_db_factory.close(db);
});

const create_reset_server = async () => {
	const backend = await create_test_app_server({ session_options, db });
	const daemon_token_state: DaemonTokenState = {
		current_token: DAEMON_TOKEN,
		previous_token: null,
		rotated_at: new Date(),
		keeper_account_id: backend.account.id
	};
	const control = { fail_reset_state: false };
	const server = await create_app_server({
		...create_loopback_app_server_options(),
		backend,
		session_options,
		rate_limiters: 'disabled_for_testing',
		await_pending_effects: true,
		daemon_token_state,
		create_route_specs: () => [],
		rpc_endpoints: [
			{
				path: RPC_PATH,
				actions: create_testing_actions(backend.deps, {
					session_options,
					daemon_token_state,
					// the consumer-shaped domain wipe, on the reset's transaction
					reset_state: async (tx_db) => {
						if (control.fail_reset_state) throw new Error('reset_state failed');
						await tx_db.query('DELETE FROM domain_row');
					}
				})
			}
		]
	});
	const reset = (params: Record<string, unknown> = {}) =>
		server.app.request(RPC_PATH, {
			method: 'POST',
			headers: {
				host: 'localhost',
				'content-type': 'application/json',
				[DAEMON_TOKEN_HEADER]: DAEMON_TOKEN
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: '_testing_reset', params })
		});
	return { server, backend, daemon_token_state, control, reset };
};

test('a reset that rolls back leaves the cached keeper id unchanged', async () => {
	const { server, backend, daemon_token_state, control, reset } = await create_reset_server();
	const original_keeper_id = backend.account.id;
	const assert_original_keeper_kept = async () => {
		assert.strictEqual(
			daemon_token_state.keeper_account_id,
			original_keeper_id,
			'the cache still points at the keeper the rollback kept'
		);
		const rows = await db.query<{ id: string }>('SELECT id FROM account');
		assert.deepStrictEqual(
			rows.map((r) => r.id),
			[original_keeper_id],
			'the rollback kept the original keeper'
		);
	};
	try {
		// fails after the keeper is seeded: the extra reuses its username
		const duplicate = await reset({ extra_accounts: [{ username: 'keeper', roles: [] }] });
		// the reset ran and failed — not refused at the credential gate
		assert.strictEqual(duplicate.status, 500);
		await assert_original_keeper_kept();

		control.fail_reset_state = true;
		const failed = await reset();
		const failed_body = await failed.json();
		assert.strictEqual(failed.status, 500);
		assert.strictEqual(failed_body.error?.message, 'reset_state failed');
		await assert_original_keeper_kept();

		// the cache still authenticates, so the next reset goes through
		control.fail_reset_state = false;
		const succeeded = await reset();
		assert.strictEqual(succeeded.status, 200);
		const body = await succeeded.json();
		assert.ok(body.result, 'the next reset succeeds');
		assert.notStrictEqual(body.result.account.id, original_keeper_id);
		assert.strictEqual(
			daemon_token_state.keeper_account_id,
			body.result.account.id,
			'a committed reset caches the keeper it seeded'
		);
	} finally {
		await server.close();
	}
});

test('reset_state runs before the auth wipe', async () => {
	const { server, backend, reset } = await create_reset_server();
	try {
		// a domain row referencing the current keeper's actor through a restricting FK
		await db.query('INSERT INTO domain_row (actor_id) VALUES ($1)', [backend.actor.id]);
		const response = await reset();
		const body = await response.json();
		assert.strictEqual(response.status, 200, JSON.stringify(body));
		assert.ok(body.result, 'the domain wipe cleared the row before the actor delete');
		const rows = await db.query('SELECT id FROM domain_row');
		assert.strictEqual(rows.length, 0);
	} finally {
		await server.close();
	}
});
