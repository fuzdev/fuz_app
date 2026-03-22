/**
 * Generic environment loading from Zod schemas.
 *
 * Provides `load_env` which iterates Zod schema keys, gets env values, and validates.
 * Apps handle error messages themselves (they're always app-specific).
 *
 * @module
 */

import {z} from 'zod';

/**
 * Error thrown when environment validation fails.
 *
 * Contains structured information for apps to format their own error messages.
 */
export class EnvValidationError extends Error {
	/** The raw env values that were read. */
	readonly raw: Record<string, string | undefined>;
	/** The Zod validation error. */
	readonly zod_error: z.core.$ZodError;
	/** True if every env var was undefined (nothing loaded). */
	readonly all_undefined: boolean;

	constructor(raw: Record<string, string | undefined>, zod_error: z.core.$ZodError) {
		super('Environment validation failed');
		this.raw = raw;
		this.zod_error = zod_error;
		this.all_undefined = Object.values(raw).every((v) => v === undefined);
	}

	/**
	 * Format Zod validation issues as human-readable strings.
	 *
	 * @returns array of formatted issue strings like `"PORT: Expected number"`
	 */
	format_issues(): Array<string> {
		return this.zod_error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
	}
}

/**
 * Log formatted env validation issues to stderr.
 *
 * Handles the common case: labels each Zod issue with an optional prefix.
 * Callers who want app-specific "getting started" instructions should check
 * `error.all_undefined` before calling this.
 *
 * @param error - the env validation error
 * @param label - optional prefix for log lines (e.g., 'tx daemon', 'env')
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
 * Load and validate env vars against a Zod schema.
 *
 * Reads each key from the schema using `get_env`, then validates.
 * Throws `EnvValidationError` on failure.
 *
 * @param schema - Zod object schema defining expected env vars
 * @param get_env - function to read an env var by key
 * @returns validated env object
 */
export const load_env = <T extends z.ZodObject>(
	schema: T,
	get_env: (key: string) => string | undefined,
): z.infer<T> => {
	const raw: Record<string, string | undefined> = {};
	for (const key of Object.keys(schema.shape)) {
		raw[key] = get_env(key);
	}

	const result = schema.safeParse(raw);

	if (!result.success) {
		throw new EnvValidationError(raw, result.error);
	}

	return result.data;
};
