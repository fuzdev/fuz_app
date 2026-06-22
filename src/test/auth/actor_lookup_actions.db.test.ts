/**
 * Integration tests for the `actor_lookup` RPC action — wire-shape
 * semantics specific to this handler.
 *
 * Adversarial input + auth gates are covered by the generic suites in
 * ./actor_lookup_actions.rpc_suites.db.test.ts. This file pins the
 * handler-specific contracts: `display_name` omitted (not `null`) when
 * `actor.name` is blank, unknown ids absent from the response, and the
 * `ACTOR_LOOKUP_IDS_MAX` regression guard.
 *
 * @module
 */

import {test, assert} from 'vitest';
import {create_uuid} from '@fuzdev/fuz_util/id.ts';

import {create_session_config} from '$lib/auth/session_cookie.ts';
import {create_test_app} from '$lib/testing/app_server.ts';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.ts';
import {create_actor_lookup_actions} from '$lib/auth/actor_lookup_actions.ts';
import {
	ACTOR_LOOKUP_IDS_MAX,
	actor_lookup_action_spec,
} from '$lib/auth/actor_lookup_action_specs.ts';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.ts';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.ts';
import {
	create_pglite_factory,
	create_describe_db,
	auth_integration_truncate_tables,
} from '$lib/testing/db.ts';
import {run_migrations} from '$lib/db/migrate.ts';
import {auth_migration_ns} from '$lib/auth/migrations.ts';
import type {Db} from '$lib/db/db.ts';
import type {AppServerContext} from '$lib/server/app_server_context.ts';
import type {RouteSpec} from '$lib/http/route_spec.ts';

const session_options = create_session_config('test_actor_lookup');
const RPC_PATH = '/api/rpc';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [auth_migration_ns]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, auth_integration_truncate_tables);

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_actor_lookup_actions({log: ctx.deps.log}),
		log: ctx.deps.log,
	}),
];

describe_db('actor_lookup_actions', (get_db) => {
	test('ACTOR_LOOKUP_IDS_MAX regression guard — bumping requires re-deriving the enumeration threat model', () => {
		assert.strictEqual(ACTOR_LOOKUP_IDS_MAX, 50);
	});

	test('happy path resolves a batch with id + username + display_name', async () => {
		const test_app = await create_test_app({
			session_options,
			create_route_specs,
			db: get_db(),
		});
		const caller = await test_app.create_account({username: 'caller'});
		const alice = await test_app.create_account({username: 'alice'});
		const bob = await test_app.create_account({username: 'bob'});

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_lookup_action_spec,
			params: {ids: [alice.actor.id, bob.actor.id]},
			headers: caller.create_session_headers(),
		});
		assert.ok(res.ok, JSON.stringify(res));
		const by_id = new Map(res.result.actors.map((a) => [a.id, a]));
		assert.strictEqual(by_id.size, 2);
		assert.strictEqual(by_id.get(alice.actor.id)?.username, 'alice');
		assert.strictEqual(by_id.get(alice.actor.id)?.display_name, 'alice');
		assert.strictEqual(by_id.get(bob.actor.id)?.username, 'bob');
		assert.strictEqual(by_id.get(bob.actor.id)?.display_name, 'bob');
	});

	test('unknown ids are silently absent from the response', async () => {
		const test_app = await create_test_app({
			session_options,
			create_route_specs,
			db: get_db(),
		});
		const caller = await test_app.create_account({username: 'caller'});
		const alice = await test_app.create_account({username: 'alice'});
		const unknown = create_uuid();

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_lookup_action_spec,
			params: {ids: [alice.actor.id, unknown]},
			headers: caller.create_session_headers(),
		});
		assert.ok(res.ok, JSON.stringify(res));
		assert.strictEqual(res.result.actors.length, 1);
		assert.strictEqual(res.result.actors[0]!.id, alice.actor.id);
	});

	test('display_name is omitted (not null) when actor.name is blank', async () => {
		const db = get_db();
		const test_app = await create_test_app({
			session_options,
			create_route_specs,
			db,
		});
		const caller = await test_app.create_account({username: 'caller'});
		const target = await test_app.create_account({username: 'target'});
		// Set actor.name to whitespace so the handler's `.trim()` collapses it
		// to falsy. The DDL is `TEXT NOT NULL` — empty string is allowed,
		// but `' '` exercises both the NOT NULL constraint and the trim path.
		await db.query(`UPDATE actor SET name = ' ' WHERE id = $1`, [target.actor.id]);

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_lookup_action_spec,
			params: {ids: [target.actor.id]},
			headers: caller.create_session_headers(),
		});
		assert.ok(res.ok, JSON.stringify(res));
		assert.strictEqual(res.result.actors.length, 1);
		const entry = res.result.actors[0]!;
		assert.strictEqual(entry.username, 'target');
		// The wire contract: `display_name` is `undefined`, not `null`, not a
		// blank string. JSON serialization drops the field entirely.
		assert.strictEqual(entry.display_name, undefined);
		assert.ok(!('display_name' in entry), 'display_name key leaked into response');
	});

	test('lookup row exposes only id/username/display_name — no control-plane fields', async () => {
		const db = get_db();
		const test_app = await create_test_app({
			session_options,
			create_route_specs,
			db,
		});
		const caller = await test_app.create_account({username: 'caller'});
		const target = await test_app.create_account({username: 'target_fields'});
		// Populate the control-plane fields on the underlying rows so the test
		// proves the WIRE PROJECTION drops them — not that they happened to be
		// null. `account_id` / `email` / timestamps / role state are deliberately
		// omitted for control-plane separation + timing-oracle avoidance
		// (auth/CLAUDE.md §Actor lookup / actor search; security.md §Authorization
		// "Actor-search scope gate").
		await db.query(`UPDATE account SET email = $1 WHERE id = $2`, [
			'target_fields@example.com',
			target.account.id,
		]);

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_lookup_action_spec,
			params: {ids: [target.actor.id]},
			headers: caller.create_session_headers(),
		});
		assert.ok(res.ok, JSON.stringify(res));
		assert.strictEqual(res.result.actors.length, 1);
		const entry = res.result.actors[0]!;

		// Allowlist: the wire row may carry ONLY these keys. A new field added to
		// the projection trips this immediately rather than silently shipping.
		const allowed = new Set(['id', 'username', 'display_name']);
		for (const key of Object.keys(entry)) {
			assert.ok(
				allowed.has(key),
				`unexpected key '${
					key
				}' in actor_lookup row — only id/username/display_name are wire-exposed`,
			);
		}
		// Blocklist: name the specific control-plane / timing-oracle fields that
		// must never appear, so a regression message points at the threat.
		for (const forbidden of [
			'account_id',
			'email',
			'email_verified',
			'created_at',
			'updated_at',
			'deleted_at',
			'role',
			'role_grants',
			'password_hash',
		]) {
			assert.ok(!(forbidden in entry), `${forbidden} leaked into the actor_lookup wire row`);
		}
	});

	test('rejects ids:[] at the schema (min(1))', async () => {
		const test_app = await create_test_app({
			session_options,
			create_route_specs,
			db: get_db(),
		});
		const caller = await test_app.create_account({username: 'caller'});

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_lookup_action_spec,
			// Bypass the spec-input type check — we're testing the runtime guard.
			params: {ids: []} as never,
			headers: caller.create_session_headers(),
		});
		assert.ok(!res.ok);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
	});

	test(`rejects ids past ACTOR_LOOKUP_IDS_MAX (${ACTOR_LOOKUP_IDS_MAX + 1})`, async () => {
		const test_app = await create_test_app({
			session_options,
			create_route_specs,
			db: get_db(),
		});
		const caller = await test_app.create_account({username: 'caller'});
		const oversized = Array.from({length: ACTOR_LOOKUP_IDS_MAX + 1}, () => create_uuid());

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_lookup_action_spec,
			params: {ids: oversized},
			headers: caller.create_session_headers(),
		});
		assert.ok(!res.ok);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
	});
});
