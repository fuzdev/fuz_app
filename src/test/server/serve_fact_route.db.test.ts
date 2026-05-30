/**
 * Cell-scoped, per-reference fact serving.
 *
 * Two routes:
 *
 * - `GET /api/cells/:cell_id/facts/:hash` — the per-reference read. A fact
 *   is viewable through a named cell iff `can_view_cell(caller, cell) AND
 *   cell.refs includes hash` — scoped to *that* reference, never unioned
 *   across the fact's other referrers. 404 masks an unviewable cell, a
 *   missing cell, and a missing cell→fact edge identically.
 * - `GET /api/facts/:hash` — the bare-hash read, **admin only**. Non-admin
 *   callers are rejected at the auth phase (403); admins serve the bytes.
 *
 * Coverage:
 * - malformed hash / cell_id param → 400 (`invalid_route_params`)
 * - well-formed but absent cell / hash → 404
 * - embedded fact via a viewable public cell → 200 + bytes
 * - embedded fact via a private cell → owner 200, anon/non-owner 404
 * - cell the caller can view but which doesn't reference the hash → 404
 *   (missing edge mask)
 * - bare-hash endpoint: anon/non-admin → 403, admin → 200
 * - **cross-owner dedup does not leak**: A's private cell + B's public cell
 *   reference identical bytes (one fact row); B's viewer reads via B's cell,
 *   but cannot reach A's reference, and the bare-hash endpoint admits no
 *   non-admin via B's public cell to A's bytes.
 *
 * @module
 */

import {test, assert} from 'vitest';

import {PgFactStore} from '$lib/db/fact_store.js';
import type {FactHash} from '@fuzdev/fuz_util/fact_hash.js';
import {ERROR_INVALID_ROUTE_PARAMS} from '$lib/http/error_schemas.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import type {TestApp} from '$lib/testing/app_server.js';
import {describe_db, create_cell_test_app, create_cell} from '../auth/cell_test_helpers.js';

const PUBLIC_HEADERS = {host: 'localhost:5173', origin: 'http://localhost:5173'};

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/** GET `/api/cells/:cell_id/facts/:hash` — the per-reference read. */
const get_cell_fact = (
	app: TestApp,
	cell_id: string,
	hash: string,
	headers?: Record<string, string>,
) =>
	app.app.request(`/api/cells/${cell_id}/facts/${hash}`, {
		method: 'GET',
		headers: {...PUBLIC_HEADERS, ...headers},
	});

/** GET `/api/facts/:hash` — the bare-hash (admin-only) read. */
const get_bare_fact = (app: TestApp, hash: string, headers?: Record<string, string>) =>
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
		const cell = await create_cell(app, {data: {kind: 'image'}, visibility: 'public'});
		const res = await get_cell_fact(app, cell.id, 'not-a-blake3-hash');
		assert.strictEqual(res.status, 400);
		const body = (await res.json()) as {error?: string};
		assert.strictEqual(body.error, ERROR_INVALID_ROUTE_PARAMS);
	});

	test('malformed cell_id param → 400', async () => {
		const app = await create_cell_test_app(get_db);
		const hash = `blake3:${'a'.repeat(64)}`;
		const res = await get_cell_fact(app, 'not-a-uuid', hash);
		assert.strictEqual(res.status, 400);
		const body = (await res.json()) as {error?: string};
		assert.strictEqual(body.error, ERROR_INVALID_ROUTE_PARAMS);
	});

	test('absent cell → 404', async () => {
		const app = await create_cell_test_app(get_db);
		const absent_cell = '00000000-0000-4000-8000-000000000000';
		const hash = `blake3:${'a'.repeat(64)}`;
		const res = await get_cell_fact(app, absent_cell, hash);
		assert.strictEqual(res.status, 404);
	});

	test('viewable cell that does not reference the hash → 404 (missing-edge mask)', async () => {
		const app = await create_cell_test_app(get_db);
		// A public cell exists, and the fact bytes exist — but the cell does
		// not reference this hash. A caller naming this (cell, hash) pair must
		// get 404, never "the fact exists elsewhere".
		const hash = await put_embedded(encode('unreferenced bytes'), 'text/plain');
		const cell = await create_cell(app, {
			data: {kind: 'note', text: 'no refs'},
			visibility: 'public',
		});

		const res = await get_cell_fact(app, cell.id, hash); // anonymous
		assert.strictEqual(res.status, 404);
	});

	test('embedded fact via a viewable public cell → anonymous 200 + bytes', async () => {
		const app = await create_cell_test_app(get_db);
		const owner = await app.create_account({username: 'fact_pub_owner'});
		const bytes = encode('public cover bytes');
		const hash = await put_embedded(bytes, 'text/plain');
		const cell = await create_cell(app, {
			data: {kind: 'image', cover: hash},
			visibility: 'public',
			headers: owner.create_session_headers(),
		});

		const res = await get_cell_fact(app, cell.id, hash); // anonymous
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get('content-type'), 'text/plain');
		const back = new Uint8Array(await res.arrayBuffer());
		assert.deepEqual(back, bytes);
	});

	test('embedded fact via a private cell → anon/non-owner 404, owner 200', async () => {
		const app = await create_cell_test_app(get_db);
		const owner = await app.create_account({username: 'fact_priv_owner'});
		const other = await app.create_account({username: 'fact_priv_other'});
		const bytes = encode('secret cover bytes');
		const hash = await put_embedded(bytes, 'application/octet-stream');
		const cell = await create_cell(app, {
			data: {kind: 'image', cover: hash}, // private (default visibility)
			headers: owner.create_session_headers(),
		});

		// Anonymous caller: the named private cell does not admit them.
		const anon = await get_cell_fact(app, cell.id, hash);
		assert.strictEqual(anon.status, 404);

		// A different authenticated account that can't view the cell: 404.
		const as_other = await get_cell_fact(app, cell.id, hash, other.create_session_headers());
		assert.strictEqual(as_other.status, 404);

		// Owner of the referencing cell: admitted.
		const as_owner = await get_cell_fact(app, cell.id, hash, owner.create_session_headers());
		assert.strictEqual(as_owner.status, 200);
		const back = new Uint8Array(await as_owner.arrayBuffer());
		assert.deepEqual(back, bytes);
	});

	test('bare-hash endpoint is admin-only: anon → 403, non-admin → 403, admin → 200', async () => {
		const app = await create_cell_test_app(get_db);
		const member = await app.create_account({username: 'bare_member'});
		const admin = await app.create_account({username: 'bare_admin', roles: [ROLE_ADMIN]});
		const bytes = encode('bare-hash admin bytes');
		const hash = await put_embedded(bytes, 'text/plain');
		// Reference it from a public cell so the only thing gating the bare-hash
		// read is the admin auth, not reachability.
		await create_cell(app, {data: {kind: 'image', cover: hash}, visibility: 'public'});

		// Anonymous → 401 (auth required) at the pre-validation guard.
		const anon = await get_bare_fact(app, hash);
		assert.strictEqual(anon.status, 401);

		// Authenticated non-admin → 403 (role gate). Even though a public cell
		// references the bytes, the bare-hash endpoint no longer unions over
		// referrers for non-admins.
		const as_member = await get_bare_fact(app, hash, member.create_session_headers());
		assert.strictEqual(as_member.status, 403);

		// Admin → 200 + bytes.
		const as_admin = await get_bare_fact(app, hash, admin.create_session_headers());
		assert.strictEqual(as_admin.status, 200);
		const back = new Uint8Array(await as_admin.arrayBuffer());
		assert.deepEqual(back, bytes);
	});

	// The headline security property: global content-dedup must not defeat A's
	// stated privacy intent. A and B store identical bytes → one fact row. B
	// publishes from a public cell; A keeps a private cell. A viewer of B's
	// cell reads the bytes via B's cell (correct — B published them) but
	// cannot reach A's private reference, and the bare-hash endpoint admits no
	// non-admin via B's public cell.
	test('cross-owner dedup does not leak A’s private reference', async () => {
		const app = await create_cell_test_app(get_db);
		const a = await app.create_account({username: 'dedup_owner_a'});
		const b = await app.create_account({username: 'dedup_owner_b'});
		const viewer = await app.create_account({username: 'dedup_viewer'});

		// Identical bytes. Content-dedup collapses them to ONE fact row.
		const shared = encode('identical bytes from two owners');
		const hash_a = await put_embedded(shared, 'text/plain');
		const hash_b = await put_embedded(shared, 'text/plain');
		assert.strictEqual(hash_a, hash_b); // same hash → same fact row (dedup)
		const hash = hash_a;

		// A references it from a PRIVATE cell (A's stated intent: private).
		const a_cell = await create_cell(app, {
			data: {kind: 'doc', cover: hash}, // private (default)
			headers: a.create_session_headers(),
		});
		// B references identical bytes from a PUBLIC cell (B's published copy).
		const b_cell = await create_cell(app, {
			data: {kind: 'image', cover: hash},
			visibility: 'public',
			headers: b.create_session_headers(),
		});

		// 1. The viewer reads the bytes via B's public cell — correct, B
		// published them.
		const via_b = await get_cell_fact(app, b_cell.id, hash, viewer.create_session_headers());
		assert.strictEqual(via_b.status, 200);
		assert.deepEqual(new Uint8Array(await via_b.arrayBuffer()), shared);

		// 2. The viewer CANNOT read A's private reference — naming A's cell
		// fails `can_view_cell`. 404 mask: indistinguishable from "no such
		// cell→fact edge". A's privacy intent holds despite the shared row.
		const via_a = await get_cell_fact(app, a_cell.id, hash, viewer.create_session_headers());
		assert.strictEqual(via_a.status, 404);

		// 3. The bare-hash endpoint no longer unions over referrers for
		// non-admins: B's public cell does NOT let the viewer reach the bytes
		// by bare hash. 403 (role gate), not 200.
		const bare = await get_bare_fact(app, hash, viewer.create_session_headers());
		assert.strictEqual(bare.status, 403);

		// 4. Anonymous bare-hash → 401, regardless of B's public cell.
		const bare_anon = await get_bare_fact(app, hash);
		assert.strictEqual(bare_anon.status, 401);
	});
});
