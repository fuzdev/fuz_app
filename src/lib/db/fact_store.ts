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
 * Embedded vs referenced split: callers route by size. `put` rejects
 * `bytes.length > embedded_threshold` so oversized content takes the
 * `put_ref` path explicitly. Auto-split inside `put` is a future option.
 *
 * Wired with a filesystem `file:`-URL fetcher (`create_file_fact_fetcher`)
 * at server assembly: bytes ≤ threshold embed via `put`, larger bytes go
 * through atomic temp+rename onto disk then `put_ref('file:<shard>/<rest>',
 * size)` for verified registration.
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
import type {FactMeta, FactPutOptions, FactStore} from '@fuzdev/fuz_util/fact_store.js';

import {
	query_delete_fact,
	query_get_fact,
	query_get_fact_meta,
	query_get_fact_refs,
	query_has_fact,
	query_put_fact,
	query_put_fact_refs,
} from './fact_queries.js';

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
 * at or under it store embedded in the `facts` row, larger ones route to
 * the external fetcher. Defaults to `FACT_EMBEDDED_THRESHOLD_DEFAULT`
 * (1 MiB). Consumers tune it per workload — e.g. a much lower bound
 * (~16 KiB) keeps only small JSON inline and routes image originals +
 * thumbnails external. `fetcher` defaults to a `globalThis.fetch`-backed
 * implementation; tests inject a stub. `log` is optional — the only call
 * site is the verify-mismatch warning path.
 */
export interface PgFactStoreDeps {
	deps: QueryDeps;
	embedded_threshold?: number;
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
	readonly #fetcher: FactExternalFetcher;
	readonly #log: Logger | undefined;

	constructor(options: PgFactStoreDeps) {
		this.#deps = options.deps;
		this.#embedded_threshold = options.embedded_threshold ?? FACT_EMBEDDED_THRESHOLD_DEFAULT;
		this.#fetcher = options.fetcher ?? create_default_fetcher();
		this.#log = options.log;
	}

	/**
	 * Store small bytes embedded in PG. Rejects oversized content so the
	 * caller routes it through `put_ref` explicitly — implicit splitting
	 * hides the size decision from the caller.
	 */
	async put(bytes: Uint8Array, options?: FactPutOptions): Promise<FactHash> {
		if (bytes.length > this.#embedded_threshold) {
			throw new Error(
				`fact bytes exceed embedded threshold (${bytes.length} > ${this.#embedded_threshold}); use put_ref for external storage`,
			);
		}
		const hash = fact_hash_bytes(bytes);
		const inserted = await query_put_fact(this.#deps, {
			hash,
			bytes,
			external_url: null,
			content_type: options?.content_type ?? null,
			size: bytes.length,
		});
		if (inserted) {
			await query_put_fact_refs(this.#deps, hash, resolve_refs(bytes, options));
		}
		return hash;
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
	 * Drop a fact row. `fact_refs` rows referencing this hash as a source
	 * cascade via the FK; `fact_refs` targeting this hash do **not** —
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
