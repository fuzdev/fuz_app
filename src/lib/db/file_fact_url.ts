/**
 * Canonical filesystem-fact URL shape + on-disk layout.
 *
 * `external_url` on the generic `fact` row is `string | null` because the
 * `FactStore` interface stays federation-friendly (future
 * `https://...` / `s3://...` shapes). Filesystem-minted URLs are exactly
 * `file:<shard>/<rest>` where `<shard>` is the first 2 hex chars of the
 * blake3 digest and `<rest>` the remaining 62 — files land at
 * `<facts_dir>/<shard>/<rest>` after the writer atomically temp+renames
 * them in.
 *
 * Centralizing the regex + the `fact_disk_path` split keeps the shape in one
 * place: `PgFactStore`'s disk CAS (`db/fact_disk_storage.ts`), the
 * `serve_fact_route` defense-in-depth check, and the `file_fact_fetcher`
 * resolver all derive the layout here, so the write path and the read path
 * can't drift. The TS twin of the Rust `fact_disk_path` (`fuz_fact`).
 *
 * Defense-in-depth: a `..` segment can't match (`.` isn't in `[0-9a-f]`),
 * neither can absolute paths, query strings, or any non-hex character.
 * Used in front of `path.join` so the resolver never trusts the URL came
 * from a fact row, even though it always does in practice.
 *
 * @module
 */

import {FACT_HASH_PREFIX, type FactHash} from '@fuzdev/fuz_util/fact_hash.js';
import {z} from 'zod';

/** Anchored, capture-group form: `^file:(<shard>)/(<rest>)$`. */
export const FILE_FACT_URL_PATTERN = /^file:([0-9a-f]{2})\/([0-9a-f]{62})$/;

/**
 * Branded URL form. Construct only via `parse_file_fact_url` or
 * `mint_file_fact_url` — those are the validated boundaries. Direct
 * string literals don't satisfy the brand.
 */
export const FileFactUrl = z.string().regex(FILE_FACT_URL_PATTERN).brand('FileFactUrl');
export type FileFactUrl = z.infer<typeof FileFactUrl>;

/** Type guard. Useful when discriminating a `string | null` column. */
export const is_file_fact_url = (s: string): s is FileFactUrl => FILE_FACT_URL_PATTERN.test(s);

/**
 * Split a `FactHash` into its on-disk `<shard>/<rest>` parts — the first 2
 * hex chars of the digest (shard subdir) + the remaining 62. The single
 * source of truth for the disk layout, so the write path (`put` /
 * `put_stream`) and the URL minted into the `fact` row can't disagree.
 * Mirrors the Rust `fact_disk_path` in `fuz_fact`.
 */
export const fact_disk_path = (hash: FactHash): {shard: string; rest: string} => {
	const hex = hash.slice(FACT_HASH_PREFIX.length);
	return {shard: hex.slice(0, 2), rest: hex.slice(2)};
};

/**
 * Validate a string against the canonical shape. Returns the branded URL
 * plus its parsed parts, or `null` on shape mismatch — callers decide
 * whether that's a 404 (read), a skip (GC), or a hard reject (write).
 */
export const parse_file_fact_url = (
	url: string,
): {url: FileFactUrl; shard: string; rest: string} | null => {
	const m = FILE_FACT_URL_PATTERN.exec(url);
	if (!m) return null;
	return {url: url as FileFactUrl, shard: m[1]!, rest: m[2]!};
};

/**
 * Construct a canonical `file:<shard>/<rest>` URL. The writer side
 * (`db/fact_disk_storage.ts`) assembles the shape from a freshly-computed
 * hash via `fact_disk_path`; this helper centralizes the literal so a
 * future shape change is a single edit.
 */
export const mint_file_fact_url = (shard: string, rest: string): FileFactUrl =>
	`file:${shard}/${rest}` as FileFactUrl;
