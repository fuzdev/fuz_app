/**
 * Filesystem CAS for externally-stored fact bytes — the disk half of
 * `PgFactStore`, threaded over the injectable `runtime/*Deps` rather than raw
 * `node:fs`, so it runs unchanged under Node, Deno, and a mock runtime.
 *
 * Large facts (over the embedded threshold) live on disk at the canonical
 * sharded layout `<facts_dir>/<shard>/<rest>` — `<shard>` is the first 2 hex
 * chars of the blake3 digest, `<rest>` the remaining 62 — with the `fact` row
 * carrying `external_url = file:<shard>/<rest>` (disk-root-relative). The layout
 * is single-sourced by `fact_disk_path` in `db/file_fact_url.ts`, so the write
 * path here and the URL minted into the row can't drift. The TS twin of the
 * Rust `fuz_fact` disk CAS.
 *
 * Writes land through `<facts_dir>/.tmp/<rand>.tmp`, are `fsync`ed, then
 * `rename`d into the content-addressed final path. The `rename` is atomic on
 * POSIX (a *concurrent reader* observing the path sees either the full content
 * or nothing), but atomicity is not durability — the `fsync` before the rename
 * is what guards against a *host crash* leaving a torn/zero file at a published
 * CAS path, because the serving path streams the hash-named file without
 * re-hashing it (`server/serve_fact_route.ts`). This twins the Rust `fuz_fact`
 * §fsync posture: data-sync before the rename; the parent-dir fsync stays
 * deliberately waived (a lost dirent is regenerable under content addressing).
 * If the final path already exists the temp is dropped instead of renamed over
 * — idempotent dedup (same hash → byte-identical content), mirroring the Rust
 * commit path. `.tmp/` is a sibling of `<shard>/` under the same `facts_dir` so
 * `rename` is always same-filesystem (no EXDEV).
 *
 * @module
 */

import {createHash, type Hash} from 'node:crypto';
import {join} from 'node:path';

import {Blake3Hasher} from '@fuzdev/blake3_wasm';
import {to_error_message} from '@fuzdev/fuz_util/error.ts';
import {blake3_ready} from '@fuzdev/fuz_util/hash_blake3.ts';
import {to_hex} from '@fuzdev/fuz_util/hex.ts';
import {FACT_HASH_PREFIX, type FactHash} from '@fuzdev/fuz_util/fact_hash.ts';
import type {Logger} from '@fuzdev/fuz_util/log.ts';

import type {FsReadDeps, FsWriteDeps, FsStreamDeps, FsRemoveDeps} from '../runtime/deps.ts';
import {generate_random_base64url} from '../crypto.ts';
import {
	fact_disk_path,
	mint_file_fact_url,
	parse_file_fact_url,
	type FileFactUrl,
} from './file_fact_url.ts';
import type {FactExternalFetcher} from './fact_store.ts';
import {is_enospc_error, PayloadTooLargeError, StorageFullError} from './fact_store_errors.ts';

/** Subdirectory under `facts_dir` for in-flight atomic temp files. */
export const FACT_TMP_DIRNAME = '.tmp';

/** Default age (1 hour) past which a `.tmp/*` file is considered orphaned. */
export const FACT_TMP_ORPHAN_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Filesystem capabilities the disk CAS needs, drawn from `runtime/deps.ts`. A
 * full `RuntimeDeps` (Node or Deno) satisfies this; each function below picks
 * the narrow subset it actually uses.
 */
export type FactDiskStorageDeps = Pick<FsReadDeps, 'stat' | 'readdir' | 'read_file'> &
	Pick<FsWriteDeps, 'mkdir' | 'rename' | 'write_file' | 'fsync'> &
	Pick<FsStreamDeps, 'write_file_stream' | 'read_file_stream'> &
	Pick<FsRemoveDeps, 'remove'>;

/**
 * Where a streamed body landed — `embedded` carries the in-memory bytes (under
 * the embedded threshold, bound for the PG `fact.bytes` column); `disk` means
 * the bytes are already at `<facts_dir>/<shard>/<rest>` and the row carries the
 * `file:` URL.
 */
export type StreamPlacement =
	| {kind: 'embedded'; bytes: Uint8Array}
	| {kind: 'disk'; external_url: FileFactUrl};

/**
 * Outcome of streaming an upload to storage: the `blake3:`-prefixed fact hash,
 * the bare-hex SHA-256, the byte count, and where the bytes landed.
 * `PgFactStore.put_stream` turns this into the `fact` row insert.
 */
export interface StreamFactToDiskResult {
	hash: FactHash;
	sha256: string;
	size: number;
	placement: StreamPlacement;
}

/**
 * Stream `source` to storage with bounded memory: hash BLAKE3 + SHA-256
 * incrementally in one pass, buffer in memory until the bytes cross
 * `embedded_threshold`, then spill the buffer + remaining chunks through a temp
 * file and atomically land it in the disk CAS. Peak heap is
 * `O(chunk + embedded_threshold)`, never `O(artifact)`, so a multi-GB upload
 * never buffers in RAM.
 *
 * - **Embedded vs disk.** A body `<= embedded_threshold` stays in memory and is
 *   returned as `{kind: 'embedded'}` for the PG `bytes` column. Above it (with a
 *   `facts_dir`), the buffer + remaining chunks spill to `<facts_dir>/.tmp/…`,
 *   then `rename` into `<facts_dir>/<shard>/<rest>` once the hash is known —
 *   `{kind: 'disk'}`. A body over the threshold with `facts_dir === undefined`
 *   throws `PayloadTooLargeError` (matches `PgFactStore.put`).
 * - **Cap enforcement.** Aborts with `PayloadTooLargeError` the moment the
 *   running byte count passes `max_bytes` — the mid-stream backstop for a
 *   chunked or mis-declared `Content-Length`.
 * - **Disk-full.** An `ENOSPC` from the temp-file write surfaces as
 *   `StorageFullError`.
 *
 * @mutates `facts_dir` filesystem
 */
export const stream_fact_to_disk = async (
	deps: Pick<
		FactDiskStorageDeps,
		'mkdir' | 'rename' | 'remove' | 'write_file_stream' | 'fsync' | 'stat'
	>,
	facts_dir: string | undefined,
	source: ReadableStream<Uint8Array>,
	max_bytes: number,
	embedded_threshold: number,
): Promise<StreamFactToDiskResult> => {
	await blake3_ready;
	const blake3 = new Blake3Hasher();
	const sha256: Hash = createHash('sha256');
	let size = 0;
	// Buffer leading bytes until they cross the embedded threshold; small facts
	// stay embedded (no disk), large ones never buffer past the threshold.
	const buffered: Array<Uint8Array> = [];
	let buffered_len = 0;
	const reader = source.getReader();

	const hash_and_count = (chunk: Uint8Array): void => {
		size += chunk.length;
		if (size > max_bytes) throw new PayloadTooLargeError(size, max_bytes);
		blake3.update(chunk);
		sha256.update(chunk);
	};

	try {
		// Phase 1: read + hash + buffer until the threshold is crossed or the
		// stream ends. The crossing chunk is hashed + buffered here, then emitted
		// (not re-read) by the spill stream below.
		let spill_needed = false;
		for (;;) {
			const {done, value} = await reader.read();
			if (done) break;
			if (!value || value.length === 0) continue;
			hash_and_count(value);
			buffered.push(value);
			buffered_len += value.length;
			if (buffered_len > embedded_threshold) {
				spill_needed = true;
				break;
			}
		}

		if (!spill_needed) {
			const hash = (FACT_HASH_PREFIX + to_hex(blake3.finalize())) as FactHash;
			return {
				hash,
				sha256: sha256.digest('hex'),
				size,
				placement: {kind: 'embedded', bytes: concat_chunks(buffered, buffered_len)},
			};
		}

		if (facts_dir === undefined) {
			// Over the embedded threshold with nowhere to spill — same shape as the
			// `PgFactStore.put` oversize-without-disk_root reject.
			throw new PayloadTooLargeError(size, embedded_threshold);
		}

		// Phase 2: spill. A combined stream emits the already-hashed buffered
		// chunks, then continues pulling from `reader`, hashing each remaining
		// chunk as it flows. `write_file_stream` consumes it with backpressure
		// (peak memory one chunk).
		let buffer_index = 0;
		const combined = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (buffer_index < buffered.length) {
					controller.enqueue(buffered[buffer_index++]);
					return;
				}
				for (;;) {
					const {done, value} = await reader.read();
					if (done) {
						controller.close();
						return;
					}
					if (!value || value.length === 0) continue;
					try {
						hash_and_count(value);
					} catch (err) {
						controller.error(err);
						return;
					}
					controller.enqueue(value);
					return;
				}
			},
			cancel: (reason) => reader.cancel(reason),
		});

		const tmp_dir = join(facts_dir, FACT_TMP_DIRNAME);
		const tmp_path = join(tmp_dir, `${generate_random_base64url(16)}.tmp`);
		await deps.mkdir(tmp_dir, {recursive: true});
		try {
			await deps.write_file_stream(tmp_path, combined);
		} catch (err) {
			await deps.remove(tmp_path).catch(() => undefined);
			if (is_enospc_error(err)) throw new StorageFullError(err);
			throw err; // includes a mid-stream PayloadTooLargeError surfaced via the stream
		}

		const hash = (FACT_HASH_PREFIX + to_hex(blake3.finalize())) as FactHash;
		const {shard, rest} = await commit_temp_to_cas(deps, tmp_path, facts_dir, hash);
		return {
			hash,
			sha256: sha256.digest('hex'),
			size,
			placement: {kind: 'disk', external_url: mint_file_fact_url(shard, rest)},
		};
	} finally {
		blake3.free();
		try {
			reader.releaseLock();
		} catch {
			// Already released/cancelled by the spill stream's cancel path.
		}
	}
};

/**
 * Write fully-buffered `bytes` for `hash` to the canonical
 * `<facts_dir>/<shard>/<rest>` path, then publish via `commit_temp_to_cas`
 * (fsync'd temp + atomic rename, dedup-aware). The buffering twin of
 * `stream_fact_to_disk`, used by `PgFactStore.put` for oversize sync bytes.
 * Returns the `file:` `external_url` for the `fact` row.
 *
 * @mutates `facts_dir` filesystem
 */
export const write_fact_bytes_to_disk = async (
	deps: Pick<FactDiskStorageDeps, 'mkdir' | 'rename' | 'remove' | 'write_file' | 'fsync' | 'stat'>,
	facts_dir: string,
	hash: FactHash,
	bytes: Uint8Array,
): Promise<FileFactUrl> => {
	const tmp_dir = join(facts_dir, FACT_TMP_DIRNAME);
	const tmp_path = join(tmp_dir, `${generate_random_base64url(16)}.tmp`);
	await deps.mkdir(tmp_dir, {recursive: true});

	// Write the temp first (mapping disk-full), then publish — the same
	// write-then-commit shape as the streaming twin.
	try {
		await deps.write_file(tmp_path, bytes);
	} catch (err) {
		await deps.remove(tmp_path).catch(() => undefined);
		if (is_enospc_error(err)) throw new StorageFullError(err);
		throw err;
	}
	const {shard, rest} = await commit_temp_to_cas(deps, tmp_path, facts_dir, hash);
	return mint_file_fact_url(shard, rest);
};

/**
 * `FactExternalFetcher` reading from the `<facts_dir>/<shard>/<rest>` layout the
 * writers above produce, over the injected `*Deps`. Does NOT verify hash content
 * — `PgFactStore.get` calls `fact_hash_verify(hash, bytes)` after the fetch and
 * returns `null` on mismatch.
 *
 * Defense at the read seam is the `FILE_FACT_URL_PATTERN` regex (via
 * `parse_file_fact_url`) — `..` segments, foreign schemes, and non-hex chars
 * fail before any disk access.
 */
export const create_disk_fact_fetcher = (
	deps: Pick<FactDiskStorageDeps, 'read_file' | 'read_file_stream'>,
	facts_dir: string,
): FactExternalFetcher => {
	const resolve_path = (url: string): string => {
		const parsed = parse_file_fact_url(url);
		if (!parsed) throw new Error(`invalid file fact url: ${url}`);
		return join(facts_dir, parsed.shard, parsed.rest);
	};
	return {
		fetch_bytes: (url) => deps.read_file(resolve_path(url)),
		// `async` funnels a synchronous `resolve_path` throw into a rejection.
		fetch_stream: async (url) => deps.read_file_stream(resolve_path(url)),
	};
};

/**
 * Reap stale temp files left under `<facts_dir>/.tmp/` by a hard crash (SIGKILL
 * / OOM / host crash) mid-write — the `finally` cleanup in the writers above
 * never ran. Removes `.tmp` entries whose mtime is older than `max_age_ms` (so
 * an in-flight upload isn't yanked out from under itself). The TS twin of the
 * Rust `sweep_orphan_temps`; call on startup + on an interval.
 *
 * Best-effort: a missing `.tmp/` dir (no oversize upload has ever run) is a
 * no-op; a runtime that doesn't report `mtime_ms` (a mock) leaves every temp
 * untouched; a per-file stat/remove failure is logged and skipped rather than
 * aborting the sweep. Returns the count removed.
 *
 * @mutates `facts_dir` filesystem
 */
export const sweep_orphan_temps = async (
	deps: Pick<FactDiskStorageDeps, 'readdir' | 'stat' | 'remove'>,
	facts_dir: string,
	options?: {max_age_ms?: number; log?: Pick<Logger, 'warn'>},
): Promise<number> => {
	const max_age_ms = options?.max_age_ms ?? FACT_TMP_ORPHAN_MAX_AGE_MS;
	const tmp_dir = join(facts_dir, FACT_TMP_DIRNAME);
	let entries: Array<string>;
	try {
		entries = await deps.readdir(tmp_dir);
	} catch {
		return 0; // `.tmp/` doesn't exist yet — nothing to sweep.
	}
	const cutoff = Date.now() - max_age_ms;
	let removed = 0;
	for (const entry of entries) {
		if (!entry.endsWith('.tmp')) continue;
		const path = join(tmp_dir, entry);
		try {
			const info = await deps.stat(path);
			// Unknown age (missing file, or a runtime that doesn't report mtime) →
			// leave it; never reap something we can't prove is stale.
			if (!info || info.mtime_ms === undefined || info.mtime_ms >= cutoff) continue;
			await deps.remove(path);
			removed++;
		} catch (err) {
			options?.log?.warn(`sweep_orphan_temps: failed to reap ${path}:`, to_error_message(err));
		}
	}
	return removed;
};

/**
 * Publish a written temp file into the CAS at `<facts_dir>/<shard>/<rest>`:
 * `fsync` the temp's data (durability before the rename — the serve path streams
 * the file without re-hashing, so the bytes must be stable before they become
 * the canonical body), then either drop the temp (byte-identical content already
 * present — idempotent dedup) or atomically `rename` it into place. On any
 * failure the temp is unlinked and an `ENOSPC` is surfaced as `StorageFullError`.
 * The single commit path shared by both writers above — twins the Rust `fuz_fact`
 * `SpillFile::rename_into_cas` (data-sync before rename; parent-dir fsync waived).
 *
 * @mutates `facts_dir` filesystem
 */
const commit_temp_to_cas = async (
	deps: Pick<FactDiskStorageDeps, 'mkdir' | 'rename' | 'remove' | 'fsync' | 'stat'>,
	tmp_path: string,
	facts_dir: string,
	hash: FactHash,
): Promise<{shard: string; rest: string}> => {
	const {shard, rest} = fact_disk_path(hash);
	const final_path = join(facts_dir, shard, rest);
	try {
		await deps.fsync(tmp_path);
		if (await deps.stat(final_path)) {
			await deps.remove(tmp_path).catch(() => undefined);
		} else {
			await deps.mkdir(join(facts_dir, shard), {recursive: true});
			await deps.rename(tmp_path, final_path);
		}
	} catch (err) {
		await deps.remove(tmp_path).catch(() => undefined);
		if (is_enospc_error(err)) throw new StorageFullError(err);
		throw err;
	}
	return {shard, rest};
};

/** Concatenate buffered chunks into a single `Uint8Array` of `total` bytes. */
const concat_chunks = (chunks: Array<Uint8Array>, total: number): Uint8Array => {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
};
