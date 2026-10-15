import { test, assert, describe } from 'vitest';
import * as s from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';

import {
	create_help,
	format_arg_default,
	format_arg_name,
	to_help_arg_properties,
	to_max_length
} from '#lib/cli/help.ts';

const GlobalArgs = s.object({
	help: meta(s.with_default(s.boolean, false), { description: 'Show help', aliases: ['h'] }),
	version: meta(s.with_default(s.boolean, false), { description: 'Show version' })
});

const TestCommands = {
	apply: {
		schema: s.object({
			wetrun: meta(s.with_default(s.boolean, false), { description: 'Execute changes' })
		}),
		summary: 'Apply resource changes',
		usage: 'myapp apply [options]',
		category: 'workflow' as const
	},
	status: {
		summary: 'Show current state',
		usage: 'myapp status',
		category: 'info' as const
	},
	version: {
		summary: 'Show version',
		usage: 'myapp version',
		category: 'info' as const
	}
};

type TestCategory = 'workflow' | 'info';

const TestCategories: Array<{ key: TestCategory; title: string }> = [
	{ key: 'workflow', title: 'WORKFLOW' },
	{ key: 'info', title: 'INFO' }
];

const TestExamples = ['myapp apply --wetrun', 'myapp status'];

const create_test_help = (use_colors?: boolean) =>
	create_help<TestCategory>({
		name: 'myapp',
		version: '1.0.0',
		description: 'test application',
		commands: TestCommands,
		categories: TestCategories,
		examples: TestExamples,
		global_args_schema: GlobalArgs,
		use_colors
	});

describe('create_help', () => {
	test('returns all three methods', () => {
		const help = create_test_help();
		assert.strictEqual(typeof help.generate_main_help, 'function');
		assert.strictEqual(typeof help.generate_command_help, 'function');
		assert.strictEqual(typeof help.get_help_text, 'function');
	});
});

describe('generate_main_help', () => {
	test('includes app name and version', () => {
		const { generate_main_help } = create_test_help();
		const text = generate_main_help();
		assert.ok(text.includes('myapp'));
		assert.ok(text.includes('1.0.0'));
		assert.ok(text.includes('test application'));
	});

	test('includes categories', () => {
		const { generate_main_help } = create_test_help();
		const text = generate_main_help();
		assert.ok(text.includes('WORKFLOW'));
		assert.ok(text.includes('INFO'));
	});

	test('includes commands', () => {
		const { generate_main_help } = create_test_help();
		const text = generate_main_help();
		assert.ok(text.includes('Apply resource changes'));
		assert.ok(text.includes('Show current state'));
	});

	test('includes examples', () => {
		const { generate_main_help } = create_test_help();
		const text = generate_main_help();
		assert.ok(text.includes('myapp apply --wetrun'));
		assert.ok(text.includes('myapp status'));
	});

	test('includes global options', () => {
		const { generate_main_help } = create_test_help();
		const text = generate_main_help();
		assert.ok(text.includes('--help'));
		assert.ok(text.includes('--version'));
	});
});

describe('generate_command_help', () => {
	test('includes command name and summary', () => {
		const { generate_command_help } = create_test_help();
		const text = generate_command_help('apply', TestCommands.apply);
		assert.ok(text.includes('myapp apply'));
		assert.ok(text.includes('Apply resource changes'));
	});

	test('includes usage', () => {
		const { generate_command_help } = create_test_help();
		const text = generate_command_help('apply', TestCommands.apply);
		assert.ok(text.includes('myapp apply [options]'));
	});

	test('includes command options from schema', () => {
		const { generate_command_help } = create_test_help();
		const text = generate_command_help('apply', TestCommands.apply);
		assert.ok(text.includes('--wetrun'));
		assert.ok(text.includes('Execute changes'));
	});

	test('includes global options', () => {
		const { generate_command_help } = create_test_help();
		const text = generate_command_help('apply', TestCommands.apply);
		assert.ok(text.includes('Global Options'));
		assert.ok(text.includes('--help'));
	});

	test('handles command with no schema property', () => {
		const { generate_command_help } = create_test_help();
		const text = generate_command_help('status', TestCommands.status);
		assert.ok(text.includes('myapp status'));
		assert.ok(text.includes('Show current state'));
		assert.ok(text.includes('Global Options'));
		assert.ok(text.includes('--help'));
	});
});

describe('get_help_text', () => {
	test('returns main help with no arguments', () => {
		const { get_help_text } = create_test_help();
		const text = get_help_text();
		assert.ok(text.includes('WORKFLOW'));
		assert.ok(text.includes('INFO'));
	});

	test('returns command help for known command', () => {
		const { get_help_text } = create_test_help();
		const text = get_help_text('apply');
		assert.ok(text.includes('Apply resource changes'));
		assert.ok(text.includes('--wetrun'));
	});

	test('returns main help for unknown command', () => {
		const { get_help_text } = create_test_help();
		const text = get_help_text('nonexistent');
		assert.ok(text.includes('WORKFLOW'));
	});

	test('handles subcommands', () => {
		const help = create_help({
			name: 'myapp',
			version: '1.0.0',
			description: 'test',
			commands: {
				'daemon start': { summary: 'Start daemon', usage: 'myapp daemon start', category: 'mgmt' }
			},
			categories: [{ key: 'mgmt', title: 'MANAGEMENT' }],
			examples: [],
			global_args_schema: GlobalArgs
		});
		const text = help.get_help_text('daemon', 'start');
		assert.ok(text.includes('Start daemon'));
	});
});

describe('use_colors: false', () => {
	test('strips ANSI codes from output', () => {
		const { generate_main_help } = create_test_help(false);
		const text = generate_main_help();
		assert.ok(!text.includes('\x1b['));
	});

	test('still includes all content', () => {
		const { generate_main_help } = create_test_help(false);
		const text = generate_main_help();
		assert.ok(text.includes('myapp'));
		assert.ok(text.includes('WORKFLOW'));
		assert.ok(text.includes('Apply resource changes'));
	});
});

describe('to_help_arg_properties', () => {
	test('reads each entry', () => {
		const Args = s.object({
			_: meta(
				s.with_default_fn(s.array(s.string), () => []),
				{ description: 'names' }
			),
			target: s.with_default(
				meta(s.one_of(['dev', 'prod']), { description: 'target env', aliases: ['t'] }),
				'dev'
			),
			tags: s.with_default_fn(s.array(s.string), () => ['a']),
			name: s.optional(s.string)
		});
		assert.deepStrictEqual(to_help_arg_properties(Args), [
			{ name: '_', type: 'Array<string>', description: 'names', default: [], aliases: [] },
			{
				name: 'target',
				type: '"dev" | "prod"',
				description: 'target env',
				default: 'dev',
				aliases: ['t']
			},
			{ name: 'tags', type: 'Array<string>', description: '', default: ['a'], aliases: [] },
			{ name: 'name', type: 'string | undefined', description: '', default: undefined, aliases: [] }
		]);
	});

	test('shows a `no-` pair once, as its negation', () => {
		const Args = s.object({
			color: s.with_default(s.boolean, true),
			'no-color': meta(s.with_default(s.boolean, false), { description: 'opt out of color' })
		});
		assert.deepStrictEqual(
			to_help_arg_properties(Args).map((p) => p.name),
			['no-color']
		);
	});

	test('reads no args of a schema that is not an object', () => {
		assert.deepStrictEqual(to_help_arg_properties(s.string), []);
	});
});

describe('format_arg_default', () => {
	test('formats each kind of value', () => {
		assert.strictEqual(format_arg_default(undefined), '');
		assert.strictEqual(format_arg_default(null), 'null');
		assert.strictEqual(format_arg_default('dev'), '"dev"');
		assert.strictEqual(format_arg_default(''), '""');
		assert.strictEqual(format_arg_default(3), '3');
		assert.strictEqual(format_arg_default(false), 'false');
		assert.strictEqual(format_arg_default([]), '[]');
		assert.strictEqual(format_arg_default(['a', 'b']), '["a","b"]');
		assert.strictEqual(format_arg_default({ a: 1 }), '{"a":1}');
	});
});

describe('format_arg_name', () => {
	test('formats regular flag', () => {
		assert.strictEqual(
			format_arg_name({
				name: 'verbose',
				type: 'boolean',
				description: '',
				default: false,
				aliases: []
			}),
			'--verbose'
		);
	});

	test('includes single-char aliases', () => {
		assert.strictEqual(
			format_arg_name({
				name: 'help',
				type: 'boolean',
				description: '',
				default: false,
				aliases: ['h']
			}),
			'-h, --help'
		);
	});

	test('formats positional as [...args]', () => {
		assert.strictEqual(
			format_arg_name({
				name: '_',
				type: 'Array<string>',
				description: '',
				default: [],
				aliases: []
			}),
			'[...args]'
		);
	});
});

describe('to_max_length', () => {
	test('returns max string length', () => {
		assert.strictEqual(
			to_max_length(['ab', 'abcd', 'a'], (s) => s),
			4
		);
	});

	test('returns 0 for empty array', () => {
		assert.strictEqual(
			to_max_length([], (s: string) => s),
			0
		);
	});
});
