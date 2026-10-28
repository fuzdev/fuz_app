/**
 * Hono-free SSE wire constants, and the keep-alive interval's check.
 *
 * Split from `sse.ts` (which pulls `hono/streaming` via `streamSSE`) so the
 * stream-framing constants are importable by cross-process test suites
 * asserting on the wire without dragging in the in-process Hono SSE
 * implementation.
 *
 * @module
 */

/**
 * The comment line written immediately on SSE stream open. Flushes headers +
 * confirms the connection is live before the first real event. Cross-process
 * SSE tests assert the stream emits this on connect.
 */
export const SSE_CONNECTED_COMMENT = `: connected\n\n`;

/**
 * The comment line an idle SSE stream writes every
 * `SSE_KEEP_ALIVE_INTERVAL_MS`, so a proxy that cuts a connection idle past
 * its read timeout (nginx's default is 60 s) keeps an open stream open.
 * `EventSource` ignores comments.
 */
export const SSE_KEEP_ALIVE_COMMENT = `: keepalive\n\n`;

/**
 * How often an SSE stream writes `SSE_KEEP_ALIVE_COMMENT` — 15 s, a quarter of
 * nginx's default 60 s read timeout. Per stream, from its open, whether or not
 * data frames were written in between.
 */
export const SSE_KEEP_ALIVE_INTERVAL_MS = 15_000;

/** The longest keep-alive interval a timer honors — 2³¹ − 1 ms, about 24.8 days. */
export const SSE_KEEP_ALIVE_INTERVAL_MS_MAX = 2_147_483_647;

/**
 * Throw unless `keep_alive_ms` is a valid keep-alive interval
 * (`SseResponseOptions.keep_alive_ms`):
 * `undefined` (the default), `null` (off), or a positive number of ms up to
 * `SSE_KEEP_ALIVE_INTERVAL_MS_MAX`. Timers read anything else — zero, a
 * negative, `NaN`, `Infinity`, or past the max — as an interval of about
 * 1 ms, which would write keep-alives as fast as the event loop turns.
 *
 * @param keep_alive_ms - the interval to check
 * @throws Error when it is a number outside `(0, SSE_KEEP_ALIVE_INTERVAL_MS_MAX]`
 */
export const validate_sse_keep_alive_ms = (keep_alive_ms: number | null | undefined): void => {
	if (keep_alive_ms == null) return;
	if (!(keep_alive_ms > 0 && keep_alive_ms <= SSE_KEEP_ALIVE_INTERVAL_MS_MAX)) {
		throw new Error(
			`SSE keep_alive_ms must be a positive number of ms up to ${SSE_KEEP_ALIVE_INTERVAL_MS_MAX}, or null to turn keep-alives off; got ${keep_alive_ms}`
		);
	}
};

/**
 * The byte budget of what one SSE stream holds for its client to read
 * (`realtime/sse.ts` module doc, "Outbound bound").
 *
 * 1 MiB — equal to the default cap on one request body
 * (`DEFAULT_BODY_LIMIT_BYTES`). An audit row is bounded by the request that
 * produced it, so on a server that keeps that default the budget holds a burst
 * of ordinary rows or one at the largest. The value is fixed and does not
 * follow the server's body limit. Same value as the Rust spine's
 * `SSE_OUTBOUND_QUEUE_BYTES`.
 */
export const SSE_OUTBOUND_QUEUE_BYTES = 1024 * 1024;
