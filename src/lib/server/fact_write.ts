/**
 * Shared helper for routing fact bytes between embedded (PG `bytes`
 * column) and external (filesystem + `put_ref`) storage tiers based
 * on size.
 *
 * External writes go through atomic temp+rename so the `facts` row
 * never references a partial file; idempotence comes from POSIX
 * `rename` overwrite + `INSERT ... ON CONFLICT DO NOTHING` in the
 * fact-store queries layer.
 *
 * @module
 */

import {randomBytes} from 'node:crypto';
import {writeFile, rename, mkdir, unlink} from 'node:fs/promises';
import {join} from 'node:path';

import {FACT_HASH_PREFIX, fact_hash_bytes, type FactHash} from '@fuzdev/fuz_util/fact_hash.ts';
import type {FactStore} from '@fuzdev/fuz_util/fact_store.ts';
import {mint_file_fact_url} from '../db/file_fact_url.ts';

export interface WriteFactOptions {
	content_type: string;
}

/**
 * Write `bytes` as a fact, choosing embedded (PG) vs external (disk +
 * `put_ref`) based on `embedded_threshold`. Returns the canonical
 * `blake3:` hash either way.
 *
 * @param fact_store - the `FactStore` (typically `PgFactStore`)
 * @param embedded_threshold - bytes ≤ threshold → embedded; > threshold → disk
 * @param facts_dir - root of the sharded facts directory tree on disk
 * @param bytes - the raw fact bytes
 * @param options - content type for the fact metadata
 * @returns the fact's `blake3:<hex64>` hash
 * @mutates `fact_store`, `facts_dir` filesystem
 */
export const write_fact = async (
	fact_store: FactStore,
	embedded_threshold: number,
	facts_dir: string,
	bytes: Uint8Array,
	options: WriteFactOptions,
): Promise<FactHash> => {
	if (bytes.length <= embedded_threshold) {
		return fact_store.put(bytes, options);
	}

	const hash = fact_hash_bytes(bytes);
	const hex = hash.slice(FACT_HASH_PREFIX.length);
	const shard = hex.slice(0, 2);
	const rest = hex.slice(2);
	const shard_dir = join(facts_dir, shard);
	const tmp_dir = join(facts_dir, '.tmp');
	const tmp_path = join(tmp_dir, `${randomBytes(16).toString('hex')}.tmp`);
	const final_path = join(shard_dir, rest);

	await Promise.all([mkdir(shard_dir, {recursive: true}), mkdir(tmp_dir, {recursive: true})]);

	let renamed = false;
	try {
		await writeFile(tmp_path, bytes);
		await rename(tmp_path, final_path);
		renamed = true;
	} finally {
		if (!renamed) {
			await unlink(tmp_path).catch(() => undefined);
		}
	}

	return fact_store.put_ref(mint_file_fact_url(shard, rest), bytes.length, options);
};
