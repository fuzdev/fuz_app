/**
 * PG-backed `FactStore` implementation.
 *
 * Wraps the raw queries in `db/fact_queries.ts` with the lifecycle the
 * `FactStore` interface promises:
 *
 * - sync hash on `put`; `put_stream` hashes as it streams
 * - idempotent insert (`ON CONFLICT DO NOTHING` in the queries layer)
 * - JSON ref auto-extraction when `content_type` signals JSON and the
 *   caller didn't pass an explicit `refs` array
 * - verify-on-read for disk-backed content; embedded reads skip verify
 *   because PG storage IS the hash table
 * - mismatched disk bytes return `null` + log warning (treat as
 *   unavailable; GC / repair is a separate concern)
 *
 * Embedded vs disk split: writes route by size. Bytes `<= embedded_threshold`
 * land in the PG `bytes` column; larger bytes go to the disk CAS at
 * `<facts_dir>/<shard>/<rest>` (`db/fact_disk_storage.ts`) and the row records a
 * `file:<shard>/<rest>` `external_url`. `put` takes fully-buffered bytes;
 * `put_stream` is the bounded-memory streaming twin (hash BLAKE3 + SHA-256 in
 * one pass, spill past the threshold, enforce `max_bytes` / `ENOSPC`). `put`
 * needs `disk_root` + `fs` (the `runtime/*Deps`) for the over-threshold path
 * only: without them the store has nowhere to put bytes it cannot embed, and an
 * oversize `put` throws. `put_stream` needs `fs` for a body of any size — with
 * none it throws before reading the stream — and `disk_root` for the
 * over-threshold spill: with none, a body that passes the threshold throws
 * `PayloadTooLargeError`.
 *
 * Every `external_url` the store writes is a `file:<shard>/<rest>` URL into its
 * own disk CAS, and that CAS is the only place `get` reads external bytes from
 * — the store makes no network request. The column is free text
 * (`query_put_fact` inserts what it is given), so `get` treats a row whose
 * `external_url` has any other shape, and any external row on a store with no
 * disk CAS configured, as unavailable: a warning and `null`.
 *
 * @module
 */

import type { QueryDeps } from './query_deps.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	fact_hash_bytes,
	fact_hash_verify,
	fact_hash_extract_refs
} from '@fuzdev/fuz_util/fact_hash.ts';
import type { FactHash } from '@fuzdev/fuz_util/hash_schemas.ts';
import type {
	FactMeta,
	FactPutOptions,
	FactStore,
	PutStreamOutcome
} from '@fuzdev/fuz_util/fact_store.ts';

import {
	query_delete_fact,
	query_get_fact,
	query_get_fact_meta,
	query_get_fact_refs,
	query_has_fact,
	query_put_fact,
	query_put_fact_refs
} from './fact_queries.ts';
import { is_file_fact_url } from './file_fact_url.ts';
import {
	read_fact_bytes_from_disk,
	stream_fact_to_disk,
	write_fact_bytes_to_disk,
	type FactDiskStorageDeps
} from './fact_disk_storage.ts';

/** Default embedded-vs-referenced cutoff (1 MiB). */
export const FACT_EMBEDDED_THRESHOLD_DEFAULT = 1024 * 1024;

/**
 * Construction-time deps for `PgFactStore`.
 *
 * `embedded_threshold` (bytes) is the inline-vs-external cutoff: payloads
 * at or under it store embedded in the `fact` row, larger ones route to
 * the disk CAS. Defaults to `FACT_EMBEDDED_THRESHOLD_DEFAULT`
 * (1 MiB). Consumers tune it per workload — e.g. a much lower bound
 * (~16 KiB) keeps only small JSON inline and routes image originals +
 * thumbnails to disk.
 *
 * `disk_root` is the facts directory backing the `<shard>/<rest>` disk CAS;
 * `fs` supplies the filesystem capabilities (a `RuntimeDeps` satisfies it).
 * When both are set, oversize `put` + `put_stream` write to disk and `get`
 * reads disk-backed facts from it. When either is unset the store writes
 * embedded rows only and `get` returns `null` for an external row: an oversize
 * `put` throws; `put_stream` throws for a body of any size when `fs` is unset,
 * and with `fs` but no `disk_root` throws `PayloadTooLargeError` for a body
 * that passes the threshold. `log` is optional — its call sites are the
 * warnings on the paths where `get` returns `null` for an external row.
 */
export interface PgFactStoreDeps {
	deps: QueryDeps;
	embedded_threshold?: number;
	disk_root?: string;
	fs?: FactDiskStorageDeps;
	log?: Logger;
}

/**
 * PG-backed `FactStore`. Delegates to `db/fact_queries.ts` for I/O and adds
 * the lifecycle layer described in the module doc.
 */
export class PgFactStore implements FactStore {
	readonly #deps: QueryDeps;
	readonly #embedded_threshold: number;
	readonly #disk_root: string | undefined;
	readonly #fs: FactDiskStorageDeps | undefined;
	readonly #log: Logger | undefined;

	constructor(options: PgFactStoreDeps) {
		this.#deps = options.deps;
		this.#embedded_threshold = options.embedded_threshold ?? FACT_EMBEDDED_THRESHOLD_DEFAULT;
		this.#disk_root = options.disk_root;
		this.#fs = options.fs;
		this.#log = options.log;
	}

	/**
	 * Store fully-buffered bytes, routing by size: `<= embedded_threshold` into
	 * the PG `bytes` column; larger into the disk CAS (when `disk_root` + `fs`
	 * are configured) at `<facts_dir>/<shard>/<rest>` with a `file:` URL. Oversize
	 * without a disk root throws: the store has nowhere to put bytes it cannot
	 * embed. Idempotent — `ON CONFLICT DO NOTHING` + content-addressed disk
	 * filenames make a re-write a no-op.
	 */
	async put(bytes: Uint8Array, options?: FactPutOptions): Promise<FactHash> {
		const hash = fact_hash_bytes(bytes);
		let row_bytes: Uint8Array | null;
		let row_external_url: string | null;
		if (bytes.length > this.#embedded_threshold) {
			if (this.#disk_root === undefined || this.#fs === undefined) {
				throw new Error(
					`fact bytes exceed embedded threshold (${bytes.length} > ${
						this.#embedded_threshold
					}) and no disk CAS is configured; set disk_root and fs to store them on disk`
				);
			}
			row_bytes = null;
			row_external_url = await write_fact_bytes_to_disk(this.#fs, this.#disk_root, hash, bytes);
		} else {
			row_bytes = bytes;
			row_external_url = null;
		}
		const inserted = await query_put_fact(this.#deps, {
			hash,
			bytes: row_bytes,
			external_url: row_external_url,
			content_type: options?.content_type ?? null,
			size: bytes.length
		});
		if (inserted) {
			await query_put_fact_refs(this.#deps, hash, resolve_refs(bytes, options));
		}
		return hash;
	}

	/**
	 * Stream bytes into the store with bounded memory, returning the finalized
	 * digests + size. Delegates the byte path to `stream_fact_to_disk` (hash
	 * BLAKE3 + SHA-256 in one pass, buffer to the embedded threshold, spill to the
	 * disk CAS), then inserts the `fact` row by placement — embedded bytes go to
	 * the PG `bytes` column, disk-spilled bytes record the `file:` `external_url`.
	 * The cap is enforced mid-stream (`PayloadTooLargeError`); a disk-full mid-
	 * stream throws `StorageFullError`.
	 *
	 * Refs: explicit `options.refs` are recorded; JSON auto-extraction is NOT
	 * attempted (it would need a buffered re-read, defeating the bounded-memory
	 * contract) — streamed uploads are opaque blobs.
	 *
	 * Requires `fs` (and, for the over-threshold spill, `disk_root`) to be
	 * configured. The streaming twin of `put`; mirrors the Rust
	 * `FactStore::put_stream`.
	 */
	async put_stream(
		stream: ReadableStream<Uint8Array>,
		max_bytes: number,
		options?: FactPutOptions
	): Promise<PutStreamOutcome> {
		if (this.#fs === undefined) {
			throw new Error(
				'PgFactStore.put_stream requires `fs` (FactDiskStorageDeps) to be configured'
			);
		}
		const streamed = await stream_fact_to_disk(
			this.#fs,
			this.#disk_root,
			stream,
			max_bytes,
			this.#embedded_threshold
		);
		const row_bytes = streamed.placement.kind === 'embedded' ? streamed.placement.bytes : null;
		const row_external_url =
			streamed.placement.kind === 'disk' ? streamed.placement.external_url : null;
		const inserted = await query_put_fact(this.#deps, {
			hash: streamed.hash,
			bytes: row_bytes,
			external_url: row_external_url,
			content_type: options?.content_type ?? null,
			size: streamed.size
		});
		if (inserted && options?.refs && options.refs.length > 0) {
			await query_put_fact_refs(this.#deps, streamed.hash, options.refs);
		}
		return { hash: streamed.hash, sha256: streamed.sha256, size: streamed.size };
	}

	/**
	 * Retrieve bytes. Embedded reads return PG bytes directly. An external
	 * read comes from the disk CAS and nowhere else: the bytes at the row's
	 * `file:<shard>/<rest>` URL are read and verified against the hash.
	 *
	 * Returns `null`, with a warning log, for an external row the store cannot
	 * serve — an `external_url` that is not a `file:<shard>/<rest>` URL, no disk
	 * CAS configured (`disk_root` + `fs`), a failed disk read, or bytes that
	 * don't match the hash. Never makes a network request.
	 */
	async get(hash: FactHash): Promise<Uint8Array | null> {
		const row = await query_get_fact(this.#deps, hash);
		if (!row) return null;
		if (row.bytes !== null) {
			return to_uint8(row.bytes);
		}
		if (row.external_url === null) {
			return null;
		}
		// the URL is not echoed — the column is free text, so its shape and
		// length are whatever the row's writer chose
		if (!is_file_fact_url(row.external_url)) {
			this.#log?.warn(
				`PgFactStore.get external_url for ${hash} is not a file:<shard>/<rest> URL; treating as not-found`
			);
			return null;
		}
		if (this.#disk_root === undefined || this.#fs === undefined) {
			this.#log?.warn(
				`PgFactStore.get ${hash} is disk-backed and no disk CAS is configured (disk_root + fs); treating as not-found`
			);
			return null;
		}
		let bytes: Uint8Array;
		try {
			bytes = await read_fact_bytes_from_disk(this.#fs, this.#disk_root, row.external_url);
		} catch (err) {
			this.#log?.warn(
				`PgFactStore.get disk read failed for ${hash} at ${row.external_url}:`,
				to_error_message(err)
			);
			return null;
		}
		if (!fact_hash_verify(hash, bytes)) {
			this.#log?.warn(
				`PgFactStore.get verify mismatch for ${hash} at ${row.external_url}; treating as not-found`
			);
			return null;
		}
		return bytes;
	}

	async has(hash: FactHash): Promise<boolean> {
		return query_has_fact(this.#deps, hash);
	}

	async get_meta(hash: FactHash): Promise<FactMeta | null> {
		const row = await query_get_fact_meta(this.#deps, hash);
		if (!row) return null;
		return {
			content_type: row.content_type,
			size: Number(row.size),
			created_at: row.created_at,
			external: row.external_url !== null
		};
	}

	async get_refs(hash: FactHash): Promise<Array<FactHash>> {
		return query_get_fact_refs(this.#deps, hash);
	}

	/**
	 * Drop a fact row. `fact_ref` rows referencing this hash as a source
	 * cascade via the FK; `fact_ref` targeting this hash do **not** —
	 * they remain as dangling pointers, consistent with the federation
	 * model where `target_hash` is intentionally not a FK.
	 *
	 * Idempotent: deleting an absent fact returns `null`. The store does
	 * NOT verify the fact is unreferenced — that policy lives one layer
	 * up (the orphan-fact admin surface in the consumer; a future GC walker).
	 *
	 * The disk file of a disk-backed fact is NOT unlinked — that is the
	 * caller's responsibility, using the returned `external_url` (when
	 * non-null): a `file:<shard>/<rest>` URL names
	 * `<disk_root>/<shard>/<rest>`. The value is the row's free text — parse
	 * it with `parse_file_fact_url` before joining a path.
	 *
	 * @returns `{size, external_url}` for the deleted row, or `null` if
	 *   no row matched the hash.
	 */
	async delete(hash: FactHash): Promise<{ size: number; external_url: string | null } | null> {
		return query_delete_fact(this.#deps, hash);
	}
}

/**
 * Resolve refs for a `put` call: explicit `refs` win; otherwise auto-extract
 * from JSON content; otherwise no refs.
 */
const resolve_refs = (bytes: Uint8Array, options: FactPutOptions | undefined): Array<FactHash> => {
	if (options?.refs !== undefined) return options.refs;
	if (options?.content_type !== 'application/json') return [];
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		// Malformed JSON — caller mislabeled content_type. Fall back to no refs;
		// the alternative (throwing) would surprise callers who set
		// content_type advisorially.
		return [];
	}
	return fact_hash_extract_refs(value as never);
};

/**
 * Coerce whatever the driver returns for BYTEA into a `Uint8Array`.
 *
 * `pg` returns `Buffer` (a `Uint8Array` subclass), `pglite` already returns
 * `Uint8Array`. Wrapping `Buffer` in a fresh `Uint8Array` keeps the
 * downstream type honest without a copy.
 */
const to_uint8 = (value: Uint8Array): Uint8Array =>
	value instanceof Uint8Array && value.constructor === Uint8Array
		? value
		: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
