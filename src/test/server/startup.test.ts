/**
 * Tests for backend_startup.ts — startup summary helpers.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {log_startup_summary} from '$lib/server/startup.js';
import type {AppSurface} from '$lib/http/surface.js';

const create_surface = (overrides?: Partial<AppSurface>): AppSurface => ({
	middleware: [{name: 'origin', path: '/api/*', error_schemas: null}],
	routes: [
		{
			method: 'GET',
			path: '/health',
			auth: {type: 'none'},
			applicable_middleware: [],
			description: 'Health check',
			is_mutation: false,
			transaction: false,
			rate_limit_key: null,
			params_schema: null,
			query_schema: null,
			input_schema: null,
			output_schema: null,
			error_schemas: null,
		},
		{
			method: 'POST',
			path: '/api/login',
			auth: {type: 'none'},
			applicable_middleware: ['origin'],
			description: 'Login',
			is_mutation: true,
			transaction: true,
			rate_limit_key: null,
			params_schema: null,
			query_schema: null,
			input_schema: {},
			output_schema: {},
			error_schemas: null,
		},
	],
	env: [],
	events: [],
	diagnostics: [],
	...overrides,
});

const create_test_logger = (lines: Array<string>, label = 'server'): Logger =>
	new Logger(label, {
		level: 'info',
		colors: false,
		console: {
			log: (...args: Array<unknown>) => lines.push(args.map(String).join(' ')),
			warn: (...args: Array<unknown>) => lines.push(args.map(String).join(' ')),
			error: (...args: Array<unknown>) => lines.push(args.map(String).join(' ')),
		},
	});

describe('log_startup_summary', () => {
	test('includes route and middleware counts', () => {
		const lines: Array<string> = [];
		const log = create_test_logger(lines);
		log_startup_summary(create_surface(), log);
		assert.strictEqual(lines.length, 1);
		assert.include(lines[0], '2 routes');
		assert.include(lines[0], '1 middleware');
	});

	test('includes env when present', () => {
		const lines: Array<string> = [];
		const log = create_test_logger(lines);
		const surface = create_surface({
			env: [
				{name: 'PORT', description: 'Port', sensitivity: null, has_default: true, optional: true},
				{
					name: 'SECRET',
					description: 'Secret',
					sensitivity: 'secret',
					has_default: false,
					optional: false,
				},
			],
		});
		log_startup_summary(surface, log);
		assert.strictEqual(lines.length, 2);
		assert.include(lines[1], '2 vars');
		assert.include(lines[1], '1 required');
		assert.include(lines[1], '1 secret');
	});

	test('includes events when present', () => {
		const lines: Array<string> = [];
		const log = create_test_logger(lines);
		const surface = create_surface({
			events: [
				{method: 'run_created', description: 'Created', channel: 'runs', params_schema: null},
				{method: 'run_updated', description: 'Updated', channel: 'runs', params_schema: null},
				{method: 'log', description: 'Log', channel: 'logs', params_schema: null},
			],
		});
		log_startup_summary(surface, log);
		assert.strictEqual(lines.length, 2);
		assert.include(lines[1], '3 types');
		assert.include(lines[1], '2 channels');
	});

	test('masks secret env values', () => {
		const lines: Array<string> = [];
		const log = create_test_logger(lines);
		const surface = create_surface({
			env: [
				{name: 'PORT', description: 'Port', sensitivity: null, has_default: true, optional: true},
				{
					name: 'SECRET',
					description: 'Secret',
					sensitivity: 'secret',
					has_default: false,
					optional: false,
				},
			],
		});
		log_startup_summary(surface, log, {PORT: 4040, SECRET: 'hunter2'});
		const port_line = lines.find((l) => l.includes('PORT='));
		const secret_line = lines.find((l) => l.includes('SECRET='));
		assert.ok(port_line);
		assert.include(port_line, '4040');
		assert.ok(secret_line);
		assert.include(secret_line, '***');
		assert.notInclude(secret_line, 'hunter2');
	});

	test('custom prefix works', () => {
		const lines: Array<string> = [];
		const log = create_test_logger(lines, 'tx');
		log_startup_summary(create_surface(), log);
		assert.isTrue(lines[0]!.startsWith('[tx]'));
	});

	test('defaults to [server] prefix', () => {
		const lines: Array<string> = [];
		const log = create_test_logger(lines);
		log_startup_summary(create_surface(), log);
		assert.isTrue(lines[0]!.startsWith('[server]'));
	});

	test('logs diagnostics warnings', () => {
		const lines: Array<string> = [];
		const log = create_test_logger(lines);
		const surface = create_surface({
			diagnostics: [
				{
					level: 'warning',
					category: 'schema',
					message: 'Input not strict',
					source: 'POST /api/foo input',
				},
				{level: 'warning', category: 'security', message: 'Cookie secure=false'},
				{level: 'info', category: 'config', message: 'Rate limiter disabled'},
			],
		});
		log_startup_summary(surface, log);
		const warning_lines = lines.filter((l) => l.includes('warning'));
		assert.ok(warning_lines.length > 0, 'should log warnings');
		assert.ok(
			lines.some((l) => l.includes('2 warning(s)')),
			'should show warning count',
		);
		assert.ok(
			lines.some((l) => l.includes('[schema]')),
			'should show category',
		);
		assert.ok(
			lines.some((l) => l.includes('POST /api/foo input')),
			'should show source',
		);
		assert.ok(
			!lines.some((l) => l.includes('Rate limiter disabled')),
			'should not log info-level diagnostics',
		);
	});

	test('skips diagnostics section when no warnings', () => {
		const lines: Array<string> = [];
		const log = create_test_logger(lines);
		const surface = create_surface({
			diagnostics: [{level: 'info', category: 'config', message: 'Something informational'}],
		});
		log_startup_summary(surface, log);
		assert.ok(
			!lines.some((l) => l.includes('Diagnostics')),
			'should not log diagnostics header for info-only',
		);
	});
});
