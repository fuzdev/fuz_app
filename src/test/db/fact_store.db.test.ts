/**
 * `PgFactStore` integration tests.
 *
 * Coverage:
 * - sync hash + idempotent put → same bytes twice yields one row
 * - embedded round-trip preserves bytes exactly across pg + pglite
 * - `fact_hash_verify(hash, await get(hash))` is true on a stored fact
 * - declared refs on `put` are queryable via `get_refs`
 * - JSON content auto-extracts refs when no explicit `refs` is passed;
 *   binary content does NOT auto-extract
 * - `has` / `get` / `get_meta` return false / null on absent hashes
 * - `put` rejects bytes over the embedded threshold when no disk root is
 *   configured
 * - `delete` drops the row and is idempotent
 *
 * Disk-backed (external) facts — the disk read, verify-on-read, the external
 * rows `get` refuses, and `delete` reporting `external_url` — are covered in
 * `fact_store.stream.db.test.ts`.
 *
 * @module
 */

import { test, assert } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { fact_hash_bytes, fact_hash_verify } from '@fuzdev/fuz_util/fact_hash.ts';
import type { FactHash } from '@fuzdev/fuz_util/hash_schemas.ts';

import { PgFactStore } from '$lib/db/fact_store.ts';
import { describe_db } from '../fact_db_fixture.ts';

const FAKE_BLAKE =
	'blake3:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262' as FactHash;

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

describe_db('pg_fact_store', (get_db) => {
	const make_store = (overrides?: { embedded_threshold?: number }): PgFactStore =>
		new PgFactStore({
			deps: { db: get_db() },
			...(overrides?.embedded_threshold !== undefined
				? { embedded_threshold: overrides.embedded_threshold }
				: {})
		});

	test('put is idempotent: same bytes twice → same hash, one row', async () => {
		const store = make_store();
		const bytes = encode('hello fact layer');

		const hash_a = await store.put(bytes);
		const hash_b = await store.put(bytes);
		assert.equal(hash_a, hash_b);
		assert.equal(hash_a, fact_hash_bytes(bytes));

		const rows = await get_db().query<{ count: string | number }>(
			`SELECT COUNT(*)::int AS count FROM fact WHERE hash = $1`,
			[hash_a]
		);
		assert.equal(Number(rows[0]!.count), 1);
	});

	test('embedded round-trip: get returns the exact bytes; verify holds', async () => {
		const store = make_store();
		const bytes = encode('round trip me');

		const hash = await store.put(bytes);
		const back = await store.get(hash);
		assert(back !== null);
		assert.deepEqual(back, bytes);
		assert(fact_hash_verify(hash, back));
	});

	test('declared refs on put are queryable via get_refs', async () => {
		const store = make_store();
		const cover = await store.put(encode('cover image bytes'));
		const detail = await store.put(encode('detail image bytes'));

		const manifest = await store.put(encode('opaque binary manifest'), {
			content_type: 'application/octet-stream',
			refs: [cover, detail]
		});

		const refs = await store.get_refs(manifest);
		assert.deepEqual(new Set(refs), new Set([cover, detail]));
	});

	test('JSON content auto-extracts refs when no explicit refs passed', async () => {
		const store = make_store();
		// Real hashes — auto-extraction must produce hashes that pass is_fact_hash
		const cover = await store.put(encode('cover'));
		const item = await store.put(encode('item'));

		const manifest_json = JSON.stringify({
			kind: 'collection',
			cover,
			items: [item],
			label: 'Auto-extract test',
			fake_hex_not_a_ref: 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'
		});
		const manifest_hash = await store.put(encode(manifest_json), {
			content_type: 'application/json'
		});

		const refs = await store.get_refs(manifest_hash);
		assert.deepEqual(new Set(refs), new Set([cover, item]));
	});

	test('binary content with no explicit refs records no refs', async () => {
		const store = make_store();
		// JSON-shaped string but content_type is octet-stream → should NOT auto-extract
		const json_text = JSON.stringify({ cover: FAKE_BLAKE });
		const hash = await store.put(encode(json_text), {
			content_type: 'application/octet-stream'
		});
		const refs = await store.get_refs(hash);
		assert.deepEqual(refs, []);
	});

	test('has / get / get_meta on absent hash', async () => {
		const store = make_store();
		assert.equal(await store.has(FAKE_BLAKE), false);
		assert.equal(await store.get(FAKE_BLAKE), null);
		assert.equal(await store.get_meta(FAKE_BLAKE), null);
	});

	test('get_meta returns content_type, size, created_at, external=false', async () => {
		const store = make_store();
		const bytes = encode('meta probe');
		const hash = await store.put(bytes, { content_type: 'text/plain' });

		const meta = await store.get_meta(hash);
		assert(meta !== null);
		assert.equal(meta.content_type, 'text/plain');
		assert.equal(meta.size, bytes.length);
		assert(meta.created_at instanceof Date);
		assert.equal(meta.external, false);
	});

	test('put rejects bytes over the embedded threshold when no disk root is configured', async () => {
		const store = make_store({ embedded_threshold: 16 });
		const bytes = encode('this string is definitely longer than sixteen bytes');
		// The message names the configuration that would accept the bytes.
		await assert_rejects(() => store.put(bytes), /embedded threshold.*disk_root and fs/);
		// Nothing was stored.
		assert.equal(await store.has(fact_hash_bytes(bytes)), false);
	});

	test('delete drops the row and returns size + external_url', async () => {
		const store = make_store();
		const bytes = encode('about to be deleted');
		const hash = await store.put(bytes);

		const result = await store.delete(hash);
		assert(result !== null);
		assert.equal(result.size, bytes.length);
		assert.equal(result.external_url, null); // embedded fact

		// Row gone.
		assert.equal(await store.has(hash), false);
		assert.equal(await store.get(hash), null);
	});

	test('delete is idempotent: returns null on absent hash', async () => {
		const store = make_store();
		const result = await store.delete(FAKE_BLAKE);
		assert.equal(result, null);
	});
});
