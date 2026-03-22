/**
 * Tests for env/dotenv.ts — dotenv file parsing and loading.
 *
 * @module
 */

import {test, assert, describe} from 'vitest';

import {parse_dotenv, load_env_file} from '$lib/env/dotenv.js';

describe('parse_dotenv', () => {
	test('parses key=value pairs', () => {
		const result = parse_dotenv('FOO=bar\nBAZ=qux');
		assert.deepStrictEqual(result, {FOO: 'bar', BAZ: 'qux'});
	});

	test('skips comments', () => {
		const result = parse_dotenv('# comment\nFOO=bar');
		assert.deepStrictEqual(result, {FOO: 'bar'});
	});

	test('skips empty lines', () => {
		const result = parse_dotenv('\nFOO=bar\n\nBAZ=qux\n');
		assert.deepStrictEqual(result, {FOO: 'bar', BAZ: 'qux'});
	});

	test('removes double quotes', () => {
		const result = parse_dotenv('FOO="bar baz"');
		assert.deepStrictEqual(result, {FOO: 'bar baz'});
	});

	test('removes single quotes', () => {
		const result = parse_dotenv("FOO='bar baz'");
		assert.deepStrictEqual(result, {FOO: 'bar baz'});
	});

	test('handles values with equals signs', () => {
		const result = parse_dotenv('URL=postgres://host:5432/db?sslmode=require');
		assert.deepStrictEqual(result, {URL: 'postgres://host:5432/db?sslmode=require'});
	});

	test('handles empty values', () => {
		const result = parse_dotenv('FOO=');
		assert.deepStrictEqual(result, {FOO: ''});
	});

	test('skips lines without equals', () => {
		const result = parse_dotenv('no_equals_here\nFOO=bar');
		assert.deepStrictEqual(result, {FOO: 'bar'});
	});

	test('handles \\r\\n line endings', () => {
		const result = parse_dotenv('FOO=bar\r\nBAZ=qux\r\n');
		assert.deepStrictEqual(result, {FOO: 'bar', BAZ: 'qux'});
	});

	test('last value wins for duplicate keys', () => {
		const result = parse_dotenv('FOO=first\nFOO=second');
		assert.deepStrictEqual(result, {FOO: 'second'});
	});

	test('mismatched quotes are not stripped', () => {
		const result = parse_dotenv('FOO="bar\'');
		assert.deepStrictEqual(result, {FOO: '"bar\''});
	});

	test('single quote character is preserved as literal', () => {
		assert.deepStrictEqual(parse_dotenv('FOO="'), {FOO: '"'});
		assert.deepStrictEqual(parse_dotenv("FOO='"), {FOO: "'"});
	});
});

describe('load_env_file', () => {
	test('loads and parses a file', async () => {
		const runtime = {
			read_file: (_path: string) => Promise.resolve('FOO=bar\nBAZ=qux'),
		};
		const result = await load_env_file(runtime, '/some/path');
		assert.deepStrictEqual(result, {FOO: 'bar', BAZ: 'qux'});
	});

	test('returns empty record for empty file', async () => {
		const runtime = {
			read_file: (_path: string) => Promise.resolve(''),
		};
		const result = await load_env_file(runtime, '/empty');
		assert.deepStrictEqual(result, {});
	});

	test('returns null on missing file', async () => {
		const runtime = {
			read_file: (_path: string): Promise<string> => Promise.reject(new Error('not found')),
		};
		const result = await load_env_file(runtime, '/missing');
		assert.strictEqual(result, null);
	});
});
