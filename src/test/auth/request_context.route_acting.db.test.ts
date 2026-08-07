/**
 * The REST authorization phase reading `acting` off an unvalidated body.
 *
 * `read_route_acting` is bi-located: GETs take the selector from
 * `validated_query` (query validation still runs first), mutations take it
 * from the raw body, because input validation now runs *after* the authority
 * gates. Every route spec the spine itself ships carries `acting` on `query`
 * with `input: z.null()`, so the raw-body half is reachable only from a
 * consumer-authored mutation route — which is why it gets a route spec of its
 * own here rather than riding on an existing surface.
 *
 * Three properties, all invisible to the query half:
 *
 * 1. **The body survives the pre-read.** The authorization phase calls
 *    `c.req.json()` before `create_input_validation` calls it again and before
 *    the handler reads `validated_input`. Hono caches the parsed body, so all
 *    three see it — the echoed `note` is the assertion that they do.
 * 2. **A body-supplied selector picks the actor**, so a multi-actor account can
 *    reach a mutation route at all.
 * 3. **A malformed selector reads as omitted, not as an error** — the
 *    authorization phase answers first (`actor_required` on a multi-actor
 *    account), and input validation is what rejects the bad value a step later
 *    (on a single-actor account, where resolution succeeds without it).
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { z } from 'zod';

import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_test_app } from '$lib/testing/app_server.ts';
import { query_create_actor } from '$lib/auth/account_queries.ts';
import { require_request_context } from '$lib/auth/request_context.ts';
import { auth_migration_ns } from '$lib/auth/migrations.ts';
import { run_migrations } from '$lib/db/migrate.ts';
import {
	auth_integration_truncate_tables,
	create_describe_db,
	create_pglite_factory
} from '$lib/testing/db.ts';
import { ActingActor } from '$lib/http/auth_shape.ts';
import { ERROR_ACTOR_REQUIRED, ERROR_INVALID_REQUEST_BODY } from '$lib/http/error_schemas.ts';
import { get_route_input, type RouteSpec } from '$lib/http/route_spec.ts';
import type { Db } from '$lib/db/db.ts';

const session_options = create_session_config('test_session');
const ACTING_PATH = '/api/test_acting_echo';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [auth_migration_ns]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, auth_integration_truncate_tables);

const ActingEchoInput = z.strictObject({ acting: ActingActor, note: z.string() });

/**
 * A consumer-shaped mutation route: `actor: 'required'` with `acting` on the
 * body rather than the query. Echoes the resolved actor id back alongside the
 * validated `note`, so one response proves both the authorization phase and
 * input validation read the same body.
 */
const create_route_specs = (): Array<RouteSpec> => [
	{
		method: 'POST',
		path: ACTING_PATH,
		auth: { account: 'required', actor: 'required' },
		description: 'Echo the resolved acting actor and the validated body',
		input: ActingEchoInput,
		output: z.strictObject({ actor_id: z.string().nullable(), note: z.string() }),
		transaction: false,
		handler: (c) => {
			const ctx = require_request_context(c);
			const input = get_route_input(c, ActingEchoInput);
			return c.json({ actor_id: ctx.actor?.id ?? null, note: input.note });
		}
	}
];

describe_db('request_context — acting on a mutation body', (get_db) => {
	describe('read_route_acting reads the raw body', () => {
		test('a body-supplied `acting` resolves that actor, and the body still reaches validation + handler', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			// Multi-actor, so resolution genuinely depends on the selector
			// rather than falling through to the sole-actor path.
			const second = (
				await query_create_actor({ db: get_db() }, test_app.backend.account.id, 'second_persona')
			).id;

			const res = await test_app.app.request(ACTING_PATH, {
				method: 'POST',
				headers: test_app.create_session_headers({ 'content-type': 'application/json' }),
				body: JSON.stringify({ acting: second, note: 'survives the pre-read' })
			});

			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual(await res.json(), {
				actor_id: second,
				note: 'survives the pre-read'
			});
		});

		test('a multi-actor account omitting `acting` gets 400 actor_required', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			await query_create_actor({ db: get_db() }, test_app.backend.account.id, 'second_persona');

			const res = await test_app.app.request(ACTING_PATH, {
				method: 'POST',
				headers: test_app.create_session_headers({ 'content-type': 'application/json' }),
				body: JSON.stringify({ note: 'no selector' })
			});

			assert.strictEqual(res.status, 400);
			assert.strictEqual((await res.json()).error, ERROR_ACTOR_REQUIRED);
		});

		test('a single-actor account resolves without a selector', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});

			const res = await test_app.app.request(ACTING_PATH, {
				method: 'POST',
				headers: test_app.create_session_headers({ 'content-type': 'application/json' }),
				body: JSON.stringify({ note: 'sole actor' })
			});

			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual(await res.json(), {
				actor_id: test_app.backend.actor.id,
				note: 'sole actor'
			});
		});
	});

	describe('a malformed selector reads as omitted', () => {
		test('multi-actor: the authorization phase answers actor_required, not a body-shape 400', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});
			await query_create_actor({ db: get_db() }, test_app.backend.account.id, 'second_persona');

			const res = await test_app.app.request(ACTING_PATH, {
				method: 'POST',
				headers: test_app.create_session_headers({ 'content-type': 'application/json' }),
				body: JSON.stringify({ acting: 'not-a-uuid', note: 'malformed' })
			});

			assert.strictEqual(res.status, 400);
			assert.strictEqual(
				(await res.json()).error,
				ERROR_ACTOR_REQUIRED,
				'the authority gates run first, so the selector never becomes a shape complaint here'
			);
		});

		test('single-actor: resolution succeeds, then input validation rejects the bad value', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs,
				db: get_db()
			});

			const res = await test_app.app.request(ACTING_PATH, {
				method: 'POST',
				headers: test_app.create_session_headers({ 'content-type': 'application/json' }),
				body: JSON.stringify({ acting: 'not-a-uuid', note: 'malformed' })
			});

			assert.strictEqual(res.status, 400);
			assert.strictEqual(
				(await res.json()).error,
				ERROR_INVALID_REQUEST_BODY,
				'a caller the gates admit still gets the shape error — a malformed selector is never silently accepted'
			);
		});
	});
});
