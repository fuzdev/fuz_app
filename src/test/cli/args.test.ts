import {test, assert, describe} from 'vitest';
import {z} from 'zod';
import type {ParsedArgs} from '@fuzdev/fuz_util/args.js';

import {parse_command_args, create_extract_global_flags, type ParseResult} from '$lib/cli/args.js';

describe('parse_command_args', () => {
	// consumer schemas always include `_` for positional args
	const TestSchema = z.strictObject({
		_: z.array(z.string()).default([]),
		name: z.string(),
		verbose: z.boolean().default(false),
	});

	test('parses valid args', () => {
		const remaining: ParsedArgs = {_: [], name: 'hello'};
		const result = parse_command_args(remaining, TestSchema);
		assert.ok(result.success);
		assert.strictEqual(result.data.name, 'hello');
		assert.strictEqual(result.data.verbose, false);
	});

	test('returns error for missing required fields', () => {
		const remaining: ParsedArgs = {_: []};
		const result = parse_command_args(remaining, TestSchema);
		assert.ok(!result.success);
		assert.ok(result.error.length > 0);
	});

	test('returns error for invalid types', () => {
		const remaining: ParsedArgs = {_: [], name: 123 as unknown as string};
		const result: ParseResult<z.infer<typeof TestSchema>> = parse_command_args(
			remaining,
			TestSchema,
		);
		assert.ok(!result.success);
		assert.ok(result.error.length > 0);
	});

	test('applies defaults', () => {
		const remaining: ParsedArgs = {_: [], name: 'test'};
		const result = parse_command_args(remaining, TestSchema);
		assert.ok(result.success);
		assert.strictEqual(result.data.verbose, false);
	});

	test('rejects extra keys with strictObject schemas', () => {
		// consumer schemas use strictObject — unknown keys are rejected
		const remaining: ParsedArgs = {_: [], name: 'test', unknown_flag: true};
		const result = parse_command_args(remaining, TestSchema);
		assert.ok(!result.success);
		assert.ok(result.error.includes('unknown_flag'));
	});
});

describe('create_extract_global_flags', () => {
	const GlobalSchema = z.strictObject({
		verbose: z.boolean().meta({description: 'show details'}).default(false),
		help: z
			.boolean()
			.meta({aliases: ['h'], description: 'show help'})
			.default(false),
		version: z
			.boolean()
			.meta({aliases: ['v'], description: 'show version'})
			.default(false),
	});
	type GlobalFlags = z.infer<typeof GlobalSchema>;
	const fallback: GlobalFlags = {verbose: false, help: false, version: false};

	const extract = create_extract_global_flags(GlobalSchema, fallback);

	test('extracts global flags from args', () => {
		const unparsed: ParsedArgs = {_: ['apply'], verbose: true, target: 'prod'};
		const {flags, remaining} = extract(unparsed);
		assert.strictEqual(flags.verbose, true);
		assert.strictEqual(flags.help, false);
		assert.strictEqual(flags.version, false);
		// remaining should have the command and non-global args
		assert.deepStrictEqual(remaining._, ['apply']);
		assert.strictEqual(remaining.target, 'prod');
		assert.ok(!('verbose' in remaining));
	});

	test('handles aliases', () => {
		const unparsed: ParsedArgs = {_: [], h: true};
		const {flags, remaining} = extract(unparsed);
		assert.strictEqual(flags.help, true);
		// alias should be stripped from remaining
		assert.ok(!('h' in remaining));
	});

	test('passes positionals through', () => {
		const unparsed: ParsedArgs = {_: ['daemon', 'start']};
		const {flags, remaining} = extract(unparsed);
		assert.strictEqual(flags.verbose, false);
		assert.deepStrictEqual(remaining._, ['daemon', 'start']);
	});

	test('returns fallback on parse failure', () => {
		// pass a non-boolean for verbose to trigger parse failure
		const unparsed: ParsedArgs = {_: [], verbose: 'not-a-bool' as unknown as boolean};
		const {flags} = extract(unparsed);
		// should get fallback values
		assert.strictEqual(flags.verbose, false);
		assert.strictEqual(flags.help, false);
		assert.strictEqual(flags.version, false);
	});

	test('preserves non-global flags in remaining', () => {
		const unparsed: ParsedArgs = {_: ['apply'], wetrun: true, force: true, help: true};
		const {flags, remaining} = extract(unparsed);
		assert.strictEqual(flags.help, true);
		assert.strictEqual(remaining.wetrun, true);
		assert.strictEqual(remaining.force, true);
		assert.ok(!('help' in remaining));
	});

	test('canonical flag takes precedence over alias', () => {
		const unparsed: ParsedArgs = {_: [], help: true, h: false};
		const {flags} = extract(unparsed);
		assert.strictEqual(flags.help, true);
	});

	test('works with empty args', () => {
		const unparsed: ParsedArgs = {_: []};
		const {flags, remaining} = extract(unparsed);
		assert.strictEqual(flags.verbose, false);
		assert.strictEqual(flags.help, false);
		assert.strictEqual(flags.version, false);
		assert.deepStrictEqual(remaining._, []);
	});
});
