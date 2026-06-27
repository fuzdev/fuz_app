/**
 * `PgFactStore` streaming + disk-CAS integration tests.
 *
 * Covers the bounded-memory `put_stream` path, the oversize `put` → disk
 * routing, and `sweep_orphan_temps` — all over a real `create_node_runtime`
 * filesystem rooted in an OS temp dir (the DB stays PGlite / pg).
 *
 * Coverage:
 * - `put_stream` of a sub-threshold body embeds (bytes in PG, `external = false`)
 * - `put_stream` of an over-threshold (chunked) body spills to
 *   `<facts_dir>/<shard>/<rest>`, records a `file:` URL, round-trips via `get`,
 *   and reports the correct blake3 hash + SHA-256 + size
 * - `put_stream` aborts mid-stream with `PayloadTooLargeError` past `max_bytes`,
 *   inserting no row
 * - oversize `put` (with `disk_root` + `fs`) routes to disk instead of throwing
 * - `put_stream` fsyncs the temp before the publishing rename (durability twin
 *   of the Rust `fuz_fact` §fsync posture)
 * - `put_stream` of identical over-threshold bytes dedups: the second put drops
 *   its temp instead of renaming over (twin of Rust `stream_dedup_second_put_drops_temp`)
 * - `sweep_orphan_temps` reaps stale `.tmp` files but spares fresh ones
 *
 * @module
 */

import {test, assert, afterEach} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile, mkdir, utimes, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {assert_rejects} from '@fuzdev/fuz_util/testing.ts';
import {fact_hash_bytes, FACT_HASH_PREFIX} from '@fuzdev/fuz_util/fact_hash.ts';

import {
	create_pglite_factory,
	create_pg_factory,
	create_describe_db,
	log_db_factory_status,
} from '$lib/testing/db.ts';
import {create_pglet_factory} from '../db_pglet_factory.ts';
import {create_pglet_wasm_factory} from '../db_pglet_wasm_factory.ts';
import {run_migrations} from '$lib/db/migrate.ts';
import {FACT_MIGRATION_NS, FACT_DROP_TABLES} from '$lib/db/fact_ddl.ts';
import {PgFactStore} from '$lib/db/fact_store.ts';
import {sweep_orphan_temps, FACT_TMP_DIRNAME} from '$lib/db/fact_disk_storage.ts';
import {PayloadTooLargeError} from '$lib/db/fact_store_errors.ts';
import {create_node_runtime} from '$lib/runtime/node.ts';
import type {Db} from '$lib/db/db.ts';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [FACT_MIGRATION_NS]);
};

const fact_factories = [
	create_pglite_factory(init_schema),
	create_pg_factory(init_schema, process.env.TEST_DATABASE_URL),
	create_pglet_factory(init_schema),
	create_pglet_wasm_factory(init_schema),
];
log_db_factory_status(fact_factories);

const describe_db = create_describe_db(fact_factories, [...FACT_DROP_TABLES]);

const runtime = create_node_runtime();

/** Temp dirs created per test, removed in `afterEach`. */
const temp_dirs: Array<string> = [];
const make_facts_dir = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), 'fuz_fact_stream_'));
	temp_dirs.push(dir);
	return dir;
};
afterEach(async () => {
	for (const dir of temp_dirs.splice(0)) {
		await rm(dir, {recursive: true, force: true});
	}
});

const sha256_hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A one-chunk stream. */
const stream_of = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});

/** A multi-chunk stream — exercises the buffer→spill boundary. */
const stream_of_chunks = (bytes: Uint8Array, chunk_size: number): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			for (let i = 0; i < bytes.length; i += chunk_size) {
				controller.enqueue(bytes.slice(i, Math.min(i + chunk_size, bytes.length)));
			}
			controller.close();
		},
	});

describe_db('pg_fact_store streaming', (get_db) => {
	const make_store = (facts_dir: string, embedded_threshold: number): PgFactStore =>
		new PgFactStore({deps: {db: get_db()}, disk_root: facts_dir, fs: runtime, embedded_threshold});

	test('put_stream of a sub-threshold body embeds in PG', async () => {
		const facts_dir = await make_facts_dir();
		const store = make_store(facts_dir, 1024);
		const bytes = new TextEncoder().encode('small streamed body');

		const outcome = await store.put_stream(stream_of(bytes), 1_000_000, {
			content_type: 'text/plain',
		});
		assert.equal(outcome.hash, fact_hash_bytes(bytes));
		assert.equal(outcome.sha256, sha256_hex(bytes));
		assert.equal(outcome.size, bytes.length);

		const meta = await store.get_meta(outcome.hash);
		assert(meta !== null);
		assert.equal(meta.external, false); // embedded
		const back = await store.get(outcome.hash);
		assert.deepEqual(back, bytes);
	});

	test('put_stream of an over-threshold body spills to <shard>/<rest> on disk', async () => {
		const facts_dir = await make_facts_dir();
		const store = make_store(facts_dir, 64);
		// 4 KiB of deterministic bytes, fed in 100-byte chunks so the spill crosses
		// a chunk boundary.
		const bytes = new Uint8Array(4096);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;

		const outcome = await store.put_stream(stream_of_chunks(bytes, 100), 1_000_000, {
			content_type: 'application/octet-stream',
		});
		assert.equal(outcome.hash, fact_hash_bytes(bytes));
		assert.equal(outcome.sha256, sha256_hex(bytes));
		assert.equal(outcome.size, bytes.length);

		// The fact row is external (disk-backed), and the bytes live at
		// <facts_dir>/<shard>/<rest>.
		const meta = await store.get_meta(outcome.hash);
		assert(meta !== null);
		assert.equal(meta.external, true);
		const hex = outcome.hash.slice(FACT_HASH_PREFIX.length);
		const on_disk = await stat(join(facts_dir, hex.slice(0, 2), hex.slice(2)));
		assert.equal(on_disk.size, bytes.length);

		// Round-trip via the default disk fetcher (with verify-on-read).
		const back = await store.get(outcome.hash);
		assert(back !== null);
		assert.deepEqual(back, bytes);
	});

	test('put_stream aborts past max_bytes with PayloadTooLargeError, no row', async () => {
		const facts_dir = await make_facts_dir();
		const store = make_store(facts_dir, 64);
		const bytes = new Uint8Array(2048).fill(7);

		const err = await assert_rejects(
			() => store.put_stream(stream_of_chunks(bytes, 256), 512),
			/payload too large/,
		);
		assert(err instanceof PayloadTooLargeError);

		// Nothing committed — the cap tripped before the insert.
		assert.equal(await store.has(fact_hash_bytes(bytes)), false);
	});

	test('oversize put routes to disk when disk_root is configured', async () => {
		const facts_dir = await make_facts_dir();
		const store = make_store(facts_dir, 16);
		const bytes = new TextEncoder().encode('this content is well over sixteen bytes long');

		const hash = await store.put(bytes, {content_type: 'text/plain'});
		assert.equal(hash, fact_hash_bytes(bytes));
		const meta = await store.get_meta(hash);
		assert(meta !== null);
		assert.equal(meta.external, true);
		const back = await store.get(hash);
		assert.deepEqual(back, bytes);
	});

	test('put_stream fsyncs the temp before the publishing rename', async () => {
		const facts_dir = await make_facts_dir();
		// Record the order of the durability-relevant fs ops; delegate to the
		// real runtime so the bytes still land on disk.
		const events: Array<string> = [];
		const instrumented = {
			...runtime,
			fsync: async (path: string) => {
				events.push(`fsync:${path}`);
				await runtime.fsync(path);
			},
			rename: async (old_path: string, new_path: string) => {
				events.push(`rename:${old_path}`);
				await runtime.rename(old_path, new_path);
			},
		};
		const store = new PgFactStore({
			deps: {db: get_db()},
			disk_root: facts_dir,
			fs: instrumented,
			embedded_threshold: 64,
		});
		const bytes = new Uint8Array(4096);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17) & 0xff;

		await store.put_stream(stream_of_chunks(bytes, 256), 1_000_000, {
			content_type: 'application/octet-stream',
		});

		const fsync_i = events.findIndex((e) => e.startsWith('fsync:'));
		const rename_i = events.findIndex((e) => e.startsWith('rename:'));
		assert(fsync_i !== -1, 'temp was fsynced');
		assert(rename_i !== -1, 'temp was renamed into the CAS');
		assert(fsync_i < rename_i, 'fsync runs before the publishing rename');
		// The fsync + rename target the same temp path.
		assert.equal(events[fsync_i], events[rename_i]!.replace('rename:', 'fsync:'));
	});

	test('put_stream of identical over-threshold bytes dedups: second put drops its temp', async () => {
		const facts_dir = await make_facts_dir();
		const store = make_store(facts_dir, 64);
		const bytes = new Uint8Array(4096);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13) & 0xff;

		const first = await store.put_stream(stream_of_chunks(bytes, 128), 1_000_000, {
			content_type: 'application/octet-stream',
		});
		const second = await store.put_stream(stream_of_chunks(bytes, 256), 1_000_000, {
			content_type: 'application/octet-stream',
		});
		assert.equal(first.hash, second.hash);

		// The CAS body is present once, and no temp lingers (the dedup path dropped
		// it rather than renaming over the existing content-addressed file).
		const hex = first.hash.slice(FACT_HASH_PREFIX.length);
		assert(await runtime.stat(join(facts_dir, hex.slice(0, 2), hex.slice(2))));
		const tmp_entries = await runtime.readdir(join(facts_dir, FACT_TMP_DIRNAME));
		assert.equal(tmp_entries.filter((e) => e.endsWith('.tmp')).length, 0);

		const back = await store.get(first.hash);
		assert.deepEqual(back, bytes);
	});
});

test('sweep_orphan_temps reaps stale .tmp files but spares fresh ones', async () => {
	const facts_dir = await mkdtemp(join(tmpdir(), 'fuz_fact_sweep_'));
	try {
		const tmp_dir = join(facts_dir, FACT_TMP_DIRNAME);
		await mkdir(tmp_dir, {recursive: true});
		const stale = join(tmp_dir, 'stale.tmp');
		const fresh = join(tmp_dir, 'fresh.tmp');
		await writeFile(stale, 'old');
		await writeFile(fresh, 'new');
		// Age `stale` two hours back; default cutoff is one hour.
		const two_hours_ago = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await utimes(stale, two_hours_ago, two_hours_ago);

		const removed = await sweep_orphan_temps(runtime, facts_dir);
		assert.equal(removed, 1);
		assert.equal(await runtime.stat(stale), null); // reaped
		assert(await runtime.stat(fresh)); // spared
	} finally {
		await rm(facts_dir, {recursive: true, force: true});
	}
});
