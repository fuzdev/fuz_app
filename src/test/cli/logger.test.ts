import {test, assert, describe} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_cli_logger} from '$lib/cli/logger.js';

const create_mock_console = (): {
	console: Pick<typeof console, 'error' | 'warn' | 'log'>;
	log_calls: Array<Array<unknown>>;
	warn_calls: Array<Array<unknown>>;
	error_calls: Array<Array<unknown>>;
} => {
	const log_calls: Array<Array<unknown>> = [];
	const warn_calls: Array<Array<unknown>> = [];
	const error_calls: Array<Array<unknown>> = [];
	return {
		console: {
			log: (...args: Array<unknown>) => log_calls.push(args),
			warn: (...args: Array<unknown>) => warn_calls.push(args),
			error: (...args: Array<unknown>) => error_calls.push(args),
		},
		log_calls,
		warn_calls,
		error_calls,
	};
};

describe('create_cli_logger', () => {
	test('returns object with all expected methods', () => {
		const logger = new Logger(undefined, {level: 'info', colors: false});
		const cli = create_cli_logger(logger);

		assert.strictEqual(typeof cli.error, 'function');
		assert.strictEqual(typeof cli.warn, 'function');
		assert.strictEqual(typeof cli.info, 'function');
		assert.strictEqual(typeof cli.debug, 'function');
		assert.strictEqual(typeof cli.raw, 'function');
		assert.strictEqual(typeof cli.success, 'function');
		assert.strictEqual(typeof cli.skip, 'function');
		assert.strictEqual(typeof cli.step, 'function');
		assert.strictEqual(typeof cli.header, 'function');
		assert.strictEqual(typeof cli.dim, 'function');
		assert.strictEqual(cli.logger, logger);
	});

	test('error delegates to logger.error', () => {
		const mock = create_mock_console();
		const logger = new Logger(undefined, {level: 'error', console: mock.console, colors: false});
		const cli = create_cli_logger(logger);

		cli.error('something broke');

		assert.strictEqual(mock.error_calls.length, 1);
		assert.ok(mock.error_calls[0]!.some((a) => a === 'something broke'));
	});

	test('warn delegates to logger.warn', () => {
		const mock = create_mock_console();
		const logger = new Logger(undefined, {level: 'warn', console: mock.console, colors: false});
		const cli = create_cli_logger(logger);

		cli.warn('be careful');

		assert.strictEqual(mock.warn_calls.length, 1);
		assert.ok(mock.warn_calls[0]!.some((a) => a === 'be careful'));
	});

	test('info delegates to logger.info', () => {
		const mock = create_mock_console();
		const logger = new Logger(undefined, {level: 'info', console: mock.console, colors: false});
		const cli = create_cli_logger(logger);

		cli.info('hello');

		assert.strictEqual(mock.log_calls.length, 1);
		assert.ok(mock.log_calls[0]!.some((a) => a === 'hello'));
	});

	test('success calls logger.info with [done] prefix', () => {
		const mock = create_mock_console();
		const logger = new Logger(undefined, {level: 'info', console: mock.console, colors: false});
		const cli = create_cli_logger(logger);

		cli.success('task complete');

		assert.strictEqual(mock.log_calls.length, 1);
		const output = mock.log_calls[0]!.join(' ');
		assert.ok(output.includes('[done]'));
		assert.ok(output.includes('task complete'));
	});

	test('skip calls logger.info with [skip] prefix', () => {
		const mock = create_mock_console();
		const logger = new Logger(undefined, {level: 'info', console: mock.console, colors: false});
		const cli = create_cli_logger(logger);

		cli.skip('already done');

		assert.strictEqual(mock.log_calls.length, 1);
		const output = mock.log_calls[0]!.join(' ');
		assert.ok(output.includes('[skip]'));
		assert.ok(output.includes('already done'));
	});

	test('step calls logger.info with ==> prefix', () => {
		const mock = create_mock_console();
		const logger = new Logger(undefined, {level: 'info', console: mock.console, colors: false});
		const cli = create_cli_logger(logger);

		cli.step('building');

		assert.strictEqual(mock.log_calls.length, 1);
		const output = mock.log_calls[0]!.join(' ');
		assert.ok(output.includes('==>'));
		assert.ok(output.includes('building'));
	});

	test('header calls logger.info with === decoration', () => {
		const mock = create_mock_console();
		const logger = new Logger(undefined, {level: 'info', console: mock.console, colors: false});
		const cli = create_cli_logger(logger);

		cli.header('Deploy');

		assert.strictEqual(mock.log_calls.length, 1);
		const output = mock.log_calls[0]!.join(' ');
		assert.ok(output.includes('=== Deploy ==='));
	});

	test('dim calls logger.info', () => {
		const mock = create_mock_console();
		const logger = new Logger(undefined, {level: 'info', console: mock.console, colors: false});
		const cli = create_cli_logger(logger);

		cli.dim('subtle note');

		assert.strictEqual(mock.log_calls.length, 1);
		const output = mock.log_calls[0]!.join(' ');
		assert.ok(output.includes('subtle note'));
	});

	test('raw outputs without prefix or level filtering', () => {
		const mock = create_mock_console();
		// Use 'off' level — raw should still output even when level suppresses everything
		const logger = new Logger(undefined, {level: 'off', console: mock.console, colors: false});
		const cli = create_cli_logger(logger);

		cli.raw('raw output');

		assert.strictEqual(mock.log_calls.length, 1);
		assert.deepStrictEqual(mock.log_calls[0], ['raw output']);
	});
});

describe('create_cli_logger > level filtering', () => {
	test('semantic methods suppressed when level < info', () => {
		const mock = create_mock_console();
		const logger = new Logger(undefined, {level: 'warn', console: mock.console, colors: false});
		const cli = create_cli_logger(logger);

		cli.success('nope');
		cli.skip('nope');
		cli.step('nope');
		cli.header('nope');
		cli.dim('nope');
		cli.info('nope');

		assert.strictEqual(mock.log_calls.length, 0);
	});

	test('error and warn still work when level is warn', () => {
		const mock = create_mock_console();
		const logger = new Logger(undefined, {level: 'warn', console: mock.console, colors: false});
		const cli = create_cli_logger(logger);

		cli.warn('shown');
		cli.error('also shown');

		assert.strictEqual(mock.warn_calls.length, 1);
		assert.strictEqual(mock.error_calls.length, 1);
	});
});

describe('create_cli_logger > colors', () => {
	test('no ANSI codes when colors disabled', () => {
		const mock = create_mock_console();
		const logger = new Logger(undefined, {level: 'info', console: mock.console, colors: false});
		const cli = create_cli_logger(logger);

		cli.success('done');
		cli.skip('skipped');
		cli.step('stepped');
		cli.header('Title');
		cli.dim('dimmed');

		for (const call of mock.log_calls) {
			const output = call.join(' ');
			assert.ok(!output.includes('\x1b['), `unexpected ANSI code in: ${output}`);
		}
	});

	test('ANSI codes present when colors enabled', () => {
		const mock = create_mock_console();
		const logger = new Logger(undefined, {level: 'info', console: mock.console, colors: true});
		const cli = create_cli_logger(logger);

		cli.success('done');

		const output = mock.log_calls[0]!.join(' ');
		assert.ok(output.includes('\x1b['), 'expected ANSI codes in colored output');
	});
});

describe('create_cli_logger > labeled logger', () => {
	test('logger label appears in delegated methods', () => {
		const mock = create_mock_console();
		const logger = new Logger('myapp', {level: 'info', console: mock.console, colors: false});
		const cli = create_cli_logger(logger);

		cli.info('hello');

		const output = mock.log_calls[0]!.join(' ');
		assert.ok(output.includes('[myapp]'));
		assert.ok(output.includes('hello'));
	});

	test('logger label appears in semantic methods', () => {
		const mock = create_mock_console();
		const logger = new Logger('myapp', {level: 'info', console: mock.console, colors: false});
		const cli = create_cli_logger(logger);

		cli.success('task complete');

		const output = mock.log_calls[0]!.join(' ');
		assert.ok(output.includes('[myapp]'));
		assert.ok(output.includes('[done]'));
	});
});
