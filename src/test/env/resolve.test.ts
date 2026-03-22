/**
 * Tests for env/resolve.ts — `$$VAR$$` resolution suite.
 *
 * @module
 */

import {test, assert, describe} from 'vitest';

import {
	resolve_env_vars,
	has_env_vars,
	get_env_var_names,
	resolve_env_vars_in_object,
	resolve_env_vars_required,
	scan_env_vars,
	validate_env_vars,
	format_missing_env_vars,
} from '$lib/env/resolve.js';

describe('resolve_env_vars', () => {
	test('resolves $$VAR$$ patterns', () => {
		const runtime = {env_get: (name: string) => (name === 'HOST' ? '1.2.3.4' : undefined)};
		assert.strictEqual(resolve_env_vars(runtime, '$$HOST$$'), '1.2.3.4');
	});

	test('leaves unresolved vars as-is', () => {
		const runtime = {env_get: (_name: string) => undefined};
		assert.strictEqual(resolve_env_vars(runtime, '$$MISSING$$'), '$$MISSING$$');
	});

	test('resolves multiple vars', () => {
		const env: Record<string, string> = {HOST: 'example.com', PORT: '8080'};
		const runtime = {env_get: (name: string) => env[name]};
		assert.strictEqual(resolve_env_vars(runtime, '$$HOST$$:$$PORT$$'), 'example.com:8080');
	});

	test('resolves vars embedded in text', () => {
		const runtime = {env_get: (name: string) => (name === 'ENV' ? 'prod' : undefined)};
		assert.strictEqual(resolve_env_vars(runtime, 'path/$$ENV$$/file'), 'path/prod/file');
	});
});

describe('has_env_vars', () => {
	test('returns true for strings with $$VAR$$', () => {
		assert.strictEqual(has_env_vars('$$FOO$$'), true);
	});

	test('returns false for strings without env vars', () => {
		assert.strictEqual(has_env_vars('no vars here'), false);
	});

	test('returns false for partial patterns', () => {
		assert.strictEqual(has_env_vars('$$'), false);
		assert.strictEqual(has_env_vars('$FOO$'), false);
	});
});

describe('get_env_var_names', () => {
	test('extracts variable names', () => {
		assert.deepStrictEqual(get_env_var_names('$$FOO$$'), ['FOO']);
	});

	test('extracts multiple names', () => {
		assert.deepStrictEqual(get_env_var_names('$$FOO$$ and $$BAR$$'), ['FOO', 'BAR']);
	});

	test('returns empty for no vars', () => {
		assert.deepStrictEqual(get_env_var_names('no vars'), []);
	});
});

describe('resolve_env_vars_in_object', () => {
	test('resolves string values', () => {
		const runtime = {env_get: (name: string) => (name === 'X' ? 'resolved' : undefined)};
		const result = resolve_env_vars_in_object(runtime, {a: '$$X$$', b: 'plain'});
		assert.deepStrictEqual(result, {a: 'resolved', b: 'plain'});
	});

	test('skips non-string values', () => {
		const runtime = {env_get: () => undefined};
		const result = resolve_env_vars_in_object(runtime, {a: 42, b: true} as any);
		assert.deepStrictEqual(result, {a: 42, b: true});
	});
});

describe('resolve_env_vars_required', () => {
	test('resolves when all vars present', () => {
		const runtime = {env_get: (name: string) => (name === 'FOO' ? 'bar' : undefined)};
		assert.strictEqual(resolve_env_vars_required(runtime, '$$FOO$$', 'test'), 'bar');
	});

	test('throws when vars are missing', () => {
		const runtime = {env_get: (_name: string) => undefined};
		assert.throws(
			() => resolve_env_vars_required(runtime, '$$MISSING$$', 'test.field'),
			/Missing required environment variable.*MISSING/,
		);
	});

	test('throws when vars are empty', () => {
		const runtime = {env_get: (_name: string) => ''};
		assert.throws(() => resolve_env_vars_required(runtime, '$$EMPTY$$', 'test'));
	});

	test('throws listing all missing vars when multiple are missing', () => {
		const runtime = {env_get: (_name: string) => undefined};
		assert.throws(
			() => resolve_env_vars_required(runtime, '$$FOO$$ and $$BAR$$', 'test.field'),
			/FOO.*BAR|BAR.*FOO/,
		);
	});
});

describe('scan_env_vars', () => {
	test('finds vars in nested objects', () => {
		const refs = scan_env_vars({host: '$$HOST$$', nested: {port: '$$PORT$$'}});
		assert.strictEqual(refs.length, 2);
		assert.strictEqual(refs[0]!.name, 'HOST');
		assert.strictEqual(refs[0]!.path, 'host');
		assert.strictEqual(refs[1]!.name, 'PORT');
		assert.strictEqual(refs[1]!.path, 'nested.port');
	});

	test('finds vars in arrays', () => {
		const refs = scan_env_vars({items: ['$$A$$', '$$B$$']});
		assert.strictEqual(refs.length, 2);
		assert.strictEqual(refs[0]!.path, 'items[0]');
		assert.strictEqual(refs[1]!.path, 'items[1]');
	});

	test('skips non-string values', () => {
		const refs = scan_env_vars({num: 42, bool: true, nil: null});
		assert.strictEqual(refs.length, 0);
	});
});

describe('validate_env_vars', () => {
	test('returns ok when all vars exist', () => {
		const runtime = {env_get: (name: string) => (name === 'FOO' ? 'bar' : undefined)};
		const result = validate_env_vars(runtime, [{name: 'FOO', path: 'test'}]);
		assert.strictEqual(result.ok, true);
	});

	test('returns missing refs', () => {
		const runtime = {env_get: (_name: string) => undefined};
		const result = validate_env_vars(runtime, [{name: 'MISSING', path: 'test'}]);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.missing.length, 1);
			assert.strictEqual(result.missing[0]!.name, 'MISSING');
		}
	});

	test('treats empty string as missing', () => {
		const runtime = {env_get: (_name: string) => ''};
		const result = validate_env_vars(runtime, [{name: 'EMPTY', path: 'test'}]);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.missing.length, 1);
			assert.strictEqual(result.missing[0]!.name, 'EMPTY');
		}
	});
});

describe('format_missing_env_vars', () => {
	test('formats grouped missing vars', () => {
		const result = format_missing_env_vars([
			{name: 'FOO', path: 'a'},
			{name: 'FOO', path: 'b'},
			{name: 'BAR', path: 'c'},
		]);
		assert.ok(result.includes('FOO - used in a, b'));
		assert.ok(result.includes('BAR - used in c'));
	});

	test('includes env_file info when provided', () => {
		const result = format_missing_env_vars([{name: 'X', path: 'p'}], {
			env_file: '.env.production',
		});
		assert.ok(result.includes('Loaded from: .env.production'));
	});

	test('includes setup_hint when provided', () => {
		const result = format_missing_env_vars([{name: 'X', path: 'p'}], {
			env_file: '.env.production',
			setup_hint: 'Run `deno task prod:setup` to initialize.',
		});
		assert.ok(result.includes('Run `deno task prod:setup`'));
	});

	test('shows --env_file hint when no env_file given', () => {
		const result = format_missing_env_vars([{name: 'X', path: 'p'}]);
		assert.ok(result.includes('--env_file'));
	});

	test('setup_hint without env_file falls back to --env_file hint', () => {
		const result = format_missing_env_vars([{name: 'X', path: 'p'}], {
			setup_hint: 'Run setup',
		});
		// setup_hint is only shown when env_file is provided
		assert.ok(!result.includes('Run setup'));
		assert.ok(result.includes('--env_file'));
	});
});
