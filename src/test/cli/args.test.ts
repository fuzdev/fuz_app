import { test, assert, describe } from 'vitest';
import * as s from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';
import { argv_parse, type ParsedArgs } from '@fuzdev/fuz_util/args.ts';

import {
	parse_command_args,
	create_extract_global_flags,
	type ParseCommandArgsResult
} from '#lib/cli/args.ts';

describe('parse_command_args', () => {
	// consumer schemas always include `_` for positional args
	const TestSchema = s.object({
		_: s.with_default_fn(s.array(s.string), () => []),
		name: meta(s.string, { aliases: ['n'] }),
		verbose: s.with_default(s.boolean, false)
	});

	test('parses valid args', () => {
		const remaining: ParsedArgs = { _: [], name: 'hello' };
		const result = parse_command_args(remaining, TestSchema);
		assert.ok(result.ok);
		assert.strictEqual(result.value.name, 'hello');
		assert.strictEqual(result.value.verbose, false);
	});

	test('returns error for missing required fields', () => {
		const remaining: ParsedArgs = { _: [] };
		const result = parse_command_args(remaining, TestSchema);
		assert.ok(!result.ok);
		assert.ok(result.error.length > 0);
	});

	test('returns error for invalid types', () => {
		const remaining: ParsedArgs = { _: [], name: 123 };
		const result: ParseCommandArgsResult<s.Infer<typeof TestSchema>> = parse_command_args(
			remaining,
			TestSchema
		);
		assert.ok(!result.ok);
		assert.ok(result.error.length > 0);
	});

	test('applies defaults', () => {
		const remaining: ParsedArgs = { _: [], name: 'test' };
		const result = parse_command_args(remaining, TestSchema);
		assert.ok(result.ok);
		assert.strictEqual(result.value.verbose, false);
	});

	test('rejects extra keys with object schemas', () => {
		// consumer schemas use `s.object` — unknown keys are rejected
		const remaining: ParsedArgs = { _: [], name: 'test', unknown_flag: true };
		const result = parse_command_args(remaining, TestSchema);
		assert.ok(!result.ok);
		assert.ok(result.error.includes('unknown_flag'));
	});

	test('expands aliases', () => {
		const remaining: ParsedArgs = { _: ['pos'], n: 'hello' };
		const result = parse_command_args(remaining, TestSchema);
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { _: ['pos'], name: 'hello', verbose: false });
	});

	test('formats each issue on a line of its own', () => {
		const remaining: ParsedArgs = { _: [], verbose: 'yes', other: 1 };
		const result = parse_command_args(remaining, TestSchema);
		assert.ok(!result.ok);
		assert.strictEqual(
			result.error,
			[
				'name: expected string, received undefined',
				'verbose: expected boolean, received string',
				'other: expected no unknown keys, received number'
			].join('\n')
		);
	});

	test('defaults `_` to a fresh array on every parse', () => {
		// args without `_`, as a caller's own parser may give them
		const a = parse_command_args({ name: 'a' } as unknown as ParsedArgs, TestSchema);
		const b = parse_command_args({ name: 'b' } as unknown as ParsedArgs, TestSchema);
		assert.ok(a.ok && b.ok);
		assert.deepStrictEqual(a.value._, []);
		assert.notStrictEqual(a.value._, b.value._);
	});
});

describe('create_extract_global_flags', () => {
	const GlobalSchema = s.object({
		verbose: s.with_default(meta(s.boolean, { description: 'show details' }), false),
		help: s.with_default(meta(s.boolean, { aliases: ['h'], description: 'show help' }), false),
		// aliases are read on any wrapper layer of the entry
		version: meta(s.with_default(s.boolean, false), {
			aliases: ['v'],
			description: 'show version'
		})
	});
	type GlobalFlags = s.Infer<typeof GlobalSchema>;
	const fallback: GlobalFlags = { verbose: false, help: false, version: false };

	const extract = create_extract_global_flags(GlobalSchema, fallback);

	test('extracts global flags from args', () => {
		const unparsed: ParsedArgs = { _: ['apply'], verbose: true, target: 'prod' };
		const { flags, remaining } = extract(unparsed);
		assert.strictEqual(flags.verbose, true);
		assert.strictEqual(flags.help, false);
		assert.strictEqual(flags.version, false);
		// remaining should have the command and non-global args
		assert.deepStrictEqual(remaining._, ['apply']);
		assert.strictEqual(remaining.target, 'prod');
		assert.ok(!('verbose' in remaining));
	});

	test('handles aliases', () => {
		const unparsed: ParsedArgs = { _: [], h: true };
		const { flags, remaining } = extract(unparsed);
		assert.strictEqual(flags.help, true);
		// alias should be stripped from remaining
		assert.ok(!('h' in remaining));
	});

	test('passes positionals through', () => {
		const unparsed: ParsedArgs = { _: ['daemon', 'start'] };
		const { flags, remaining } = extract(unparsed);
		assert.strictEqual(flags.verbose, false);
		assert.deepStrictEqual(remaining._, ['daemon', 'start']);
	});

	test('returns fallback on parse failure', () => {
		// pass a non-boolean for verbose to trigger parse failure
		const unparsed: ParsedArgs = { _: [], verbose: 'not-a-bool' };
		const { flags } = extract(unparsed);
		// should get fallback values
		assert.strictEqual(flags.verbose, false);
		assert.strictEqual(flags.help, false);
		assert.strictEqual(flags.version, false);
	});

	test('preserves non-global flags in remaining', () => {
		const unparsed: ParsedArgs = { _: ['apply'], wetrun: true, force: true, help: true };
		const { flags, remaining } = extract(unparsed);
		assert.strictEqual(flags.help, true);
		assert.strictEqual(remaining.wetrun, true);
		assert.strictEqual(remaining.force, true);
		assert.ok(!('help' in remaining));
	});

	test('canonical flag takes precedence over alias', () => {
		const unparsed: ParsedArgs = { _: [], help: true, h: false };
		const { flags } = extract(unparsed);
		assert.strictEqual(flags.help, true);
	});

	test('handles an alias given on the outer wrapper layer', () => {
		const unparsed: ParsedArgs = { _: ['status'], v: true, target: 'prod' };
		const { flags, remaining } = extract(unparsed);
		assert.deepStrictEqual(flags, { verbose: false, help: false, version: true });
		assert.deepStrictEqual(remaining, { _: ['status'], target: 'prod' });
	});

	test('returns fallback when an alias carries an invalid value', () => {
		const unparsed: ParsedArgs = { _: [], h: 'yes', verbose: true };
		const { flags, remaining } = extract(unparsed);
		assert.strictEqual(flags, fallback);
		// global flags are removed from remaining even when they fail to parse
		assert.deepStrictEqual(remaining, { _: [] });
	});

	test('separates globals mixed with command args', () => {
		const CommandSchema = s.object({
			_: s.with_default_fn(s.array(s.string), () => []),
			target: meta(s.string, { aliases: ['t'] }),
			force: s.with_default(s.boolean, false)
		});
		const unparsed: ParsedArgs = { _: ['apply'], verbose: true, t: 'prod', h: true, force: true };
		const { flags, remaining } = extract(unparsed);
		assert.deepStrictEqual(flags, { verbose: true, help: true, version: false });
		const result = parse_command_args(remaining, CommandSchema);
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value, { _: ['apply'], target: 'prod', force: true });
	});

	test('copies `_` into remaining', () => {
		const unparsed: ParsedArgs = { _: ['a', 'b'] };
		const { remaining } = extract(unparsed);
		assert.deepStrictEqual(remaining._, ['a', 'b']);
		assert.notStrictEqual(remaining._, unparsed._);
	});

	test('treats both of a `no-` pair as global', () => {
		const ColorSchema = s.object({
			color: s.with_default(s.boolean, true),
			'no-color': s.with_default(s.boolean, false)
		});
		const extract_color = create_extract_global_flags(ColorSchema, {
			color: true,
			'no-color': false
		});
		// `--no-color` parses to `color: false`
		const negated = extract_color({ _: ['apply'], color: false, target: 'prod' });
		assert.deepStrictEqual(negated.flags, { color: false, 'no-color': true });
		assert.deepStrictEqual(negated.remaining, { _: ['apply'], target: 'prod' });
		const both = extract_color({ _: [], color: true, 'no-color': false });
		assert.deepStrictEqual(both.flags, { color: true, 'no-color': false });
		assert.deepStrictEqual(both.remaining, { _: [] });
	});

	test('reads an alias of either entry of a `no-` pair', () => {
		const ColorSchema = s.object({
			color: s.with_default(meta(s.boolean, { aliases: ['c'] }), true),
			'no-color': s.with_default(meta(s.boolean, { aliases: ['C'] }), false)
		});
		const extract_color = create_extract_global_flags(ColorSchema, {
			color: true,
			'no-color': false
		});
		// `--no-c` parses to `c: false`
		const short = extract_color({ _: [], c: false, target: 'prod' });
		assert.deepStrictEqual(short.flags, { color: false, 'no-color': true });
		assert.deepStrictEqual(short.remaining, { _: [], target: 'prod' });
		const negated = extract_color({ _: [], C: true });
		assert.deepStrictEqual(negated.flags, { color: false, 'no-color': true });
		assert.deepStrictEqual(negated.remaining, { _: [] });
	});

	describe('a `no-` pair given both ways', () => {
		const ColorSchema = s.object({
			color: s.with_default(meta(s.boolean, { aliases: ['c'] }), true),
			'no-color': s.with_default(meta(s.boolean, { aliases: ['C'] }), false),
			verbose: s.with_default(s.boolean, false)
		});
		const extract_color = create_extract_global_flags(ColorSchema, {
			color: true,
			'no-color': false,
			verbose: false
		});

		test('resolves to the side given last', () => {
			// `apply --color -C`
			const negated = extract_color(argv_parse(['apply', '--color', '-C']));
			assert.deepStrictEqual(negated.flags, { color: false, 'no-color': true, verbose: false });
			assert.deepStrictEqual(negated.remaining, { _: ['apply'] });
			// `apply -C --color`
			const colored = extract_color(argv_parse(['apply', '-C', '--color']));
			assert.deepStrictEqual(colored.flags, { color: true, 'no-color': false, verbose: false });
			assert.deepStrictEqual(colored.remaining, { _: ['apply'] });
		});

		test('resolves an alias of a side by where it was given', () => {
			// `-c -C`
			const negated = extract_color(argv_parse(['-c', '-C']));
			assert.deepStrictEqual(negated.flags, { color: false, 'no-color': true, verbose: false });
			assert.deepStrictEqual(negated.remaining, { _: [] });
			// `-C -c`
			const colored = extract_color(argv_parse(['-C', '-c']));
			assert.deepStrictEqual(colored.flags, { color: true, 'no-color': false, verbose: false });
			assert.deepStrictEqual(colored.remaining, { _: [] });
		});

		test('leaves a flag outside the pair unchanged', () => {
			const before = extract_color(argv_parse(['--verbose', '-C', '--color', '--target', 'x']));
			assert.deepStrictEqual(before.flags, { color: true, 'no-color': false, verbose: true });
			assert.deepStrictEqual(before.remaining, { _: [], target: 'x' });
			const after = extract_color(argv_parse(['--color', '-C', '--target', 'x', '--verbose']));
			assert.deepStrictEqual(after.flags, { color: false, 'no-color': true, verbose: true });
			assert.deepStrictEqual(after.remaining, { _: [], target: 'x' });
		});
	});

	test('keeps a `__proto__` arg as an own key of `remaining`', () => {
		const unparsed: ParsedArgs = { _: [], verbose: true };
		Object.defineProperty(unparsed, '__proto__', {
			value: 'x',
			enumerable: true,
			writable: true,
			configurable: true
		});
		const { flags, remaining } = extract(unparsed);
		assert.strictEqual(flags.verbose, true);
		assert.ok(Object.hasOwn(remaining, '__proto__'));
		assert.strictEqual(Object.getPrototypeOf(remaining), Object.prototype);
		const result = parse_command_args(remaining, s.object({ _: s.array(s.string) }));
		assert.ok(!result.ok);
	});

	test('reads no `Object.prototype` member as a given global flag', () => {
		const ProtoSchema = s.object({
			constructor: s.with_default(s.boolean, false)
		});
		// a fallback unlike the default, so a parse failure shows
		const extract_proto = create_extract_global_flags(ProtoSchema, { constructor: true });
		const { flags } = extract_proto({ _: [] });
		assert.deepStrictEqual(flags, { constructor: false });
	});

	test('falls back when either entry of a `no-` pair is invalid', () => {
		const ColorSchema = s.object({
			color: s.with_default(s.boolean, true),
			'no-color': s.with_default(s.boolean, false),
			jobs: s.with_default(s.number, 1)
		});
		const fallback_color = { color: true, 'no-color': false, jobs: 1 };
		const extract_color = create_extract_global_flags(ColorSchema, fallback_color);
		// `--color=maybe --jobs 7`
		const { flags, remaining } = extract_color({ _: [], color: 'maybe', jobs: 7 });
		assert.strictEqual(flags, fallback_color);
		assert.deepStrictEqual(remaining, { _: [] });
	});

	test('works with empty args', () => {
		const unparsed: ParsedArgs = { _: [] };
		const { flags, remaining } = extract(unparsed);
		assert.strictEqual(flags.verbose, false);
		assert.strictEqual(flags.help, false);
		assert.strictEqual(flags.version, false);
		assert.deepStrictEqual(remaining._, []);
	});

	test('of two aliases of one global, the one given first wins', () => {
		const LevelSchema = s.object({
			level: s.with_default(meta(s.string, { aliases: ['l', 'L'] }), 'info')
		});
		const extract_level = create_extract_global_flags(LevelSchema, { level: 'fallback' });
		assert.deepStrictEqual(extract_level(argv_parse(['-L', 'b', '-l', 'a'])).flags, { level: 'b' });
		assert.deepStrictEqual(extract_level(argv_parse(['-l', 'a', '-L', 'b'])).flags, { level: 'a' });
		assert.deepStrictEqual(extract_level(argv_parse(['-L', 'b', '--level', 'z'])).flags, {
			level: 'z'
		});
	});
});
