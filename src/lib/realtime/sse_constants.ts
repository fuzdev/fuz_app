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
