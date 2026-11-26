/**
 * Tests for `create_recording_setup_flow_logger` and `setup_flow_log_messages`.
 *
 * @module
 */

import { test, describe, assert } from 'vitest';

import {
	create_recording_setup_flow_logger,
	setup_flow_log_messages
} from '#lib/testing/setup_logger_helpers.ts';
import type { SetupLogger } from '#lib/dev/setup.ts';

describe('create_recording_setup_flow_logger', () => {
	test('records every method, in call order', () => {
		const log = create_recording_setup_flow_logger();
		log.print('heading');
		log.ok('a');
		log.skip('b');
		log.warn('c');
		log.error('d');
		log.print_error('e');
		log.print('');
		assert.deepEqual(log.entries, [
			['print', 'heading'],
			['ok', 'a'],
			['skip', 'b'],
			['warn', 'c'],
			['error', 'd'],
			['print_error', 'e'],
			['print', '']
		]);
	});

	test('records calls made through it as a SetupLogger', () => {
		const log = create_recording_setup_flow_logger();
		const helper_log: SetupLogger = log;
		helper_log.warn('from a helper');
		log.print('from the flow');
		assert.deepEqual(log.entries, [
			['warn', 'from a helper'],
			['print', 'from the flow']
		]);
	});

	test('each recorder has its own entries', () => {
		const a = create_recording_setup_flow_logger();
		const b = create_recording_setup_flow_logger();
		a.ok('x');
		assert.deepEqual(b.entries, []);
	});
});

describe('setup_flow_log_messages', () => {
	test('answers one method’s messages, in order', () => {
		const log = create_recording_setup_flow_logger();
		log.print('one');
		log.ok('skipped over');
		log.print('two');
		assert.deepEqual(setup_flow_log_messages(log, 'print'), ['one', 'two']);
		assert.deepEqual(setup_flow_log_messages(log, 'ok'), ['skipped over']);
		assert.deepEqual(setup_flow_log_messages(log, 'print_error'), []);
	});
});
