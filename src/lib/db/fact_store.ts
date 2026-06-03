/**
 * PG-backed `FactStore` implementation.
 *
 * Wraps the raw queries in `db/fact_queries.ts` with the lifecycle the
 * `FactStore` interface promises:
 *
 * - sync hash on `put`, stream hash on `put_ref` (counting bytes against
 *   the caller-supplied `size`)
 * - idempotent insert (`ON CONFLICT DO NOTHING` in the queries layer)
 * - JSON ref auto-extraction when `content_type` signals JSON and the
 *   caller didn't pass an explicit `refs` array
 * - verify-on-read for external content; embedded reads skip verify
 *   because PG storage IS the hash table
 * - mismatched external bytes return `null` + log warning (treat as
 *   unavailable; GC / repair is a separate concern)
 *
 * Embedded vs disk split: writes route by size. Bytes `<= embedded_threshold`
 * land in the PG `bytes` column; larger bytes go to the disk CAS at
 * `<facts_dir>/<shard>/<rest>` (`db/fact_disk_storage.ts`) and the row records a
 * `file:<shard>/<rest>` `external_url`. `put` takes fully-buffered bytes;
 * `put_stream` is the bounded-memory streaming twin (hash BLAKE3 + SHA-256 in
 * one pass, spill past the threshold, enforce `max_bytes` / `ENOSPC`). Both need
 * `disk_root` + `fs` (the `runtime/*Deps`) configured for the over-threshold
 * path; without them, an oversize `put` throws and the caller must `put_ref`
 * against an externally-managed URL (federation / stub-fetcher tests).
 *
 * @module
 */

import type {QueryDeps} from './query_deps.js';
import type {Logger} from '@fuzdev/fuz_util/log.js';

import {
	fact_hash_bytes,
	fact_hash_stream,
	fact_hash_verify,
	fact_hash_extract_refs,
	type FactHash,
} from '@fuzdev/fuz_util/fact_hash.js';
import type {
	FactMeta,
	FactPutOptions,
	FactStore,
	PutStreamOutcome,
} from '@fuzdev/fuz_util/fact_store.js';

import {
	query_delete_fact,
	query_get_fact,
	query_get_fact_meta,
	query_get_fact_refs,
	query_has_fact,
	query_put_fact,
	query_put_fact_refs,
} from './fact_queries.js';
import {
	create_disk_fact_fetcher,
	stream_fact_to_disk,
	write_fact_bytes_to_disk,
	type FactDiskStorageDeps,
} from './fact_disk_storage.js';

/** Default embedded-vs-referenced cutoff (1 MiB). */
export const FACT_EMBEDDED_THRESHOLD_DEFAULT = 1024 * 1024;

/** Fetcher abstraction so tests can stub external URL retrieval. */
export interface FactExternalFetcher {
	fetch_stream: (url: string) => Promise<ReadableStream<Uint8Array>>;
	fetch_bytes: (url: string) => Promise<Uint8Array>;
}

/** Default fetcher backed by `globalThis.fetch`. */
export const create_default_fetcher = (): FactExternalFetcher => ({
	fetch_stream: async (url) => {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`fact fetch failed: ${response.status} ${url}`);
		}
		if (!response.body) {
			throw new Error(`fact fetch returned no body: ${url}`);
		}
		return response.body;
	},
	fetch_bytes: async (url) => {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`fact fetch failed: ${response.status} ${url}`);
		}
		return new Uint8Array(await response.arrayBuffer());
	},
});

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
 * When both are set, oversize `put` + `put_stream` write to disk and the
 * default `fetcher` reads from it. When unset, oversize `put`/`put_stream`
 * spill throws and reads fall back to the `globalThis.fetch`-backed default
 * fetcher (or an injected stub). `log` is optional — the only call site is the
 * verify-mismatch warning path.
 */
export interface PgFactStoreDeps {
	deps: QueryDeps;
	embedded_threshold?: number;
	disk_root?: string;
	fs?: FactDiskStorageDeps;
	fetcher?: FactExternalFetcher;
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
	readonly #fetcher: FactExternalFetcher;
	readonly #log: Logger | undefined;

	constructor(options: PgFactStoreDeps) {
		this.#deps = options.deps;
		this.#embedded_threshold = options.embedded_threshold ?? FACT_EMBEDDED_THRESHOLD_DEFAULT;
		this.#disk_root = options.disk_root;
		this.#fs = options.fs;
		this.#fetcher =
			options.fetcher ??
			(options.disk_root !== undefined && options.fs !== undefined
				? create_disk_fact_fetcher(options.fs, options.disk_root)
				: create_default_fetcher());
		this.#log = options.log;
	}

	/**
	 * Store fully-buffered bytes, routing by size: `<= embedded_threshold` into
	 * the PG `bytes` column; larger into the disk CAS (when `disk_root` + `fs`
	 * are configured) at `<facts_dir>/<shard>/<rest>` with a `file:` URL. Oversize
	 * without a disk root throws so the caller routes it through `put_ref`
	 * explicitly. Idempotent — `ON CONFLICT DO NOTHING` + content-addressed disk
	 * filenames make a re-write a no-op.
	 */
	async put(bytes: Uint8Array, options?: FactPutOptions): Promise<FactHash> {
		const hash = fact_hash_bytes(bytes);
		let row_bytes: Uint8Array | null;
		let row_external_url: string | null;
		if (bytes.length > this.#embedded_threshold) {
			if (this.#disk_root === undefined || this.#fs === undefined) {
				throw new Error(
					`fact bytes exceed embedded threshold (${bytes.length} > ${this.#embedded_threshold}); configure disk_root or use put_ref for external storage`,
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
			size: bytes.length,
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
		options?: FactPutOptions,
	): Promise<PutStreamOutcome> {
		if (this.#fs === undefined) {
			throw new Error(
				'PgFactStore.put_stream requires `fs` (FactDiskStorageDeps) to be configured',
			);
		}
		const streamed = await stream_fact_to_disk(
			this.#fs,
			this.#disk_root,
			stream,
			max_bytes,
			this.#embedded_threshold,
		);
		const row_bytes = streamed.placement.kind === 'embedded' ? streamed.placement.bytes : null;
		const row_external_url =
			streamed.placement.kind === 'disk' ? streamed.placement.external_url : null;
		const inserted = await query_put_fact(this.#deps, {
			hash: streamed.hash,
			bytes: row_bytes,
			external_url: row_external_url,
			content_type: options?.content_type ?? null,
			size: streamed.size,
		});
		if (inserted && options?.refs && options.refs.length > 0) {
			await query_put_fact_refs(this.#deps, streamed.hash, options.refs);
		}
		return {hash: streamed.hash, sha256: streamed.sha256, size: streamed.size};
	}

	/**
	 * Stream-hash external content and record `(hash, external_url, size)`.
	 * Throws when the streamed byte count disagrees with the caller's
	 * declared `size` — a size mismatch usually means the upload was
	 * truncated or the URL points at the wrong content.
	 */
	async put_ref(url: string, size: number, options?: FactPutOptions): Promise<FactHash> {
		const stream = await this.#fetcher.fetch_stream(url);
		const {hash, byte_count} = await hash_counted_stream(stream);
		if (byte_count !== size) {
			throw new Error(
				`fact size mismatch for ${url}: caller declared ${size}, streamed ${byte_count}`,
			);
		}
		const inserted = await query_put_fact(this.#deps, {
			hash,
			bytes: null,
			external_url: url,
			content_type: options?.content_type ?? null,
			size,
		});
		if (inserted && options?.refs && options.refs.length > 0) {
			await query_put_fact_refs(this.#deps, hash, options.refs);
		}
		return hash;
	}

	/**
	 * Retrieve bytes. Embedded reads return PG bytes directly; external
	 * reads fetch + verify and return `null` (with a warning log) when
	 * the bytes don't match the stored hash.
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
		let bytes: Uint8Array;
		try {
			bytes = await this.#fetcher.fetch_bytes(row.external_url);
		} catch (err) {
			this.#log?.warn(
				`PgFactStore.get fetch failed for ${hash} at ${row.external_url}:`,
				err instanceof Error ? err.message : String(err),
			);
			return null;
		}
		if (!fact_hash_verify(hash, bytes)) {
			this.#log?.warn(
				`PgFactStore.get verify mismatch for ${hash} at ${row.external_url}; treating as not-found`,
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
			external: row.external_url !== null,
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
	 * External-URL unlink is the caller's responsibility — the store
	 * doesn't know how to resolve `file:` / `s3:` / etc. URLs to a
	 * deletable handle. Caller iterates the returned `external_url`
	 * (when non-null) and dispatches to the appropriate cleanup
	 * routine. Mirrors the read-side `FactExternalFetcher` split.
	 *
	 * @returns `{size, external_url}` for the deleted row, or `null` if
	 *   no row matched the hash.
	 */
	async delete(hash: FactHash): Promise<{size: number; external_url: string | null} | null> {
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

/** Hash a stream while counting bytes. Lets `put_ref` verify size in one pass. */
const hash_counted_stream = async (
	stream: ReadableStream<Uint8Array>,
): Promise<{hash: FactHash; byte_count: number}> => {
	let byte_count = 0;
	const counting = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			byte_count += chunk.length;
			controller.enqueue(chunk);
		},
	});
	const piped = stream.pipeThrough(counting);
	const hash = await fact_hash_stream(piped);
	return {hash, byte_count};
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
