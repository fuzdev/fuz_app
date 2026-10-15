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
 * `color: false`, never lands in `remaining`.
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
		// get all global flag names and aliases from schema
		const global_props = to_global_props(schema);
		const global_names: Set<string> = new Set();
		for (const prop of global_props) {
			if (prop.name === '_') continue;
			global_names.add(prop.name);
			for (const alias of prop.aliases) global_names.add(alias);
		}

		// extract global flag values, handling aliases
		const flags_input: Record<string, unknown> = {};
		for (const prop of global_props) {
			// check canonical name first, then aliases
			if (prop.name in unparsed) {
				flags_input[prop.name] = unparsed[prop.name];
			} else {
				for (const alias of prop.aliases) {
					if (alias in unparsed) {
						flags_input[prop.name] = unparsed[alias];
						break;
					}
				}
			}
		}

		// parse global flags
		const global_parsed = args_parse(
			flags_input as Args,
			schema as Schema<T & Record<string, ArgValue>, any>
		);
		const flags: T = global_parsed.ok ? global_parsed.value : fallback;

		// build remaining args without global flags
		const remaining: ParsedArgs = { _: [...unparsed._] };
		for (const [key, value] of Object.entries(unparsed)) {
			if (key === '_') continue;
			if (global_names.has(key)) continue;
			remaining[key] = value;
		}

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
