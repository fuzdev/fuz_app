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
 * - a disk-backed `get` verifies what it reads: tampered or missing bytes on
 *   disk read as `null`
 * - an external row whose `external_url` is not a `file:<shard>/<rest>` URL
 *   reads as `null`, with or without a disk root, and nothing is fetched
 * - a disk-backed row reads as `null` from a store with no disk root, and
 *   nothing is fetched
 * - a row whose `external_url` is crafted to climb out of the disk root reads
 *   as `null` and never reaches `read_file`
 * - such a row stays through a re-`put` of its bytes; `delete` then `put`
 *   replaces it
 * - `delete` of a disk-backed fact reports its `file:` `external_url` and
 *   leaves the file for the caller to unlink
 * - `put_stream` fsyncs the temp before the publishing rename (durability twin
 *   of the Rust `fuz_fact` §fsync posture)
 * - `put_stream` of identical over-threshold bytes dedups: the second put drops
 *   its temp instead of renaming over (twin of Rust `stream_dedup_second_put_drops_temp`)
 * - `sweep_orphan_temps` reaps stale `.tmp` files but spares fresh ones
 *
 * @module
 */

import { test, assert, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { fact_hash_bytes } from '@fuzdev/fuz_util/fact_hash.ts';
import { FACT_HASH_PREFIX, type FactHash } from '@fuzdev/fuz_util/hash_schemas.ts';

import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { PgFactStore } from '$lib/db/fact_store.ts';
import { query_put_fact } from '$lib/db/fact_queries.ts';
import { fact_disk_path, mint_file_fact_url } from '$lib/db/file_fact_url.ts';
import { sweep_orphan_temps, FACT_TMP_DIRNAME } from '$lib/db/fact_disk_storage.ts';
import { PayloadTooLargeError } from '$lib/db/fact_store_errors.ts';
import { create_node_runtime } from '$lib/runtime/node.ts';
import { describe_db } from '../fact_db_fixture.ts';

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
		await rm(dir, { recursive: true, force: true });
	}
});

const sha256_hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Run `fn` with `globalThis.fetch` replaced by a stub that records the request
 * and throws, returning the recorded URLs — empty when nothing was fetched.
 */
const with_fetch_refused = async (fn: () => Promise<void>): Promise<Array<string>> => {
	const fetched: Array<string> = [];
	const original_fetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		fetched.push(input instanceof Request ? input.url : String(input));
		throw new Error('unexpected fetch');
	}) as typeof fetch;
	try {
		await fn();
	} finally {
		globalThis.fetch = original_fetch;
	}
	return fetched;
};

/** A `Logger` that records each `warn` as one joined string. */
const create_warn_log = (): { log: Logger; warnings: Array<string> } => {
	const warnings: Array<string> = [];
	const log = {
		warn: (...args: Array<unknown>): void => void warnings.push(args.join(' '))
	} as unknown as Logger;
	return { log, warnings };
};

/** A one-chunk stream. */
const stream_of = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});

/** A multi-chunk stream — exercises the buffer→spill boundary. */
const stream_of_chunks = (bytes: Uint8Array, chunk_size: number): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			for (let i = 0; i < bytes.length; i += chunk_size) {
				controller.enqueue(bytes.slice(i, Math.min(i + chunk_size, bytes.length)));
			}
			controller.close();
		}
	});

describe_db('pg_fact_store streaming', (get_db) => {
	const make_store = (facts_dir: string, embedded_threshold: number): PgFactStore =>
		new PgFactStore({
			deps: { db: get_db() },
			disk_root: facts_dir,
			fs: runtime,
			embedded_threshold
		});

	test('put_stream of a sub-threshold body embeds in PG', async () => {
		const facts_dir = await make_facts_dir();
		const store = make_store(facts_dir, 1024);
		const bytes = new TextEncoder().encode('small streamed body');

		const outcome = await store.put_stream(stream_of(bytes), 1_000_000, {
			content_type: 'text/plain'
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
			content_type: 'application/octet-stream'
		});
		assert.equal(outcome.hash, fact_hash_bytes(bytes));
		assert.equal(outcome.sha256, sha256_hex(bytes));
		assert.equal(outcome.size, bytes.length);

		// The fact row is external (disk-backed), and the bytes live at
		// <facts_dir>/<shard>/<rest>.
		const meta = await store.get_meta(outcome.hash);
		assert(meta !== null);
		assert.equal(meta.external, true);
		assert.equal(meta.size, bytes.length);
		assert.equal(meta.content_type, 'application/octet-stream');
		const hex = outcome.hash.slice(FACT_HASH_PREFIX.length);
		const on_disk = await stat(join(facts_dir, hex.slice(0, 2), hex.slice(2)));
		assert.equal(on_disk.size, bytes.length);

		// Round-trip via the disk read (with verify-on-read).
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
			/payload too large/
		);
		assert(err instanceof PayloadTooLargeError);

		// Nothing committed — the cap tripped before the insert.
		assert.equal(await store.has(fact_hash_bytes(bytes)), false);
	});

	test('oversize put routes to disk when disk_root is configured', async () => {
		const facts_dir = await make_facts_dir();
		const store = make_store(facts_dir, 16);
		const bytes = new TextEncoder().encode('this content is well over sixteen bytes long');

		const hash = await store.put(bytes, { content_type: 'text/plain' });
		assert.equal(hash, fact_hash_bytes(bytes));
		const meta = await store.get_meta(hash);
		assert(meta !== null);
		assert.equal(meta.external, true);
		assert.equal(meta.size, bytes.length);
		assert.equal(meta.content_type, 'text/plain');
		const back = await store.get(hash);
		assert.deepEqual(back, bytes);
	});

	test('external get returns null when the bytes on disk fail verify', async () => {
		const facts_dir = await make_facts_dir();
		const store = make_store(facts_dir, 16);
		const bytes = new TextEncoder().encode('original content, over sixteen bytes');
		const hash = await store.put(bytes);
		assert.deepEqual(await store.get(hash), bytes);

		// Swap the CAS body for different bytes of the same length.
		const { shard, rest } = fact_disk_path(hash);
		const tampered = new TextEncoder().encode('tampered content, over sixteen bytes');
		assert.equal(tampered.length, bytes.length);
		await writeFile(join(facts_dir, shard, rest), tampered);

		assert.equal(await store.get(hash), null);
		// The row is untouched — only the read is refused.
		assert.equal(await store.has(hash), true);
	});

	test('external get returns null when the disk file is missing', async () => {
		const facts_dir = await make_facts_dir();
		const store = make_store(facts_dir, 16);
		const bytes = new TextEncoder().encode('about to lose its file on disk');
		const hash = await store.put(bytes);

		const { shard, rest } = fact_disk_path(hash);
		await rm(join(facts_dir, shard, rest));

		assert.equal(await store.get(hash), null);
	});

	test('an external row that is not a file: URL reads as null and fetches nothing', async () => {
		const facts_dir = await make_facts_dir();
		const { log, warnings } = create_warn_log();
		const with_disk = new PgFactStore({
			deps: { db: get_db() },
			disk_root: facts_dir,
			fs: runtime,
			log
		});
		const without_disk = new PgFactStore({ deps: { db: get_db() }, log });

		// A row only a direct insert can produce — the store mints `file:` URLs.
		const bytes = new TextEncoder().encode('bytes that live at some other url');
		const hash = fact_hash_bytes(bytes);
		const url = 'https://example.test/facts/elsewhere.bin';
		await query_put_fact(
			{ db: get_db() },
			{ hash, bytes: null, external_url: url, content_type: null, size: bytes.length }
		);

		const fetched = await with_fetch_refused(async () => {
			assert.equal(await with_disk.get(hash), null);
			assert.equal(await without_disk.get(hash), null);
		});
		assert.deepEqual(fetched, []);

		// The row is still there; only its bytes are unavailable.
		assert.equal(await with_disk.has(hash), true);
		assert.equal((await with_disk.get_meta(hash))?.external, true);

		// Each refusal warns, naming the hash and the reason, not the URL.
		assert.equal(warnings.length, 2);
		for (const warning of warnings) {
			assert.include(warning, hash);
			assert.include(warning, 'not a file:<shard>/<rest> URL');
			assert.notInclude(warning, url);
		}

		// The insert is `ON CONFLICT DO NOTHING`, so putting the bytes again
		// leaves the row as it is; deleting it first lets the put replace it.
		assert.equal(await with_disk.put(bytes), hash);
		assert.equal(await with_disk.get(hash), null);
		assert.deepEqual(await with_disk.delete(hash), { size: bytes.length, external_url: url });
		assert.equal(await with_disk.put(bytes), hash);
		assert.deepEqual(await with_disk.get(hash), bytes);
	});

	test('a crafted external_url cannot address a path outside the disk root', async () => {
		const facts_dir = await make_facts_dir();
		// Record every path the store reads from disk.
		const read_paths: Array<string> = [];
		const recording_fs = {
			...runtime,
			read_file: async (path: string) => {
				read_paths.push(path);
				return runtime.read_file(path);
			}
		};
		const { log, warnings } = create_warn_log();
		const store = new PgFactStore({
			deps: { db: get_db() },
			disk_root: facts_dir,
			fs: recording_fs,
			embedded_threshold: 16,
			log
		});

		// The recorder sees a genuine disk read, under the root.
		const genuine = new TextEncoder().encode('a genuine disk-backed fact body');
		const genuine_hash = await store.put(genuine);
		assert.deepEqual(await store.get(genuine_hash), genuine);
		const { shard, rest } = fact_disk_path(genuine_hash);
		assert.deepEqual(read_paths.splice(0), [join(facts_dir, shard, rest)]);

		// Rows only a direct insert can produce. The last has the lengths of a
		// real URL — a two-char shard and a 62-char rest — spelled in `../` and
		// hex alone.
		const crafted_urls = [
			'file:../../etc/passwd',
			'file:/abs/path',
			`file:../${'../'.repeat(20)}ab`
		];
		const hashes: Array<FactHash> = [];
		for (const [i, external_url] of crafted_urls.entries()) {
			const hash = fact_hash_bytes(new TextEncoder().encode(`crafted row ${i}`));
			hashes.push(hash);
			await query_put_fact(
				{ db: get_db() },
				{ hash, bytes: null, external_url, content_type: null, size: 1 }
			);
		}

		const fetched = await with_fetch_refused(async () => {
			for (const hash of hashes) {
				assert.equal(await store.get(hash), null);
			}
		});
		assert.deepEqual(read_paths, []);
		assert.deepEqual(fetched, []);
		assert.equal(warnings.length, crafted_urls.length);
		for (const [i, warning] of warnings.entries()) {
			assert.include(warning, hashes[i]!);
			assert.include(warning, 'not a file:<shard>/<rest> URL');
			assert.notInclude(warning, crafted_urls[i]!);
		}
	});

	test('a disk-backed row reads as null with no disk root and fetches nothing', async () => {
		const facts_dir = await make_facts_dir();
		const bytes = new TextEncoder().encode('written to disk by a store that has one');
		const hash = await make_store(facts_dir, 16).put(bytes);

		const { log, warnings } = create_warn_log();
		const without_disk = new PgFactStore({ deps: { db: get_db() }, log });
		// A `disk_root` with no `fs` is not a disk CAS either.
		const without_fs = new PgFactStore({ deps: { db: get_db() }, disk_root: facts_dir, log });
		const fetched = await with_fetch_refused(async () => {
			assert.equal(await without_disk.get(hash), null);
			assert.equal(await without_fs.get(hash), null);
		});
		assert.deepEqual(fetched, []);
		assert.equal(warnings.length, 2);
		for (const warning of warnings) {
			assert.include(warning, hash);
			assert.include(warning, 'no disk CAS is configured');
		}

		// The bytes are intact — a store over the same root reads them.
		assert.deepEqual(await make_store(facts_dir, 16).get(hash), bytes);
	});

	test('delete of a disk-backed fact reports its file: external_url', async () => {
		const facts_dir = await make_facts_dir();
		const store = make_store(facts_dir, 16);
		const bytes = new TextEncoder().encode('disk-backed and about to be deleted');
		const hash = await store.put(bytes);
		const { shard, rest } = fact_disk_path(hash);

		const result = await store.delete(hash);
		assert(result !== null);
		assert.equal(result.size, bytes.length);
		assert.equal(result.external_url, mint_file_fact_url(shard, rest));

		// The row is gone; the file stays for the caller to unlink.
		assert.equal(await store.has(hash), false);
		assert.equal(await store.get(hash), null);
		assert.equal((await stat(join(facts_dir, shard, rest))).size, bytes.length);
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
			}
		};
		const store = new PgFactStore({
			deps: { db: get_db() },
			disk_root: facts_dir,
			fs: instrumented,
			embedded_threshold: 64
		});
		const bytes = new Uint8Array(4096);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17) & 0xff;

		await store.put_stream(stream_of_chunks(bytes, 256), 1_000_000, {
			content_type: 'application/octet-stream'
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
			content_type: 'application/octet-stream'
		});
		const second = await store.put_stream(stream_of_chunks(bytes, 256), 1_000_000, {
			content_type: 'application/octet-stream'
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
		await mkdir(tmp_dir, { recursive: true });
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
		await rm(facts_dir, { recursive: true, force: true });
	}
});
