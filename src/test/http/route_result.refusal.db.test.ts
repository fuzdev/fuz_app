/**
 * What a route's transaction keeps around its result: a raw answer the
 * prepare refuses commits nothing (a write in the handler's transaction is
 * gone), so a refusal can't be told apart from a throw after the commit only
 * by its 500; a response that can't be built once the route committed answers
 * the error catch's 500 with an error naming the route and the commit; and a
 * raw stream body no response takes — refused, or rolled back by a failed
 * commit — is cancelled, so its source is released.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { Hono } from 'hono';
import { literal, loose_object } from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { apply_route_specs, define_route, type RouteSpec } from '#lib/http/route_spec.ts';
import { route_raw } from '#lib/http/route_result.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { ERROR_INTERNAL_ERROR } from '#lib/http/error_schemas.ts';
import type { Db } from '#lib/db/db.ts';

import { describe_db } from '../auth_db_default.ts';
import { create_gated_db } from '../gated_db.ts';
import { route_raw_admitted, route_raw_refusals } from './route_raw_refusals.ts';

const shape = {
	method: 'POST',
	auth: { account: 'none', actor: 'none' },
	description: 'A route that writes a marker row in its transaction.',
	input: literal(null),
	output: loose_object({})
} as const;

const mark = (db: Db, name: string) =>
	db.query('INSERT INTO route_result_marker (name) VALUES ($1)', [name]);

const marked = async (db: Db, name: string): Promise<boolean> =>
	(await db.query('SELECT name FROM route_result_marker WHERE name = $1', [name])).length > 0;

const create_app = (db: Db, specs: Array<RouteSpec>, log?: Logger): Hono => {
	const app = new Hono();
	apply_route_specs(
		app,
		specs,
		fuz_auth_guard_resolver,
		log ?? new Logger('test', { level: 'off' }),
		db
	);
	return app;
};

const post = (app: Hono, path: string) =>
	app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' } });

/** A one-chunk stream that records its cancellation. */
const watched_stream = (): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull: (controller) => {
			controller.enqueue(new Uint8Array([65]));
			controller.close();
		},
		cancel: () => {
			cancelled = true;
		}
	});
	return { body, cancelled: () => cancelled };
};

describe_db('a route result and its transaction', (get_db) => {
	const setup_marker = async (db: Db): Promise<void> => {
		await db.query('CREATE TABLE IF NOT EXISTS route_result_marker (name TEXT PRIMARY KEY)');
		await db.query('DELETE FROM route_result_marker');
	};

	test('a refused raw answer commits nothing, an admitted one commits', async () => {
		const db = get_db();
		await setup_marker(db);
		// each request builds its answer fresh: a stream or a buffer is used once
		const fresh = (name: string): unknown =>
			[...route_raw_refusals(), ...route_raw_admitted()].find(([n]) => n === name)![1];
		const specs = [...route_raw_refusals(), ...route_raw_admitted()].map(([name]) =>
			define_route({
				...shape,
				path: `/raw/${name}`,
				handler: async (_c, route) => {
					await mark(route.db, name);
					return route_raw(fresh(name) as never);
				}
			})
		);
		const app = create_app(db, specs);
		for (const [name] of route_raw_refusals()) {
			const res = await post(app, `/raw/${name}`);
			assert.strictEqual(res.status, 500, name);
			const body = (await res.json()) as { error: string };
			assert.strictEqual(body.error, ERROR_INTERNAL_ERROR, name);
			assert.ok(!(await marked(db, name)), `${name}: the refusal rolled back the write`);
		}
		for (const [name] of route_raw_admitted()) {
			const res = await post(app, `/raw/${name}`);
			assert.strictEqual(res.status, 200, name);
			await res.arrayBuffer();
			assert.ok(await marked(db, name), `${name}: committed`);
		}
	});

	test('a response that cannot be built after the commit answers 500, logged naming the route', async () => {
		const db = get_db();
		await setup_marker(db);
		const errors: Array<Array<unknown>> = [];
		const log = new Logger('test', { level: 'off' });
		log.error = (...args: Array<unknown>) => {
			errors.push(args);
		};
		const app = create_app(
			db,
			[
				define_route({
					...shape,
					path: '/disturbed',
					handler: async (_c, route) => {
						await mark(route.db, 'disturbed');
						// read and released: unlocked, so the prepare can't see it, and
						// no `Response` is built from it
						const body = new ReadableStream<Uint8Array>({
							start: (controller) => {
								controller.enqueue(new Uint8Array([65]));
								controller.close();
							}
						});
						const reader = body.getReader();
						await reader.read();
						reader.releaseLock();
						return route_raw({ status: 200, headers: { 'Content-Type': 'text/plain' }, body });
					}
				})
			],
			log
		);
		const res = await post(app, '/disturbed');
		assert.strictEqual(res.status, 500);
		const body = (await res.json()) as { error: string };
		assert.strictEqual(body.error, ERROR_INTERNAL_ERROR);
		assert.ok(await marked(db, 'disturbed'), 'the work committed');
		const messages = errors.flat().map((arg) => (arg instanceof Error ? arg.message : String(arg)));
		assert.ok(
			messages.some((m) =>
				m.startsWith('POST /disturbed: the response could not be built after the route committed')
			),
			messages.join('\n')
		);
	});

	test('a refused stream body is cancelled', async () => {
		const db = get_db();
		await setup_marker(db);
		const watched = watched_stream();
		const app = create_app(db, [
			define_route({
				...shape,
				path: '/refused_stream',
				// no `Content-Type`: refused at the prepare
				handler: () => route_raw({ status: 200, body: watched.body })
			})
		]);
		const res = await post(app, '/refused_stream');
		assert.strictEqual(res.status, 500);
		assert.ok(watched.cancelled(), 'the refused body was cancelled');
	});

	test('a stream body whose commit fails is cancelled', async () => {
		const gated = create_gated_db(get_db());
		await setup_marker(get_db());
		const watched = watched_stream();
		const app = create_app(gated.db, [
			define_route({
				...shape,
				path: '/rolled_back_stream',
				handler: async (_c, route) => {
					await mark(route.db, 'rolled_back_stream');
					return route_raw({
						status: 200,
						headers: { 'Content-Type': 'text/plain' },
						body: watched.body
					});
				}
			})
		]);
		const held = gated.hold_commit();
		const pending = post(app, '/rolled_back_stream');
		await held.reached;
		held.fail(new Error('commit refused'));
		const res = await pending;
		assert.strictEqual(res.status, 500);
		assert.ok(!(await marked(get_db(), 'rolled_back_stream')), 'rolled back');
		assert.ok(watched.cancelled(), 'the rolled-back body was cancelled');
	});

	test('a stream body the response answers with is read, never cancelled', async () => {
		const db = get_db();
		await setup_marker(db);
		const watched = watched_stream();
		const app = create_app(db, [
			define_route({
				...shape,
				path: '/answered_stream',
				handler: () =>
					route_raw({ status: 200, headers: { 'Content-Type': 'text/plain' }, body: watched.body })
			})
		]);
		const res = await post(app, '/answered_stream');
		assert.strictEqual(res.status, 200);
		assert.strictEqual(await res.text(), 'A');
		assert.ok(!watched.cancelled());
	});
});
