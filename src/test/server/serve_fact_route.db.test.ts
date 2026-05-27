/**
 * `GET /api/facts/:hash` — per-fact authorization via the cell-reference
 * walk. A fact is viewable iff at least one active cell that references it
 * (via `cell.refs`, auto-extracted from `data`) admits the caller through
 * `can_view_cell`. 404 is the universal "not viewable" response so the
 * existence of a private hash never leaks.
 *
 * Coverage:
 * - malformed hash param → 400 (`invalid_route_params`)
 * - well-formed but absent hash → 404
 * - embedded fact referenced by a public cell → anonymous 200 + bytes
 * - embedded fact referenced only by a private cell → anonymous 404,
 *   owner 200 (per-fact authz, not a blanket public read)
 * - stored fact with no referencing cell → 404 (orphans are unreachable)
 *
 * @module
 */

import {test, assert} from 'vitest';

import {PgFactStore} from '$lib/db/fact_store.js';
import type {FactHash} from '@fuzdev/fuz_util/fact_hash.js';
import {ERROR_INVALID_ROUTE_PARAMS} from '$lib/http/error_schemas.js';
import type {TestApp} from '$lib/testing/app_server.js';
import {describe_db, create_cell_test_app, create_cell} from '../auth/cell_test_helpers.js';

const PUBLIC_HEADERS = {host: 'localhost:5173', origin: 'http://localhost:5173'};

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/** GET `/api/facts/:hash` against the test app's Hono instance. */
const get_fact = (app: TestApp, hash: string, headers?: Record<string, string>) =>
	app.app.request(`/api/facts/${hash}`, {
		method: 'GET',
		headers: {...PUBLIC_HEADERS, ...headers},
	});

describe_db('serve_fact_route', (get_db) => {
	/** Store embedded bytes directly in the test DB and return the hash. */
	const put_embedded = (bytes: Uint8Array, content_type: string): Promise<FactHash> =>
		new PgFactStore({deps: {db: get_db()}}).put(bytes, {content_type});

	test('malformed hash param → 400', async () => {
		const app = await create_cell_test_app(get_db);
		const res = await get_fact(app, 'not-a-blake3-hash');
		assert.strictEqual(res.status, 400);
		const body = (await res.json()) as {error?: string};
		assert.strictEqual(body.error, ERROR_INVALID_ROUTE_PARAMS);
	});

	test('well-formed but absent hash → 404', async () => {
		const app = await create_cell_test_app(get_db);
		const absent = `blake3:${'a'.repeat(64)}`;
		const res = await get_fact(app, absent);
		assert.strictEqual(res.status, 404);
	});

	test('embedded fact referenced by a public cell → anonymous 200 + bytes', async () => {
		const app = await create_cell_test_app(get_db);
		const owner = await app.create_account({username: 'fact_pub_owner'});
		const bytes = encode('public cover bytes');
		const hash = await put_embedded(bytes, 'text/plain');
		await create_cell(app, {
			data: {kind: 'image', cover: hash},
			visibility: 'public',
			headers: owner.create_session_headers(),
		});

		const res = await get_fact(app, hash); // anonymous
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get('content-type'), 'text/plain');
		const back = new Uint8Array(await res.arrayBuffer());
		assert.deepEqual(back, bytes);
	});

	test('embedded fact referenced only by a private cell → anon 404, owner 200', async () => {
		const app = await create_cell_test_app(get_db);
		const owner = await app.create_account({username: 'fact_priv_owner'});
		const bytes = encode('secret cover bytes');
		const hash = await put_embedded(bytes, 'application/octet-stream');
		await create_cell(app, {
			data: {kind: 'image', cover: hash}, // private (default visibility)
			headers: owner.create_session_headers(),
		});

		// Anonymous caller: no public referencing cell admits them.
		const anon = await get_fact(app, hash);
		assert.strictEqual(anon.status, 404);

		// Owner of the referencing cell: admitted.
		const as_owner = await get_fact(app, hash, owner.create_session_headers());
		assert.strictEqual(as_owner.status, 200);
		const back = new Uint8Array(await as_owner.arrayBuffer());
		assert.deepEqual(back, bytes);
	});

	test('stored fact with no referencing cell → 404 (orphans unreachable)', async () => {
		const app = await create_cell_test_app(get_db);
		const hash = await put_embedded(encode('orphan bytes'), 'text/plain');
		// No cell references this hash.
		const res = await get_fact(app, hash);
		assert.strictEqual(res.status, 404);
	});
});
