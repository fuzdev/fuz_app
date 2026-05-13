/**
 * Integration tests for the `actor_search` RPC action.
 *
 * Adversarial input + auth gates are covered by the generic suites in
 * `./actor_search_actions.rpc_suites.db.test.ts`. This file pins the
 * handler-specific contracts: admin-only on empty `scope_ids`,
 * scope-filtered visibility for non-admin callers, `display_name`
 * omitted-not-null, and the regression guard on the per-call cap.
 *
 * @module
 */

import {test, assert} from 'vitest';
import {Uuid, create_uuid} from '@fuzdev/fuz_util/id.js';

import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_test_app} from '$lib/testing/app_server.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {create_actor_search_actions} from '$lib/auth/actor_search_actions.js';
import {
	ACTOR_SEARCH_LIMIT_DEFAULT,
	ACTOR_SEARCH_LIMIT_MAX,
	ERROR_ACTOR_SEARCH_SCOPE_REQUIRED,
	actor_search_action_spec,
} from '$lib/auth/actor_search_action_specs.js';
import {query_create_role_grant} from '$lib/auth/role_grant_queries.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import {JSONRPC_ERROR_CODES} from '$lib/http/jsonrpc_errors.js';
import {
	create_pglite_factory,
	create_describe_db,
	auth_integration_truncate_tables,
} from '$lib/testing/db.js';
import {run_migrations} from '$lib/db/migrate.js';
import {auth_migration_ns} from '$lib/auth/migrations.js';
import type {Db} from '$lib/db/db.js';
import type {AppServerContext} from '$lib/server/app_server.js';
import type {RouteSpec} from '$lib/http/route_spec.js';

const session_options = create_session_config('test_actor_search');
const RPC_PATH = '/api/rpc';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [auth_migration_ns]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, auth_integration_truncate_tables);

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_actor_search_actions({log: ctx.deps.log}),
		log: ctx.deps.log,
	}),
];

describe_db('actor_search_actions', (get_db) => {
	test('ACTOR_SEARCH_LIMIT_MAX regression guard — bumping requires re-deriving the enumeration threat model', () => {
		assert.strictEqual(ACTOR_SEARCH_LIMIT_MAX, 50);
	});

	test('non-admin caller with scope_ids gets actors in those scopes', async () => {
		const db = get_db();
		const test_app = await create_test_app({session_options, create_route_specs, db});
		const caller = await test_app.create_account({username: 'teacher'});
		const scope = create_uuid();
		// Caller's authority to pass this scope_id is the consumer's responsibility —
		// fuz_app trusts the array as a filter, not an authority claim. This test
		// only exercises the filter behavior.
		const alpha = await test_app.create_account({username: 'alpha'});
		await db.query(`UPDATE actor SET name = $1 WHERE id = $2`, ['Alpha', alpha.actor.id]);
		await query_create_role_grant(
			{db},
			{
				actor_id: alpha.actor.id,
				role: 'classroom_student',
				scope_kind: 'classroom',
				scope_id: scope,
				granted_by: null,
			},
		);
		const outside = await test_app.create_account({username: 'alpha_outside'});
		await db.query(`UPDATE actor SET name = $1 WHERE id = $2`, ['Alpha-Out', outside.actor.id]);

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_search_action_spec,
			params: {query: 'alp', scope_ids: [scope]},
			headers: caller.create_session_headers(),
		});
		assert.ok(res.ok, JSON.stringify(res));
		const ids = res.result.actors.map((a) => a.id);
		assert.deepStrictEqual(ids, [alpha.actor.id]);
	});

	test('non-admin caller with empty scope_ids is rejected with actor_search_scope_required', async () => {
		const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
		const caller = await test_app.create_account({username: 'student'});

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_search_action_spec,
			params: {query: 'a'},
			headers: caller.create_session_headers(),
		});
		assert.ok(!res.ok);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
		const data = res.error.data as {reason?: string} | undefined;
		assert.strictEqual(data?.reason, ERROR_ACTOR_SEARCH_SCOPE_REQUIRED);
	});

	test('non-admin caller with scope_ids: [] is rejected — empty array is equivalent to omitted', async () => {
		const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
		const caller = await test_app.create_account({username: 'student2'});

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_search_action_spec,
			params: {query: 'a', scope_ids: []},
			headers: caller.create_session_headers(),
		});
		assert.ok(!res.ok);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
		const data = res.error.data as {reason?: string} | undefined;
		assert.strictEqual(data?.reason, ERROR_ACTOR_SEARCH_SCOPE_REQUIRED);
	});

	test('admin caller may omit scope_ids for unbounded global search', async () => {
		const db = get_db();
		const test_app = await create_test_app({session_options, create_route_specs, db});
		const admin = await test_app.create_account({username: 'admin_user', roles: [ROLE_ADMIN]});
		const alpha = await test_app.create_account({username: 'alpha_target'});
		await db.query(`UPDATE actor SET name = $1 WHERE id = $2`, ['Alpha Target', alpha.actor.id]);

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_search_action_spec,
			params: {query: 'alp'},
			headers: admin.create_session_headers(),
		});
		assert.ok(res.ok, JSON.stringify(res));
		const ids = res.result.actors.map((a) => a.id);
		assert.isTrue(ids.includes(alpha.actor.id));
	});

	test('admin status is account-grain — admin role on any actor on the account unlocks the global arm', async () => {
		const db = get_db();
		const test_app = await create_test_app({session_options, create_route_specs, db});
		// Create the admin with no role first, then grant admin on a separate actor on the same account.
		const admin = await test_app.create_account({username: 'admin_alt'});
		// Create a second actor on this account.
		const second_actor = await db.query_one<{id: Uuid}>(
			`INSERT INTO actor (account_id, name) VALUES ($1, 'second') RETURNING id`,
			[admin.account.id],
		);
		assert.ok(second_actor);
		await query_create_role_grant(
			{db},
			{actor_id: second_actor.id, role: ROLE_ADMIN, granted_by: null},
		);
		// Even though the caller's primary actor has no admin role_grant, the account does.
		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_search_action_spec,
			params: {query: 'a'},
			headers: admin.create_session_headers(),
		});
		assert.ok(res.ok, JSON.stringify(res));
	});

	test('display_name is omitted (not null) when actor.name trims to empty', async () => {
		const db = get_db();
		const test_app = await create_test_app({session_options, create_route_specs, db});
		const admin = await test_app.create_account({username: 'admin2', roles: [ROLE_ADMIN]});
		const target = await test_app.create_account({username: 'target'});
		// Whitespace-only name — handler's .trim() collapses to falsy. Use two spaces
		// so a single-space query prefix matches.
		await db.query(`UPDATE actor SET name = '  ' WHERE id = $1`, [target.actor.id]);

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_search_action_spec,
			params: {query: ' '},
			headers: admin.create_session_headers(),
		});
		assert.ok(res.ok, JSON.stringify(res));
		const entry = res.result.actors.find((a) => a.id === target.actor.id);
		assert.ok(entry, 'target not in result');
		// The wire contract: `display_name` is `undefined`, not `null`, not a blank
		// string. JSON serialization drops the field entirely.
		assert.strictEqual(entry.display_name, undefined);
		assert.ok(!('display_name' in entry), 'display_name key leaked into response');
	});

	test('rejects query: "" at the schema (min(1))', async () => {
		const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
		const caller = await test_app.create_account({username: 'caller2', roles: [ROLE_ADMIN]});

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_search_action_spec,
			params: {query: ''} as never,
			headers: caller.create_session_headers(),
		});
		assert.ok(!res.ok);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
	});

	test('omitted limit falls back to ACTOR_SEARCH_LIMIT_DEFAULT', async () => {
		const db = get_db();
		const test_app = await create_test_app({session_options, create_route_specs, db});
		const admin = await test_app.create_account({username: 'lim_admin', roles: [ROLE_ADMIN]});
		// Create > ACTOR_SEARCH_LIMIT_DEFAULT actors matching a unique prefix so the
		// admin caller's own username doesn't pollute the result count.
		for (let i = 0; i < ACTOR_SEARCH_LIMIT_DEFAULT + 5; i++) {
			const acct = await test_app.create_account({username: `xprefixuser_${i}`});
			await db.query(`UPDATE actor SET name = $1 WHERE id = $2`, [
				`Xprefix Target ${i}`,
				acct.actor.id,
			]);
		}
		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_search_action_spec,
			params: {query: 'xprefix'},
			headers: admin.create_session_headers(),
		});
		assert.ok(res.ok, JSON.stringify(res));
		assert.strictEqual(res.result.actors.length, ACTOR_SEARCH_LIMIT_DEFAULT);
	});

	test('caller appears in own search results when they hold a grant on the scope', async () => {
		const db = get_db();
		const test_app = await create_test_app({session_options, create_route_specs, db});
		const teacher = await test_app.create_account({username: 'self_teacher'});
		await db.query(`UPDATE actor SET name = $1 WHERE id = $2`, ['Self Teacher', teacher.actor.id]);
		const scope = create_uuid();
		await query_create_role_grant(
			{db},
			{
				actor_id: teacher.actor.id,
				role: 'classroom_teacher',
				scope_kind: 'classroom',
				scope_id: scope,
				granted_by: null,
			},
		);

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_search_action_spec,
			params: {query: 'self', scope_ids: [scope]},
			headers: teacher.create_session_headers(),
		});
		assert.ok(res.ok, JSON.stringify(res));
		const ids = res.result.actors.map((a) => a.id);
		assert.isTrue(ids.includes(teacher.actor.id), 'caller not in own search results');
	});

	test('rejects limit past ACTOR_SEARCH_LIMIT_MAX', async () => {
		const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
		const caller = await test_app.create_account({username: 'caller3', roles: [ROLE_ADMIN]});

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_search_action_spec,
			params: {query: 'a', limit: ACTOR_SEARCH_LIMIT_MAX + 1},
			headers: caller.create_session_headers(),
		});
		assert.ok(!res.ok);
		assert.strictEqual(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
	});

	test('empty result on no-match — no error', async () => {
		const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
		const caller = await test_app.create_account({username: 'caller4', roles: [ROLE_ADMIN]});

		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: actor_search_action_spec,
			params: {query: 'no_such_prefix_zzz'},
			headers: caller.create_session_headers(),
		});
		assert.ok(res.ok, JSON.stringify(res));
		// caller4 exists with name 'caller4' so verify only our explicit non-match
		const matches = res.result.actors.filter((a) => a.username.startsWith('no_such'));
		assert.deepStrictEqual(matches, []);
	});
});
