/**
 * Hono-free SSE wire constants.
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
 * The byte budget of what one SSE stream holds for its client to read
 * (`realtime/sse.ts` module doc, "Outbound bound").
 *
 * 1 MiB — equal to the default cap on one request body
 * (`DEFAULT_MAX_BODY_SIZE`). An audit row is bounded by the request that
 * produced it, so on a server that keeps that default the budget holds a burst
 * of ordinary rows or one at the largest. The value is fixed and does not
 * follow the server's body limit. Same value as the Rust spine's
 * `SSE_OUTBOUND_QUEUE_BYTES`.
 */
export const SSE_OUTBOUND_QUEUE_BYTES = 1024 * 1024;
