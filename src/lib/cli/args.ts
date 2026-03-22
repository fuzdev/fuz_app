/**
 * Shared CLI argument parsing utilities.
 *
 * Provides `parse_command_args` for schema-validated command parsing and
 * `create_extract_global_flags` as a factory for project-specific global flag extraction.
 * Both are used identically across tx, zzz, and mageguild.
 *
 * @module
 */

import {args_parse, type Args, type ParsedArgs, type ArgValue} from '@fuzdev/fuz_util/args.js';
import {z} from 'zod';
import {zod_to_schema_properties, zod_to_schema_names_with_aliases} from '@fuzdev/fuz_util/zod.js';

/**
 * Discriminated union result for CLI argument parsing.
 */
export type ParseResult<T> = {success: true; data: T} | {success: false; error: string};

/**
 * Parse command-specific args against a Zod schema.
 *
 * Validates `remaining` args (after global flag extraction) with alias expansion
 * and returns a typed result or a prettified error string.
 *
 * @param remaining - remaining args after global flag extraction
 * @param schema - Zod schema for the command
 * @returns parse result with typed data or error message
 */
export const parse_command_args = <T extends Record<string, unknown>>(
	remaining: ParsedArgs,
	schema: z.ZodType<T>,
): ParseResult<T> => {
	const parsed = args_parse(remaining as Args, schema as z.ZodType<T & Record<string, ArgValue>>);
	if (!parsed.success) {
		return {success: false, error: z.prettifyError(parsed.error)};
	}
	return {success: true, data: parsed.data as T};
};

/**
 * Create a project-specific global flag extractor.
 *
 * Returns a function that separates global flags from command-specific args.
 * The schema defines which flags are global (with aliases via `.meta({aliases})`),
 * and the fallback provides defaults when parsing fails.
 *
 * @param schema - Zod schema for global flags
 * @param fallback - default values when parsing fails
 * @returns extractor function `(unparsed) => {flags, remaining}`
 */
export const create_extract_global_flags = <T extends Record<string, unknown>>(
	schema: z.ZodType<T>,
	fallback: T,
): ((unparsed: ParsedArgs) => {flags: T; remaining: ParsedArgs}) => {
	return (unparsed: ParsedArgs): {flags: T; remaining: ParsedArgs} => {
		// get all global flag names and aliases from schema
		const global_names = zod_to_schema_names_with_aliases(schema);
		const global_props = zod_to_schema_properties(schema);

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
			schema as z.ZodType<T & Record<string, ArgValue>>,
		);
		const flags: T = global_parsed.success ? (global_parsed.data as T) : fallback;

		// build remaining args without global flags
		const remaining: ParsedArgs = {_: [...unparsed._]};
		for (const [key, value] of Object.entries(unparsed)) {
			if (key === '_') continue;
			if (global_names.has(key)) continue;
			remaining[key] = value;
		}

		return {flags, remaining};
	};
};
