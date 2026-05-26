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

	test('escape: \\$$VAR$$ emits literal $$VAR$$ without env lookup', () => {
		let lookups = 0;
		const runtime = {
			env_get: (_name: string) => {
				lookups++;
				return 'should not appear';
			},
		};
		assert.strictEqual(resolve_env_vars(runtime, '\\$$HOST$$'), '$$HOST$$');
		assert.strictEqual(lookups, 0);
	});

	test('escape: mixed escaped and resolved refs in one string', () => {
		const runtime = {env_get: (name: string) => (name === 'ENV' ? 'prod' : undefined)};
		assert.strictEqual(
			resolve_env_vars(runtime, 'docs say \\$$ENV$$, runtime is $$ENV$$'),
			'docs say $$ENV$$, runtime is prod',
		);
	});

	test('optional: $$?VAR$$ resolves to empty when unset', () => {
		const runtime = {env_get: (_name: string) => undefined};
		assert.strictEqual(resolve_env_vars(runtime, '$$?SMTP_PASSWORD$$'), '');
	});

	test('optional: $$?VAR$$ resolves to empty when empty string', () => {
		const runtime = {env_get: (_name: string) => ''};
		assert.strictEqual(resolve_env_vars(runtime, '$$?SMTP_PASSWORD$$'), '');
	});

	test('optional: $$?VAR$$ resolves to value when set', () => {
		const runtime = {env_get: (_name: string) => 'hunter2'};
		assert.strictEqual(resolve_env_vars(runtime, '$$?SMTP_PASSWORD$$'), 'hunter2');
	});

	test('escape + optional: \\$$?VAR$$ emits literal $$?VAR$$', () => {
		const runtime = {env_get: () => 'never used'};
		assert.strictEqual(resolve_env_vars(runtime, '\\$$?FOO$$'), '$$?FOO$$');
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

	test('returns true for $$?VAR$$ (optional)', () => {
		assert.strictEqual(has_env_vars('$$?FOO$$'), true);
	});

	test('returns false for fully-escaped string', () => {
		assert.strictEqual(has_env_vars('\\$$FOO$$'), false);
	});

	test('returns true when escaped and unescaped refs coexist', () => {
		assert.strictEqual(has_env_vars('docs \\$$FOO$$ but $$BAR$$ runs'), true);
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

	test('skips escaped refs', () => {
		assert.deepStrictEqual(get_env_var_names('\\$$FOO$$ and $$BAR$$'), ['BAR']);
	});

	test('extracts names from optional refs without the ? modifier', () => {
		assert.deepStrictEqual(get_env_var_names('$$?FOO$$ and $$BAR$$'), ['FOO', 'BAR']);
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
		assert.strictEqual(refs[0]!.optional, false);
		assert.strictEqual(refs[1]!.name, 'PORT');
		assert.strictEqual(refs[1]!.path, 'nested.port');
		assert.strictEqual(refs[1]!.optional, false);
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

	test('skips escaped refs (\\$$VAR$$)', () => {
		// Mention of $$VAR$$ inside a documentation comment shouldn't trip
		// the scanner — escape avoids the false positive.
		const refs = scan_env_vars({
			template: '# docs reference \\$$SMTP_PASSWORD$$ for setup\nVALUE=$$REAL$$',
		});
		assert.strictEqual(refs.length, 1);
		assert.strictEqual(refs[0]!.name, 'REAL');
	});

	test('marks $$?VAR$$ as optional', () => {
		const refs = scan_env_vars({
			required: '$$FOO$$',
			optional: '$$?BAR$$',
		});
		assert.strictEqual(refs.length, 2);
		const foo = refs.find((r) => r.name === 'FOO')!;
		const bar = refs.find((r) => r.name === 'BAR')!;
		assert.strictEqual(foo.optional, false);
		assert.strictEqual(bar.optional, true);
	});
});

describe('validate_env_vars', () => {
	test('returns ok when all vars exist', () => {
		const runtime = {env_get: (name: string) => (name === 'FOO' ? 'bar' : undefined)};
		const result = validate_env_vars(runtime, [{name: 'FOO', path: 'test', optional: false}]);
		assert.strictEqual(result.ok, true);
	});

	test('returns missing refs', () => {
		const runtime = {env_get: (_name: string) => undefined};
		const result = validate_env_vars(runtime, [{name: 'MISSING', path: 'test', optional: false}]);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.missing.length, 1);
			assert.strictEqual(result.missing[0]!.name, 'MISSING');
		}
	});

	test('treats empty string as missing', () => {
		const runtime = {env_get: (_name: string) => ''};
		const result = validate_env_vars(runtime, [{name: 'EMPTY', path: 'test', optional: false}]);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.missing.length, 1);
			assert.strictEqual(result.missing[0]!.name, 'EMPTY');
		}
	});

	test('skips optional refs even when unset', () => {
		const runtime = {env_get: (_name: string) => undefined};
		const result = validate_env_vars(runtime, [
			{name: 'SMTP_PASSWORD', path: 'env', optional: true},
		]);
		assert.strictEqual(result.ok, true);
	});

	test('skips optional refs even when empty', () => {
		const runtime = {env_get: (_name: string) => ''};
		const result = validate_env_vars(runtime, [
			{name: 'SMTP_PASSWORD', path: 'env', optional: true},
		]);
		assert.strictEqual(result.ok, true);
	});

	test('still flags required missing alongside optional missing', () => {
		const runtime = {env_get: (_name: string) => undefined};
		const result = validate_env_vars(runtime, [
			{name: 'REQUIRED', path: 'a', optional: false},
			{name: 'OPTIONAL', path: 'b', optional: true},
		]);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.missing.length, 1);
			assert.strictEqual(result.missing[0]!.name, 'REQUIRED');
		}
	});
});

describe('format_missing_env_vars', () => {
	test('formats grouped missing vars', () => {
		const result = format_missing_env_vars([
			{name: 'FOO', path: 'a', optional: false},
			{name: 'FOO', path: 'b', optional: false},
			{name: 'BAR', path: 'c', optional: false},
		]);
		assert.include(result, 'FOO - used in a, b');
		assert.include(result, 'BAR - used in c');
	});

	test('includes env_file info when provided', () => {
		const result = format_missing_env_vars([{name: 'X', path: 'p', optional: false}], {
			env_file: '.env.production',
		});
		assert.include(result, 'Loaded from: .env.production');
	});

	test('includes setup_hint when provided', () => {
		const result = format_missing_env_vars([{name: 'X', path: 'p', optional: false}], {
			env_file: '.env.production',
			setup_hint: 'Run `deno task prod:setup` to initialize.',
		});
		assert.include(result, 'Run `deno task prod:setup`');
	});

	test('shows --env_file hint when no env_file given', () => {
		const result = format_missing_env_vars([{name: 'X', path: 'p', optional: false}]);
		assert.include(result, '--env_file');
	});

	test('setup_hint without env_file falls back to --env_file hint', () => {
		const result = format_missing_env_vars([{name: 'X', path: 'p', optional: false}], {
			setup_hint: 'Run setup',
		});
		// setup_hint is only shown when env_file is provided
		assert.notInclude(result, 'Run setup');
		assert.include(result, '--env_file');
	});
});
