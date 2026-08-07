/**
 * REST guard ordering: credential type before the authorization phase.
 *
 * `require_credential_types` reads only what the auth middleware already set
 * (`ACCOUNT_ID_KEY` + `CREDENTIAL_TYPE_KEY`), never the resolved
 * `RequestContext` — so `fuz_auth_guard_resolver` mounts it in
 * `pre_authorization`, ahead of the rule-3 scope guard and ahead of actor
 * resolution. That makes the REST order **presence → channel → scope → role**,
 * the same coarse-to-fine order `check_action_auth_post_authorization` runs for
 * actions. Only the role gate needs the authorization phase to have run.
 *
 * The observable, and the reason this is more than bookkeeping: a route
 * gated to the session channel, hit by a bearer on a multi-actor account
 * without an `acting` selector, has two possible answers. `actor_required`
 * (400) tells a channel that may never call this route that the account has
 * multiple actors and names them; `credential_type_required` (403) tells it
 * only that it is the wrong channel. The coarser authority fact outranks the
 * finer state one — the same argument that puts every authority gate ahead of
 * input validation.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { z } from 'zod';

import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_test_app } from '$lib/testing/app_server.ts';
import { query_create_actor } from '$lib/auth/account_queries.ts';
import { require_request_context } from '$lib/auth/request_context.ts';
import { fuz_auth_guard_resolver } from '$lib/auth/auth_guard_resolver.ts';
import { auth_migration_ns } from '$lib/auth/migrations.ts';
import { run_migrations } from '$lib/db/migrate.ts';
import {
	auth_integration_truncate_tables,
	create_describe_db,
	create_pglite_factory
} from '$lib/testing/db.ts';
import { ActingActor } from '$lib/http/auth_shape.ts';
import { ERROR_ACTOR_REQUIRED, ERROR_CREDENTIAL_TYPE_REQUIRED } from '$lib/http/error_schemas.ts';
import type { RouteSpec } from '$lib/http/route_spec.ts';
import type { Db } from '$lib/db/db.ts';

const session_options = create_session_config('test_session');
const SESSION_ONLY_PATH = '/api/test_session_only';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [auth_migration_ns]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, auth_integration_truncate_tables);

/** Session-gated and actor-grain — the combination that makes the order observable. */
const create_route_specs = (): Array<RouteSpec> => [
	{
		method: 'GET',
		path: SESSION_ONLY_PATH,
		auth: { account: 'required', actor: 'required', credential_types: ['session'] },
		description: 'Session-channel route that also resolves an acting actor',
		query: z.strictObject({ acting: ActingActor }),
		input: z.null(),
		output: z.strictObject({ actor_id: z.string().nullable() }),
		handler: (c) => c.json({ actor_id: require_request_context(c).actor?.id ?? null })
	}
];

describe('fuz_auth_guard_resolver phase assignment', () => {
	test('the credential-type gate is pre-authorization; only the role gate is post', () => {
		const guards = fuz_auth_guard_resolver({
			account: 'required',
			actor: 'required',
			credential_types: ['session'],
			roles: ['admin'],
			token_surface: 'audit_stream'
		});
		assert.lengthOf(
			guards.pre_authorization,
			3,
			'require_auth + require_credential_types + require_token_surface'
		);
		assert.lengthOf(
			guards.post_authorization,
			1,
			'require_role alone — it is the only gate that reads the resolved context'
		);
	});
});

describe_db('auth_guard_resolver — gate order', (get_db) => {
	describe('the wrong channel is refused before actor resolution', () => {
		test('bearer on a multi-actor account gets 403 credential_type_required, not 400 actor_required', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			await query_create_actor({ db: get_db() }, test_app.backend.account.id, 'second_persona');

			const res = await test_app.app.request(SESSION_ONLY_PATH, {
				headers: test_app.create_bearer_headers()
			});

			assert.strictEqual(res.status, 403);
			assert.strictEqual(
				(await res.json()).error,
				ERROR_CREDENTIAL_TYPE_REQUIRED,
				'a channel that may never call this route must not learn the account is multi-actor'
			);
		});

		test('the session channel still reaches the authorization phase and gets 400 actor_required', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			await query_create_actor({ db: get_db() }, test_app.backend.account.id, 'second_persona');

			const res = await test_app.app.request(SESSION_ONLY_PATH, {
				headers: test_app.create_session_headers()
			});

			assert.strictEqual(res.status, 400);
			assert.strictEqual(
				(await res.json()).error,
				ERROR_ACTOR_REQUIRED,
				'a caller the channel gate admits still gets the actor-resolution answer'
			);
		});

		test('the session channel with an `acting` selector reaches the handler', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			const second = (
				await query_create_actor({ db: get_db() }, test_app.backend.account.id, 'second_persona')
			).id;

			const res = await test_app.app.request(`${SESSION_ONLY_PATH}?acting=${second}`, {
				headers: test_app.create_session_headers()
			});

			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual(await res.json(), { actor_id: second });
		});
	});
});
