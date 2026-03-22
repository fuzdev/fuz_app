/**
 * Environment value display formatting with secret masking.
 *
 * Provides utilities for safely displaying env values in logs
 * and startup summaries, masking secrets with a placeholder.
 *
 * @module
 */

/** Placeholder displayed in place of secret values. */
export const MASKED_VALUE = '***';

/**
 * Format an env value for display, masking secrets.
 *
 * @param value - the env value to format
 * @param secret - whether the value is secret and should be masked
 * @returns display string — masked placeholder for secrets, string values as-is, non-strings JSON-stringified
 */
export const format_env_display_value = (value: unknown, secret: boolean): string => {
	if (secret) return MASKED_VALUE;
	if (typeof value === 'string') return value;
	if (value === undefined) return 'undefined';
	return JSON.stringify(value);
};
