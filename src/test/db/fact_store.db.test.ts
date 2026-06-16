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
 * - `put_ref` round-trips through an injected stub fetcher
 * - `put_ref` size-mismatch rejects
 * - `put` rejects bytes over the embedded threshold
 * - external `get` with mismatched bytes returns `null` (treated as missing)
 * - `delete` drops the row, is idempotent, and reports `external_url`
 *
 * @module
 */

import {test, assert} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.ts';
import {fact_hash_bytes, fact_hash_verify, type FactHash} from '@fuzdev/fuz_util/fact_hash.ts';

import {
	create_pglite_factory,
	create_pg_factory,
	create_describe_db,
	log_db_factory_status,
} from '$lib/testing/db.ts';
import {run_migrations} from '$lib/db/migrate.ts';
import {FACT_MIGRATION_NS, FACT_DROP_TABLES} from '$lib/db/fact_ddl.ts';
import {PgFactStore, type FactExternalFetcher} from '$lib/db/fact_store.ts';
import type {Db} from '$lib/db/db.ts';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [FACT_MIGRATION_NS]);
};

const fact_factories = [
	create_pglite_factory(init_schema),
	create_pg_factory(init_schema, process.env.TEST_DATABASE_URL),
];
log_db_factory_status(fact_factories);

const describe_db = create_describe_db(fact_factories, [...FACT_DROP_TABLES]);

const FAKE_BLAKE =
	'blake3:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262' as FactHash;

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

const stub_fetcher = (responses: ReadonlyMap<string, Uint8Array>): FactExternalFetcher => ({
	fetch_bytes: async (url) => {
		const bytes = responses.get(url);
		if (!bytes) throw new Error(`stub fetcher: no response for ${url}`);
		return bytes;
	},
	fetch_stream: async (url) => {
		const bytes = responses.get(url);
		if (!bytes) throw new Error(`stub fetcher: no response for ${url}`);
		return new ReadableStream({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		});
	},
});

describe_db('pg_fact_store', (get_db) => {
	const make_store = (overrides?: {
		fetcher?: FactExternalFetcher;
		embedded_threshold?: number;
	}): PgFactStore =>
		new PgFactStore({
			deps: {db: get_db()},
			...(overrides?.fetcher ? {fetcher: overrides.fetcher} : {}),
			...(overrides?.embedded_threshold !== undefined
				? {embedded_threshold: overrides.embedded_threshold}
				: {}),
		});

	test('put is idempotent: same bytes twice → same hash, one row', async () => {
		const store = make_store();
		const bytes = encode('hello fact layer');

		const hash_a = await store.put(bytes);
		const hash_b = await store.put(bytes);
		assert.equal(hash_a, hash_b);
		assert.equal(hash_a, fact_hash_bytes(bytes));

		const rows = await get_db().query<{count: string | number}>(
			`SELECT COUNT(*)::int AS count FROM fact WHERE hash = $1`,
			[hash_a],
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
			refs: [cover, detail],
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
			fake_hex_not_a_ref: 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262',
		});
		const manifest_hash = await store.put(encode(manifest_json), {
			content_type: 'application/json',
		});

		const refs = await store.get_refs(manifest_hash);
		assert.deepEqual(new Set(refs), new Set([cover, item]));
	});

	test('binary content with no explicit refs records no refs', async () => {
		const store = make_store();
		// JSON-shaped string but content_type is octet-stream → should NOT auto-extract
		const json_text = JSON.stringify({cover: FAKE_BLAKE});
		const hash = await store.put(encode(json_text), {
			content_type: 'application/octet-stream',
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
		const hash = await store.put(bytes, {content_type: 'text/plain'});

		const meta = await store.get_meta(hash);
		assert(meta !== null);
		assert.equal(meta.content_type, 'text/plain');
		assert.equal(meta.size, bytes.length);
		assert(meta.created_at instanceof Date);
		assert.equal(meta.external, false);
	});

	test('put rejects bytes over the embedded threshold', async () => {
		const store = make_store({embedded_threshold: 16});
		const bytes = encode('this string is definitely longer than sixteen bytes');
		await assert_rejects(() => store.put(bytes), /embedded threshold/);
	});

	test('put_ref round-trips through stub fetcher', async () => {
		const url = 'https://example.test/large.png';
		const bytes = encode('pretend-this-is-a-large-image');
		const fetcher = stub_fetcher(new Map([[url, bytes]]));
		const store = make_store({fetcher});

		const hash = await store.put_ref(url, bytes.length, {
			content_type: 'image/png',
			refs: [],
		});
		assert.equal(hash, fact_hash_bytes(bytes));

		const meta = await store.get_meta(hash);
		assert(meta !== null);
		assert.equal(meta.external, true);
		assert.equal(meta.content_type, 'image/png');
		assert.equal(meta.size, bytes.length);

		const back = await store.get(hash);
		assert(back !== null);
		assert.deepEqual(back, bytes);
	});

	test('put_ref rejects when streamed size disagrees with declared size', async () => {
		const url = 'https://example.test/short.bin';
		const bytes = encode('actual content');
		const fetcher = stub_fetcher(new Map([[url, bytes]]));
		const store = make_store({fetcher});

		await assert_rejects(
			() => store.put_ref(url, bytes.length + 5, {content_type: 'application/octet-stream'}),
			/size mismatch/,
		);
	});

	test('external get returns null when fetched bytes fail verify', async () => {
		const url = 'https://example.test/swapped.bin';
		const original = encode('original content');
		const tampered = encode('tampered content');

		// First store with the original content so put_ref succeeds + records the
		// genuine hash; then swap the fetcher's URL→bytes mapping for the get
		// path so retrieval sees mismatched bytes.
		const fetcher_responses = new Map([[url, original]]);
		const fetcher = stub_fetcher(fetcher_responses);
		const store = make_store({fetcher});

		const hash = await store.put_ref(url, original.length);
		fetcher_responses.set(url, tampered);

		const back = await store.get(hash);
		assert.equal(back, null);
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

	test('delete reports external_url for `put_ref`-stored facts', async () => {
		const url = 'https://example.test/external.bin';
		const bytes = encode('external content');
		const fetcher = stub_fetcher(new Map([[url, bytes]]));
		const store = make_store({fetcher});

		const hash = await store.put_ref(url, bytes.length);
		const result = await store.delete(hash);
		assert(result !== null);
		assert.equal(result.size, bytes.length);
		assert.equal(result.external_url, url);
	});
});
