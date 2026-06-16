import '../assert_dev_env.ts';

/**
 * SSE frame reader over a `ReadableStreamDefaultReader<Uint8Array>`.
 *
 * Transport-agnostic core shared by the in-process SSE route suite
 * (`testing/sse_round_trip.ts`, reading a Hono `Response.body`) and the
 * cross-process `transports/sse_transport.ts` (reading a streaming `fetch`
 * body): `\n\n`-delimited framing, a per-read timeout (so vitest can't hang
 * on a stalled stream), and `wait_for_close` for server-initiated close
 * detection (the auth-guard revocation seam).
 *
 * @module
 */

/** Default per-read / wait-for-close timeout. */
export const SSE_FRAME_READ_TIMEOUT_MS = 2000;

/** Frame-level reader returned by `create_sse_frame_reader`. */
export interface SseFrameReader {
	/**
	 * Read one complete SSE frame (up to the next `\n\n`), without the
	 * trailing terminator. Throws if the per-read timeout elapses or the
	 * stream ends before a frame arrives.
	 */
	read_frame: (timeout_ms?: number) => Promise<string>;
	/**
	 * Drain until the server closes the stream. Resolves `true` if the
	 * stream closes within `timeout_ms`, `false` on timeout.
	 */
	wait_for_close: (timeout_ms?: number) => Promise<boolean>;
	/** Cancel the underlying reader. Safe to call when already closed. */
	cancel: () => Promise<void>;
}

/**
 * Wrap a byte-stream reader in `\n\n`-delimited SSE frame parsing.
 *
 * Preserves bytes past a frame terminator in an internal buffer for the next
 * `read_frame`. `read_frame` and `wait_for_close` both race each underlying
 * read against `timeout_ms` so a misbehaving stream surfaces as a failure
 * rather than a vitest hang.
 */
export const create_sse_frame_reader = (
	reader: ReadableStreamDefaultReader<Uint8Array>,
	default_timeout_ms = SSE_FRAME_READ_TIMEOUT_MS,
): SseFrameReader => {
	const decoder = new TextDecoder();
	let buffer = '';
	let closed = false;

	// Race a single read against a timeout — vitest would otherwise hang on a
	// stalled stream. Returns false when the stream ended.
	const pump_once = async (timeout_ms: number): Promise<boolean> => {
		const timeout = new Promise<{timed_out: true}>((resolve) => {
			setTimeout(() => resolve({timed_out: true}), timeout_ms);
		});
		const result = (await Promise.race([reader.read(), timeout])) as
			| ReadableStreamReadResult<Uint8Array>
			| {timed_out: true};
		if ('timed_out' in result) {
			throw new Error(`SSE read timed out after ${timeout_ms}ms`);
		}
		if (result.done) {
			closed = true;
			return false;
		}
		buffer += decoder.decode(result.value, {stream: true});
		return true;
	};

	const read_frame = async (timeout_ms = default_timeout_ms): Promise<string> => {
		// SSE frames end with a blank line — the canonical terminator is `\n\n`.
		for (;;) {
			const idx = buffer.indexOf('\n\n');
			if (idx >= 0) {
				const frame = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				return frame;
			}
			const cont = await pump_once(timeout_ms);
			if (!cont) throw new Error('SSE stream ended before a frame was received');
		}
	};

	const wait_for_close = async (timeout_ms = default_timeout_ms): Promise<boolean> => {
		const deadline = Date.now() + timeout_ms;
		for (;;) {
			if (closed) return true;
			const remaining = deadline - Date.now();
			if (remaining <= 0) return false;
			try {
				await pump_once(Math.min(remaining, timeout_ms));
			} catch {
				return false;
			}
		}
	};

	const cancel = async (): Promise<void> => {
		try {
			await reader.cancel();
		} catch {
			// already closed
		}
	};

	return {read_frame, wait_for_close, cancel};
};
