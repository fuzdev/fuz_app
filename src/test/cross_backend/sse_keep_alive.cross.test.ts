/**
 * Cross-backend SSE keep-alive gate for fuz_app's own spine.
 *
 * Opens the audit stream as the keeper on BOTH impls — the TS spine (Node +
 * in-memory pglet) and the Rust `testing_spine_stub` (real Postgres) — spawned
 * by the dual-spawn `global_setup_timing.ts` with the keep-alive interval
 * shortened, and reads the raw body bytes: the connect comment, then
 * keep-alive comments, byte-identical to `SSE_CONNECTED_COMMENT` and
 * `SSE_KEEP_ALIVE_COMMENT` on both. An idle stream carries nothing else, so
 * the bytes are compared exactly, not frame by frame.
 *
 * The deadline is generous against a slow machine yet well under two default
 * intervals (`SSE_KEEP_ALIVE_INTERVAL_MS`), so a backend that ignored the
 * shortened interval fails here.
 *
 * Runs under the dedicated `cross_backend_timing` project: the shortened
 * intervals can only be set on backends nothing else shares.
 *
 * @module
 */

import { assert, describe, inject, test } from 'vitest';

import { SSE_CONNECTED_COMMENT, SSE_KEEP_ALIVE_COMMENT } from '#lib/realtime/sse_constants.ts';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
	type ReconstructedBootstrappedBackendHandle
} from '#lib/testing/cross_backend/setup.ts';
import { SPINE_SSE_PATH } from '#lib/testing/cross_backend/spine_surface_constants.ts';

import './cross_test_types.ts';

const ts = reconstruct_bootstrapped_handle(inject('timing_handle_a'));
const rust = reconstruct_bootstrapped_handle(inject('timing_handle_b'));
const keep_alive_ms = inject('timing_audit_sse_keep_alive_ms');

/**
 * How long the stream may take to write its connect comment and two
 * keep-alives — many shortened intervals, and well under the 15 s default
 * interval a backend ignoring the override would use.
 */
const KEEP_ALIVE_DEADLINE_MS = 5_000;

const encoder = new TextEncoder();

/** Read from `reader` until `length` bytes arrived, the stream ended, or `deadline_ms` passed. */
const read_bytes = async (
	reader: ReadableStreamDefaultReader<Uint8Array>,
	length: number,
	deadline_ms: number
): Promise<Uint8Array> => {
	const deadline = performance.now() + deadline_ms;
	const chunks: Array<Uint8Array> = [];
	let total = 0;
	while (total < length) {
		const remaining = deadline - performance.now();
		if (remaining <= 0) break;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), remaining);
		});
		const result = await Promise.race([reader.read(), timeout]);
		clearTimeout(timer);
		if (result === null || result.done) break;
		chunks.push(result.value);
		total += result.value.byteLength;
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
};

const describe_sse_keep_alive_tests = (handle: ReconstructedBootstrappedBackendHandle): void => {
	const setup_test = default_cross_process_setup(handle);
	const { base_url } = handle.config;

	test('an idle stream writes the connect comment, then keep-alives, byte for byte', async () => {
		const fixture = await setup_test();
		const controller = new AbortController();
		const res = await fetch(`${base_url}${SPINE_SSE_PATH}`, {
			headers: {
				Accept: 'text/event-stream',
				Origin: base_url,
				Cookie: fixture.transport.cookies().join('; ')
			},
			signal: controller.signal
		});
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			assert.strictEqual(res.status, 200, 'the keeper subscribes to the audit stream');
			assert.ok(res.body, 'the stream has a body');
			reader = res.body.getReader();
			const expected = encoder.encode(
				SSE_CONNECTED_COMMENT + SSE_KEEP_ALIVE_COMMENT + SSE_KEEP_ALIVE_COMMENT
			);
			const bytes = await read_bytes(reader, expected.byteLength, KEEP_ALIVE_DEADLINE_MS);
			assert.deepStrictEqual(
				bytes.subarray(0, expected.byteLength),
				expected,
				`expected the connect comment and two keep-alives (every ${keep_alive_ms} ms) within ${KEEP_ALIVE_DEADLINE_MS} ms`
			);
		} finally {
			await reader?.cancel().catch(() => {});
			controller.abort();
		}
	});
};

describe('TS spine (node)', () => {
	describe_sse_keep_alive_tests(ts);
});

describe('Rust spine_stub', () => {
	describe_sse_keep_alive_tests(rust);
});
