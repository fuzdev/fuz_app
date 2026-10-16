/**
 * Shared CLI argument parsing utilities.
 *
 * Provides `parse_command_args` for schema-validated command parsing and
 * `create_extract_global_flags` as a factory for project-specific global flag extraction.
 *
 * Both take `@fuzdev/fuz_schema` object schemas, the schemas `args_parse` from
 * `@fuzdev/fuz_util/args.ts` reads, with aliases given by `meta(entry, {aliases})`.
 *
 * @module
 */

import { args_parse, type Args, type ParsedArgs, type ArgValue } from '@fuzdev/fuz_util/args.ts';
import { format_issue, type Schema } from '@fuzdev/fuz_schema/schema.ts';
import { get_schema_entries, get_schema_meta } from '@fuzdev/fuz_schema/introspect.ts';

/**
 * Discriminated union result for CLI argument parsing.
 */
export type ParseCommandArgsResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parse command-specific args against a fuz_schema object schema.
 *
 * Validates `remaining` args (after global flag extraction) with alias expansion
 * and returns a typed result or an error string, each issue formatted by
 * `format_issue` on a line of its own.
 *
 * @param remaining - remaining args after global flag extraction
 * @param schema - fuz_schema object schema for the command
 * @returns parse result with the typed value or an error message
 */
export const parse_command_args = <T extends Record<string, unknown>>(
	remaining: ParsedArgs,
	schema: Schema<T, any>
): ParseCommandArgsResult<T> => {
	const parsed = args_parse(remaining as Args, schema as Schema<T & Record<string, ArgValue>, any>);
	if (!parsed.ok) {
		return { ok: false, error: parsed.issues.map(format_issue).join('\n') };
	}
	return { ok: true, value: parsed.value };
};

/**
 * Create a project-specific global flag extractor.
 *
 * Returns a function that separates global flags from command-specific args.
 * The schema defines which flags are global (with aliases via `meta(entry, {aliases})`,
 * read on any wrapper layer of the entry), and the fallback provides defaults
 * when parsing fails. Every entry is global, both of a `no-` pair like `color`
 * and `no-color` included, so `--no-color`, which `argv_parse` reads as
 * `color: false`, never lands in `remaining`. A `no-` pair and aliases resolve
 * as `args_parse` resolves them.
 *
 * @param schema - fuz_schema object schema for global flags
 * @param fallback - default values when parsing fails
 * @returns extractor function `(unparsed) => {flags, remaining}`
 */
export const create_extract_global_flags = <T extends Record<string, unknown>>(
	schema: Schema<T, any>,
	fallback: T
): ((unparsed: ParsedArgs) => { flags: T; remaining: ParsedArgs }) => {
	return (unparsed: ParsedArgs): { flags: T; remaining: ParsedArgs } => {
		// get all global flag names and aliases from schema, `input_names` with
		// those of a `_` entry, which is read but never stripped from `remaining`
		const global_props = to_global_props(schema);
		const global_names: Set<string> = new Set();
		const input_names: Set<string> = new Set();
		for (const prop of global_props) {
			input_names.add(prop.name);
			for (const alias of prop.aliases) input_names.add(alias);
			if (prop.name === '_') continue;
			global_names.add(prop.name);
			for (const alias of prop.aliases) global_names.add(alias);
		}

		// copy the given global flags in the order they were given, aliases included,
		// so `args_parse` expands aliases and resolves a `no-` pair given both ways
		// to the side given last; a null prototype keeps every key an own key
		const flags_input: Record<string, unknown> = Object.create(null);
		for (const [key, value] of Object.entries(unparsed)) {
			if (input_names.has(key)) flags_input[key] = value;
		}

		// parse global flags
		const global_parsed = args_parse(
			flags_input as Args,
			schema as Schema<T & Record<string, ArgValue>, any>
		);
		const flags: T = global_parsed.ok ? global_parsed.value : fallback;

		// build remaining args without global flags, `__proto__` as an own key
		const remaining: ParsedArgs = Object.create(null);
		remaining._ = [...unparsed._];
		for (const [key, value] of Object.entries(unparsed)) {
			if (key === '_') continue;
			if (global_names.has(key)) continue;
			remaining[key] = value;
		}
		Object.setPrototypeOf(remaining, Object.prototype);

		return { flags, remaining };
	};
};

// each entry of an object schema with its aliases, a `no-` pair as two entries
const to_global_props = (
	schema: Schema<any, any>
): Array<{ name: string; aliases: Array<string> }> => {
	const entries = get_schema_entries(schema);
	if (!entries) return [];
	const props: Array<{ name: string; aliases: Array<string> }> = [];
	for (const name in entries) {
		props.push({ name, aliases: get_schema_meta(entries[name]!, 'aliases') ?? [] });
	}
	return props;
};
