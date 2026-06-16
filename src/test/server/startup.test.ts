/**
 * Tests for backend_startup.ts — startup summary helpers.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.ts';

import {log_startup_summary} from '$lib/server/startup.ts';
import type {AppSurface} from '$lib/http/surface.ts';

const create_surface = (overrides?: Partial<AppSurface>): AppSurface => ({
	middleware: [{name: 'origin', path: '/api/*', error_schemas: null}],
	routes: [
		{
			method: 'GET',
			path: '/health',
			auth: {account: 'none', actor: 'none'},
			applicable_middleware: [],
			description: 'Health check',
			is_mutation: false,
			transaction: false,
			raw_body: false,
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
			auth: {account: 'none', actor: 'none'},
			applicable_middleware: ['origin'],
			description: 'Login',
			is_mutation: true,
			transaction: true,
			raw_body: false,
			rate_limit_key: null,
			params_schema: null,
			query_schema: null,
			input_schema: {},
			output_schema: {},
			error_schemas: null,
		},
	],
	rpc_endpoints: [],
	ws_endpoints: [],
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

	test('includes RPC endpoints when present, with endpoint and method counts', () => {
		const lines: Array<string> = [];
		const log = create_test_logger(lines);
		const surface = create_surface({
			rpc_endpoints: [
				{
					path: '/api/rpc',
					methods: [
						{
							name: 'a',
							auth: {account: 'none', actor: 'none'},
							input_schema: null,
							output_schema: {},
							side_effects: false,
							description: '',
							rate_limit_key: null,
						},
						{
							name: 'b',
							auth: {account: 'none', actor: 'none'},
							input_schema: null,
							output_schema: {},
							side_effects: true,
							description: '',
							rate_limit_key: null,
						},
					],
				},
			],
		});
		log_startup_summary(surface, log);
		const rpc_line = lines.find((l) => l.includes('RPC:'));
		assert.ok(rpc_line, 'should log RPC line');
		assert.include(rpc_line, '1 endpoint');
		assert.include(rpc_line, '2 method');
	});

	test('includes WS endpoints when present, with endpoint and method counts', () => {
		const lines: Array<string> = [];
		const log = create_test_logger(lines);
		const surface = create_surface({
			ws_endpoints: [
				{
					path: '/api/ws',
					allowed_origins: [],
					required_roles: [],
					methods: [
						{
							name: 'heartbeat',
							kind: 'request_response',
							auth: {account: 'required', actor: 'none'},
							input_schema: null,
							output_schema: {},
							description: '',
							side_effects: false,
							rate_limit_key: null,
						},
					],
				},
			],
		});
		log_startup_summary(surface, log);
		const ws_line = lines.find((l) => l.includes('WS:'));
		assert.ok(ws_line, 'should log WS line');
		assert.include(ws_line, '1 endpoint');
		assert.include(ws_line, '1 method');
	});

	test('omits RPC and WS lines when both surfaces are empty (no noise on minimal apps)', () => {
		const lines: Array<string> = [];
		const log = create_test_logger(lines);
		log_startup_summary(create_surface(), log);
		assert.isFalse(
			lines.some((l) => l.includes('RPC:')),
			'no RPC line when empty',
		);
		assert.isFalse(
			lines.some((l) => l.includes('WS:')),
			'no WS line when empty',
		);
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
