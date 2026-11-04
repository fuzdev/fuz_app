/**
 * Generic environment loading from `@fuzdev/fuz_schema` object schemas.
 *
 * Provides `load_env`, which reads each key of an object schema with a
 * getter and validates the values. Apps handle error messages themselves
 * (they're always app-specific).
 *
 * @module
 */

import { get_schema_entries } from '@fuzdev/fuz_schema/introspect.ts';
import {
	format_issue,
	parse,
	type Infer,
	type Schema,
	type SchemaIssue
} from '@fuzdev/fuz_schema/schema.ts';

/**
 * Error thrown when environment validation fails.
 *
 * Contains structured information for apps to format their own error messages.
 */
export class EnvValidationError extends Error {
	/** The raw env values that were read, every key of the schema, unset ones as `undefined`. */
	readonly raw: Record<string, string | undefined>;
	/** The validation issues, which hold no env value, only the keys in their paths. */
	readonly issues: Array<SchemaIssue>;
	/** True if every env var was undefined (nothing loaded). */
	readonly all_undefined: boolean;

	constructor(raw: Record<string, string | undefined>, issues: Array<SchemaIssue>) {
		super('Environment validation failed');
		this.raw = raw;
		this.issues = issues;
		this.all_undefined = Object.values(raw).every((v) => v === undefined);
	}

	/**
	 * Format the validation issues as human-readable strings.
	 *
	 * @returns array of formatted issue strings like `"PORT: expected decimal digits, received string"`
	 */
	format_issues(): Array<string> {
		return this.issues.map(format_issue);
	}
}

/**
 * Log formatted env validation issues to stderr.
 *
 * Handles the common case: labels each issue with an optional prefix.
 * Callers who want app-specific "getting started" instructions should check
 * `error.all_undefined` before calling this.
 *
 * @param error - the env validation error
 * @param label - optional prefix for log lines (e.g., 'server', 'env')
 */
export const log_env_validation_error = (error: EnvValidationError, label?: string): void => {
	const prefix = label ? `[${label}] ` : '';
	if (error.all_undefined) {
		console.error(`${prefix}No environment configured.`);
	} else {
		console.error(`${prefix}Invalid environment configuration:`);
		for (const line of error.format_issues()) {
			console.error(`${prefix}  ${line}`);
		}
	}
};

/**
 * Load and validate env vars against a `@fuzdev/fuz_schema` object schema.
 *
 * Reads every key of the schema's entries with `get_env`. An unset var is
 * left out of the object parsed, not given as `undefined`, so it reads as a
 * missing key: a `pipe` that starts with an `optional` runs none of its
 * steps for it, as it would for an absent key of any object. `raw` still
 * lists it, as `undefined`.
 *
 * @param schema - an object schema (`object`, `strip_object`, ..., under any wrappers) of the expected env vars
 * @param get_env - function to read an env var by key
 * @returns validated env object
 * @throws TypeError if `schema` is not an object schema
 * @throws EnvValidationError if validation fails
 */
export const load_env = <T extends Schema<Record<string, unknown>, any>>(
	schema: T,
	get_env: (key: string) => string | undefined
): Infer<T> => {
	const entries = get_schema_entries(schema);
	if (!entries) throw new TypeError(`load_env requires an object schema, got '${schema.kind}'`);
	const raw: Record<string, string | undefined> = {};
	const present: Record<string, string> = {};
	for (const key in entries) {
		const value = get_env(key);
		raw[key] = value;
		if (value !== undefined) present[key] = value;
	}

	const result = parse(schema, present);

	if (!result.ok) {
		throw new EnvValidationError(raw, result.issues);
	}

	return result.value;
};
