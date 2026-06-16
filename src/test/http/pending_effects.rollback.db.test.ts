/**
 * Rollback discards `post_commit_effects`; eager `pending_effects` survive.
 *
 * The deferred-effect contract: a handler that queues a post-commit effect via
 * `emit_after_commit` and then throws rolls back its transaction, so those
 * effects must NOT fire — they'd announce state that never committed (a WS
 * notification for a role grant the DB never persisted, etc.). The eager
 * `pending_effects` queue is the opposite: its pool writes (attempt audits)
 * run outside the transaction and intentionally survive rollback.
 *
 * This pins both halves through a real PGlite transaction across both dispatch
 * sites: the action dispatcher (`actions/perform_action.ts`, the RPC/WS path —
 * where every production `emit_after_commit` caller lives) and the REST route
 * wrapper (`http/route_spec.ts`). It also proves the underlying row rolled back.
 *
 * This is the Rust→TS convergence of the `fuz_actions`
 * `post_commit_effects_clear_discards_without_running` contract: the Rust spine
 * discards on rollback; this brings the TS twin to parity. See
 * docs/security.md §Post-commit effects.
 *
 * @module
 */

import {test, assert} from 'vitest';
import {z} from 'zod';
import {Logger} from '@fuzdev/fuz_util/log.ts';

import {create_session_config} from '$lib/auth/session_cookie.ts';
import {create_test_app} from '$lib/testing/app_server.ts';
import {
	create_pglite_factory,
	create_describe_db,
	auth_integration_truncate_tables,
} from '$lib/testing/db.ts';
import {run_migrations} from '$lib/db/migrate.ts';
import {auth_migration_ns} from '$lib/auth/migrations.ts';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.ts';
import {emit_after_commit} from '$lib/http/pending_effects.ts';
import {get_route_input, type RouteSpec} from '$lib/http/route_spec.ts';
import {rpc_action} from '$lib/actions/action_rpc.ts';
import type {RequestResponseActionSpec} from '$lib/actions/action_spec.ts';
import type {AppServerContext} from '$lib/server/app_server_context.ts';
import type {Db} from '$lib/db/db.ts';

const session_options = create_session_config('test_session');
const log = new Logger('rollback_probe_test', {level: 'off'});
const RPC_PATH = '/api/rpc';
const REST_PATH = '/test/rollback_probe';

const factory = create_pglite_factory(async (db) => {
	await run_migrations(db, [auth_migration_ns]);
	await db.query('CREATE TABLE IF NOT EXISTS rollback_probe (token text primary key)');
});
const describe_db = create_describe_db(factory, auth_integration_truncate_tables);

let token_counter = 0;
const next_token = (): string => `tok_${++token_counter}`;

/** Shared input/output schemas — the RPC action and the REST route mount the same probe. */
const probe_input = z.strictObject({fail: z.boolean(), token: z.string()});
const probe_output = z.strictObject({ok: z.literal(true)});

/** Public, side-effecting probe action: write a row, queue both effect kinds, throw iff `fail`. */
const probe_action_spec = {
	method: 'rollback_probe',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'none', actor: 'none'},
	side_effects: true,
	input: probe_input,
	output: probe_output,
	async: true,
	description: 'Test probe: queues a post-commit effect + an eager effect, optionally throws.',
} as const satisfies RequestResponseActionSpec;

/** Sinks the queued effects push into, so a test can observe which fired. */
interface Sinks {
	eager: Array<string>;
	deferred: Array<string>;
}

const count_probe_rows = async (db: Db, token: string): Promise<number> => {
	const rows = await db.query<{count: string}>(
		'SELECT count(*)::text AS count FROM rollback_probe WHERE token = $1',
		[token],
	);
	return Number(rows[0]?.count ?? '0');
};

/**
 * Stand up a test app mounting the probe as both an RPC action and a REST
 * route, each closing over its own fresh sinks.
 */
const setup = async (get_db: () => Db) => {
	const rpc_sinks: Sinks = {eager: [], deferred: []};
	const rest_sinks: Sinks = {eager: [], deferred: []};

	const create_route_specs = (_ctx: AppServerContext): Array<RouteSpec> => [
		{
			method: 'POST',
			path: REST_PATH,
			auth: {account: 'none', actor: 'none'},
			input: probe_input,
			output: probe_output,
			description: 'Test probe REST route.',
			handler: async (c, route) => {
				const {fail, token} = get_route_input(c, probe_input);
				await route.db.query('INSERT INTO rollback_probe (token) VALUES ($1)', [token]);
				// Eager: in-flight pool-style write — must survive rollback.
				route.pending_effects.push(
					Promise.resolve().then(() => {
						rest_sinks.eager.push(token);
					}),
				);
				// Deferred: post-commit thunk — must be discarded on rollback.
				emit_after_commit({log, post_commit_effects: route.post_commit_effects}, () => {
					rest_sinks.deferred.push(token);
				});
				if (fail) throw new Error('intentional REST probe failure (rollback)');
				return c.json({ok: true});
			},
		},
	];

	const probe_rpc_action = rpc_action(probe_action_spec, async (input, ctx) => {
		await ctx.db.query('INSERT INTO rollback_probe (token) VALUES ($1)', [input.token]);
		ctx.pending_effects.push(
			Promise.resolve().then(() => {
				rpc_sinks.eager.push(input.token);
			}),
		);
		emit_after_commit(ctx, () => {
			rpc_sinks.deferred.push(input.token);
		});
		if (input.fail) throw new Error('intentional RPC probe failure (rollback)');
		return {ok: true};
	});

	const test_app = await create_test_app({
		session_options,
		db: get_db(),
		create_route_specs,
		rpc_endpoints: [{path: RPC_PATH, actions: [probe_rpc_action]}],
	});

	return {test_app, rpc_sinks, rest_sinks};
};

describe_db('post_commit_effects rollback discard (RPC dispatch / perform_action)', (get_db) => {
	test('rollback discards the deferred effect; the eager effect + nothing else survives', async () => {
		const {test_app, rpc_sinks} = await setup(get_db);
		const token = next_token();

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: probe_action_spec,
			params: {fail: true, token},
		});

		assert.strictEqual(res.ok, false, 'the failing handler returns an error');
		// Deferred post-commit effect discarded — the contract under test.
		assert.deepStrictEqual(rpc_sinks.deferred, [], 'post-commit effect must NOT fire on rollback');
		// Eager pending effect survived (runs outside the transaction).
		assert.deepStrictEqual(rpc_sinks.eager, [token], 'eager pending effect must survive rollback');
		// The handler's row rolled back with the transaction.
		assert.strictEqual(
			await count_probe_rows(test_app.backend.deps.db, token),
			0,
			'the handler INSERT must roll back',
		);

		await test_app.cleanup();
	});

	test('success fires the deferred effect and commits the row', async () => {
		const {test_app, rpc_sinks} = await setup(get_db);
		const token = next_token();

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: probe_action_spec,
			params: {fail: false, token},
		});

		assert.strictEqual(res.ok, true);
		assert.deepStrictEqual(rpc_sinks.deferred, [token], 'post-commit effect fires on commit');
		assert.deepStrictEqual(rpc_sinks.eager, [token], 'eager effect fires on commit too');
		assert.strictEqual(await count_probe_rows(test_app.backend.deps.db, token), 1, 'row committed');

		await test_app.cleanup();
	});
});

describe_db('post_commit_effects rollback discard (REST dispatch / route_spec)', (get_db) => {
	test('rollback discards the deferred effect; the eager effect survives', async () => {
		const {test_app, rest_sinks} = await setup(get_db);
		const token = next_token();

		const response = await test_app.app.request(REST_PATH, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({fail: true, token}),
		});

		assert.strictEqual(response.status, 500, 'the thrown handler maps to a 500');
		assert.deepStrictEqual(rest_sinks.deferred, [], 'post-commit effect must NOT fire on rollback');
		assert.deepStrictEqual(rest_sinks.eager, [token], 'eager pending effect must survive rollback');
		assert.strictEqual(
			await count_probe_rows(test_app.backend.deps.db, token),
			0,
			'the handler INSERT must roll back',
		);

		await test_app.cleanup();
	});

	test('success fires the deferred effect and commits the row', async () => {
		const {test_app, rest_sinks} = await setup(get_db);
		const token = next_token();

		const response = await test_app.app.request(REST_PATH, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({fail: false, token}),
		});

		assert.strictEqual(response.status, 200);
		assert.deepStrictEqual(rest_sinks.deferred, [token], 'post-commit effect fires on commit');
		assert.deepStrictEqual(rest_sinks.eager, [token], 'eager effect fires on commit too');
		assert.strictEqual(await count_probe_rows(test_app.backend.deps.db, token), 1, 'row committed');

		await test_app.cleanup();
	});
});
