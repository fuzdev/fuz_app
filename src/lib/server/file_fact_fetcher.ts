/**
 * Filesystem-backed `FactExternalFetcher`.
 *
 * Resolves `file:<shard>/<rest>` external URLs against a configured
 * facts directory. The URL shape is the canonical relative-path scheme:
 * 2 hex chars for the shard subdir + 62 hex chars for the rest of the
 * blake3 hash (64 hex chars total). Files live at
 * `<facts_dir>/<shard>/<rest>` after the writer atomically temp+renames
 * them in.
 *
 * **Pre-filter regex**: `^file:[0-9a-f]{2}/[0-9a-f]{62}$`. A `..`
 * segment can't match (`.` isn't in `[0-9a-f]`); neither can absolute
 * paths, query strings, or any non-hex character. Defense-in-depth in
 * front of `path.join` — the fetcher never trusts the URL came from a
 * fact row, even though it always does in practice.
 *
 * The fetcher does NOT verify hash content — `PgFactStore.get` calls
 * `fact_hash_verify(hash, bytes)` after the fetch and returns null on
 * mismatch.
 *
 * Runtime: uses `node:fs/promises` + `node:fs` `createReadStream` so
 * the same code works under Deno (via node compat) and vitest.
 *
 * @module
 */

import {readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {join} from 'node:path';

import type {FactExternalFetcher} from '../db/fact_store.js';
import {parse_file_fact_url} from './file_fact_url.js';

/** Construction options. */
export interface FileFactFetcherOptions {
	/**
	 * Absolute path to the facts directory. Files resolve to
	 * `<facts_dir>/<shard>/<rest>`.
	 */
	facts_dir: string;
}

/**
 * Build a `FactExternalFetcher` that resolves `file:` URLs against the
 * filesystem. Throws on a malformed URL before touching the disk so
 * `PgFactStore.get` logs the warning + returns null without an I/O
 * round-trip on bad data.
 */
export const create_file_fact_fetcher = (options: FileFactFetcherOptions): FactExternalFetcher => {
	const {facts_dir} = options;

	const resolve_path = (url: string): string => {
		const parsed = parse_file_fact_url(url);
		if (!parsed) {
			throw new Error(`invalid file fact url: ${url}`);
		}
		return join(facts_dir, parsed.shard, parsed.rest);
	};

	return {
		fetch_bytes: async (url) => {
			const path = resolve_path(url);
			const buf = await readFile(path);
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
		},
		// `Promise.resolve().then(...)` (rather than `async`) funnels any
		// `resolve_path` throw into a rejection without an unused `await`.
		fetch_stream: (url) =>
			Promise.resolve().then(() => {
				const path = resolve_path(url);
				const node_stream = createReadStream(path);
				return Readable.toWeb(node_stream) as ReadableStream<Uint8Array>;
			}),
	};
};
