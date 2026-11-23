/**
 * Tests for `backend_log.ts` — which lines of a backend's output are
 * error-level, and the allowances over them.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	create_log_line_splitter,
	find_unexpected_backend_errors,
	format_unexpected_backend_errors,
	is_backend_error_line,
	SPINE_CROSS_SUITE_BACKEND_ERRORS,
	with_backend_log_allowances,
	type BackendLogConfig
} from '#lib/testing/cross_backend/backend_log.ts';

describe('is_backend_error_line', () => {
	test('reads a Logger error and a tracing ERROR event', () => {
		assert.ok(is_backend_error_line('🞩error🞩 [server] boom'));
		assert.ok(is_backend_error_line('2026-11-23T02:19:40.189930Z ERROR fuz_auth::bootstrap: boom'));
	});

	test("reads a Rust panic's first line, which no tracing event carries", () => {
		assert.ok(
			is_backend_error_line(
				"thread 'tokio-runtime-worker' panicked at crates/fuz_realtime/src/ws.rs:12:5:"
			)
		);
		assert.ok(!is_backend_error_line('a thread that panicked at nothing'));
	});

	test('reads no other level, and no ERROR outside the level position', () => {
		for (const line of [
			'⚑warn⚑ [server] careful',
			'2026-11-23T02:19:40.189930Z  WARN fuz_auth: careful',
			'2026-11-23T02:19:40.189930Z  INFO fuz_auth: ERROR in a message',
			'[server] Listening',
			'!!! RATE LIMITERS DISABLED — test-only mode.'
		]) {
			assert.ok(!is_backend_error_line(line), line);
		}
	});
});

describe('create_log_line_splitter', () => {
	test('answers whole lines and keeps a partial one for the next chunk', () => {
		const splitter = create_log_line_splitter();
		assert.strictEqual(splitter.push(Buffer.from('a\nb')), 'a\n');
		assert.strictEqual(splitter.push(Buffer.from('c\nd')), 'bc\n');
		assert.strictEqual(splitter.end(), 'd\n');
		assert.strictEqual(splitter.end(), '');
	});

	test('decodes a character split across chunks, so a Logger error line stays one', () => {
		const line = Buffer.from('🞩error🞩 [server] split\n');
		// the first character is four bytes: cut inside it
		const splitter = create_log_line_splitter();
		const text =
			splitter.push(line.subarray(0, 2)) + splitter.push(line.subarray(2)) + splitter.end();
		assert.strictEqual(text, '🞩error🞩 [server] split\n');
		assert.ok(is_backend_error_line(text.trimEnd()));
	});

	test('ends a character cut off at the stream end as a replacement', () => {
		const splitter = create_log_line_splitter();
		assert.strictEqual(splitter.push(Buffer.from('🞩').subarray(0, 2)), '');
		assert.strictEqual(splitter.end(), '\ufffd\n');
	});
});

describe('find_unexpected_backend_errors', () => {
	const text = [
		'\u001b[2m2026-11-23T02:19:40.189930Z\u001b[0m \u001b[31mERROR\u001b[0m tower_http::trace::on_failure: response failed',
		'🞩error🞩 [server] JSON parse error: SyntaxError\r',
		'🞩error🞩 [server] an undeclared failure',
		'2026-11-23T02:19:40.189930Z  INFO request: fine'
	].join('\n');

	test('strips ANSI escapes and line-end carriage returns, and drops allowed lines', () => {
		assert.deepStrictEqual(
			find_unexpected_backend_errors(text, [
				{ pattern: 'tower_http::trace::on_failure', reason: 'a 500 on purpose' },
				{ pattern: 'JSON parse error', reason: 'a malformed frame on purpose' }
			]),
			['🞩error🞩 [server] an undeclared failure']
		);
	});

	test('reports every error line with no allowances, in order', () => {
		assert.strictEqual(find_unexpected_backend_errors(text, []).length, 3);
	});

	test('names the backend and its log', () => {
		const message = format_unexpected_backend_errors('ts_spine_node', '/tmp/x/backend.log', ['a']);
		assert.include(message, 'spawn_backend(ts_spine_node)');
		assert.include(message, '/tmp/x/backend.log');
	});
});

describe('SPINE_CROSS_SUITE_BACKEND_ERRORS', () => {
	test('each names a pattern and its reason', () => {
		for (const { pattern, reason } of SPINE_CROSS_SUITE_BACKEND_ERRORS) {
			assert.ok(pattern.length > 0);
			assert.ok(reason.trim().length > 0, pattern);
		}
	});
});

describe('with_backend_log_allowances', () => {
	test("adds to a log's allowances and leaves a config with no log as it is", () => {
		const a = { pattern: 'a', reason: 'r' };
		const b = { pattern: 'b', reason: 'r' };
		const config = { name: 'x', log: { path: '/tmp/x.log', allow_errors: [a] } };
		assert.deepStrictEqual(with_backend_log_allowances(config, [b]).log.allow_errors, [a, b]);
		assert.deepStrictEqual(config.log.allow_errors, [a], 'the config is not mutated');
		const bare: { name: string; log?: BackendLogConfig } = { name: 'y' };
		assert.strictEqual(with_backend_log_allowances(bare, [b]), bare);
	});
});
