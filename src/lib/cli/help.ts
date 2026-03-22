/**
 * Schema-driven CLI help generator.
 *
 * Generalized from the identical pattern in tx and zzz. Consumers configure
 * once with `create_help` and get back `generate_main_help`,
 * `generate_command_help`, and `get_help_text`.
 *
 * @module
 */

import type {z} from 'zod';
import {
	zod_to_schema_properties,
	zod_format_value,
	type ZodSchemaProperty,
} from '@fuzdev/fuz_util/zod.js';

import {colors} from './util.js';

/**
 * Command metadata for help generation.
 */
export interface CommandMeta<TCategory extends string = string> {
	schema?: z.ZodType;
	summary: string;
	usage: string;
	category: TCategory;
}

/**
 * Category configuration for help display.
 */
export interface HelpCategory<TCategory extends string = string> {
	key: TCategory;
	title: string;
}

/**
 * Configuration for `create_help`.
 */
export interface HelpOptions<TCategory extends string = string> {
	/** Application name (e.g., `"tx"`, `"zzz"`). */
	name: string;
	/** Application version string. */
	version: string;
	/** Short description for the main help header. */
	description: string;
	/** Command registry keyed by command path (e.g., `"apply"`, `"daemon start"`). */
	commands: Record<string, CommandMeta<TCategory>>;
	/** Category display order for main help. */
	categories: Array<HelpCategory<TCategory>>;
	/** Example commands for main help. */
	examples: Array<string>;
	/** Zod schema for global arguments (shown in all help output). */
	global_args_schema: z.ZodType;
	/** Whether to use ANSI colors in output. Defaults to `true`. */
	use_colors?: boolean;
}

/**
 * Help generator returned by `create_help`.
 */
export interface HelpGenerator {
	/** Generate main help text with all commands grouped by category. */
	generate_main_help: () => string;
	/** Generate help text for a specific command. */
	generate_command_help: (command: string, meta: CommandMeta) => string;
	/** Get help text for a command or main help. */
	get_help_text: (command?: string, subcommand?: string) => string;
}

/**
 * Get maximum length from array.
 *
 * @param items - array of items
 * @param to_string - function to convert item to string for length measurement
 * @returns maximum string length
 */
export const to_max_length = <T>(items: Array<T>, to_string: (item: T) => string): number =>
	items.reduce((max, item) => Math.max(to_string(item).length, max), 0);

/**
 * Format argument name with short aliases for display.
 *
 * Only single-char aliases are shown (e.g., `-h, --help`).
 * Flags use snake_case (e.g., `--env_file`, `--detect_only`).
 *
 * @param prop - schema property
 * @returns formatted name string
 */
export const format_arg_name = (prop: ZodSchemaProperty): string => {
	if (prop.name === '_') {
		return '[...args]';
	}
	let name = `--${prop.name}`;
	const short_aliases = prop.aliases.filter((a) => a.length === 1);
	if (short_aliases.length > 0) {
		const alias_str = short_aliases.map((a) => `-${a}`).join(', ');
		name = `${alias_str}, ${name}`;
	}
	return name;
};

/**
 * Create a help generator configured for an application.
 *
 * @param options - help configuration
 * @returns help generator with `generate_main_help`, `generate_command_help`, and `get_help_text`
 */
export const create_help = <TCategory extends string>(
	options: HelpOptions<TCategory>,
): HelpGenerator => {
	const use_colors = options.use_colors !== false;
	const c = use_colors
		? colors
		: {green: '', yellow: '', blue: '', red: '', cyan: '', dim: '', bold: '', reset: ''};

	const generate_global_options = (): Array<string> => {
		const properties = zod_to_schema_properties(options.global_args_schema);
		const max_width = to_max_length(properties, (p) => `  ${format_arg_name(p)}`);

		return properties.map((prop) => {
			const name = format_arg_name(prop);
			const desc = prop.description || '';
			return `  ${name}`.padEnd(max_width + 2) + desc;
		});
	};

	const generate_command_help = (command: string, meta: CommandMeta): string => {
		const lines: Array<string> = [];

		lines.push(`${c.cyan}${options.name} ${command}${c.reset}: ${meta.summary}`);
		lines.push('');
		lines.push(`${c.yellow}Usage${c.reset}: ${meta.usage}`);
		lines.push('');

		if (meta.schema) {
			const properties = zod_to_schema_properties(meta.schema);
			const flag_props = properties.filter((p) => p.name !== '_');
			const positional_prop = properties.find((p) => p.name === '_');

			if (positional_prop?.description) {
				lines.push(`Positional: ${positional_prop.description}`);
				lines.push('');
			}

			if (flag_props.length > 0) {
				lines.push(`${c.yellow}Options${c.reset}:`);

				const longest_name = to_max_length(flag_props, format_arg_name);
				const longest_type = to_max_length(flag_props, (p) => p.type);

				for (const prop of flag_props) {
					const name = format_arg_name(prop).padEnd(longest_name);
					const type = prop.type.padEnd(longest_type);
					const def = zod_format_value(prop.default);
					const desc = prop.description || '';
					const default_str = def ? ` (default: ${def})` : '';
					lines.push(`  ${name}  ${type}  ${desc}${default_str}`);
				}
			}
		}

		// global options
		lines.push('');
		lines.push(`${c.yellow}Global Options${c.reset}:`);
		for (const opt_line of generate_global_options()) {
			lines.push(opt_line);
		}

		return lines.join('\n');
	};

	const generate_main_help = (): string => {
		const lines: Array<string> = [];

		lines.push(`${c.cyan}${options.name}${c.reset} v${options.version} - ${options.description}`);
		lines.push('');

		// categories with commands
		for (const {key, title} of options.categories) {
			const cat_commands = Object.entries(options.commands).filter(
				([_, meta]) => meta.category === key,
			);
			if (cat_commands.length === 0) continue;

			lines.push(`${c.yellow}${title}${c.reset}:`);

			cat_commands.sort(([a], [b]) => a.localeCompare(b));

			const max_usage_width = to_max_length(cat_commands, ([_, meta]) => `  ${meta.usage}`);

			for (const [_, meta] of cat_commands) {
				const padded = `  ${meta.usage}`.padEnd(Math.max(max_usage_width + 2, 40));
				lines.push(`${padded}${meta.summary}`);
			}
			lines.push('');
		}

		// global options
		lines.push(`${c.yellow}OPTIONS${c.reset}:`);
		for (const opt_line of generate_global_options()) {
			lines.push(opt_line);
		}
		lines.push('');

		// examples
		if (options.examples.length > 0) {
			lines.push(`${c.yellow}EXAMPLES${c.reset}:`);
			for (const example of options.examples) {
				lines.push(`  ${example}`);
			}
		}

		return lines.join('\n');
	};

	const get_help_text = (command?: string, subcommand?: string): string => {
		const cmd_key = subcommand ? `${command} ${subcommand}` : command;
		if (cmd_key && options.commands[cmd_key]) {
			return generate_command_help(cmd_key, options.commands[cmd_key]);
		}

		return generate_main_help();
	};

	return {generate_main_help, generate_command_help, get_help_text};
};
