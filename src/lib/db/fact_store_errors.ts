/**
 * Typed errors thrown by `PgFactStore.put_stream` so a file-store route can
 * map them to the canonical wire responses.
 *
 * The Rust twin uses `FactError::PayloadTooLarge` / `::StorageFull` (`fuz_fact`);
 * these TS classes carry the same two cases so the upload handler can branch
 * identically and return the same status + body shape (`413` / `507`).
 *
 * @module
 */

/**
 * The streamed upload exceeded the byte cap. Thrown by `put_stream` when its
 * mid-stream counter passes `max_bytes` — the backstop for a chunked or
 * mis-declared `Content-Length` that the cheap header pre-check can't catch.
 * A consumer route maps this to `413`.
 */
export class PayloadTooLargeError extends Error {
	/** Bytes read before the cap tripped (may exceed `max_bytes` by one chunk). */
	readonly bytes_read: number;
	readonly max_bytes: number;
	constructor(bytes_read: number, max_bytes: number) {
		super(`payload too large: read ${bytes_read} bytes, exceeds ${max_bytes} byte limit`);
		this.name = 'PayloadTooLargeError';
		this.bytes_read = bytes_read;
		this.max_bytes = max_bytes;
	}
}

/**
 * The disk filled mid-stream (`ENOSPC`). Thrown by `put_stream` when the
 * temp-file write fails for lack of space — the real disk-full guarantee that
 * a best-effort free-space preflight can't promise (chunked uploads, TOCTOU
 * races). A consumer route maps this to `507`.
 */
export class StorageFullError extends Error {
	constructor(cause?: unknown) {
		super('storage_full', cause === undefined ? undefined : {cause});
		this.name = 'StorageFullError';
	}
}

/**
 * Whether a thrown value is a Node filesystem `ENOSPC` (no space left on
 * device). Used by the streaming disk write to translate the raw FS error
 * into a `StorageFullError`.
 */
export const is_enospc_error = (err: unknown): boolean =>
	typeof err === 'object' &&
	err !== null &&
	'code' in err &&
	(err as {code?: unknown}).code === 'ENOSPC';
