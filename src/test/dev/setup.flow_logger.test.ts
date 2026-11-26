/**
 * Tests for `default_setup_flow_logger` in dev/setup.ts — each method's stream and text.
 *
 * @module
 */

import { test, describe, assert, vi, afterEach } from 'vitest';

import { default_setup_flow_logger, type SetupFlowLogger } from '#lib/dev/setup.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

/** Call one method with console stubbed, returning what each stream got. */
const capture = (
	method: keyof SetupFlowLogger,
	msg: string
): { log: Array<unknown>; warn: Array<unknown>; error: Array<unknown> } => {
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const error = vi.spyOn(console, 'error').mockImplementation(() => {});
	default_setup_flow_logger[method](msg);
	return { log: log.mock.calls, warn: warn.mock.calls, error: error.mock.calls };
};

describe('default_setup_flow_logger', () => {
	const cases: Array<[keyof SetupFlowLogger, 'log' | 'warn' | 'error', string]> = [
		['ok', 'log', '  [ok] the msg'],
		['skip', 'log', '  [skip] the msg'],
		['warn', 'warn', '  [warn] the msg'],
		['error', 'error', '  [error] the msg'],
		['print', 'log', 'the msg'],
		['print_error', 'error', 'the msg']
	];
	for (const [method, stream, expected] of cases) {
		test(`${method} writes to console.${stream}`, () => {
			const calls = capture(method, 'the msg');
			for (const s of ['log', 'warn', 'error'] as const) {
				assert.deepEqual(calls[s], s === stream ? [[expected]] : [], `console.${s}`);
			}
		});
	}

	test('print of an empty string prints a blank line', () => {
		assert.deepEqual(capture('print', '').log, [['']]);
	});
});
