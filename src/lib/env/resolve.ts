/**
 * Environment variable `$$VAR$$` resolution suite.
 *
 * Resolves `$$VAR$$` references in strings and object trees,
 * scans configs for references, and validates/formats missing vars.
 *
 * The double-dollar bookending syntax is:
 * - Visually distinct from shell `$VAR` syntax
 * - Unambiguous about variable boundaries
 * - Easy to grep: `grep '\$\$'`
 * - Fails loud if accidentally shell-processed (`$$`=PID in shell)
 *
 * @module
 */

import type {EnvDeps} from '../runtime/deps.js';

/**
 * Pattern for environment variable references: `$$VAR$$`.
 */
const ENV_VAR_PATTERN = /\$\$([A-Za-z_][A-Za-z0-9_]*)\$\$/g;

/**
 * Resolve environment variable references in a string.
 *
 * Uses `$$VAR$$` syntax (bookended double-dollar signs).
 * Only resolves variables that are actually set in the environment.
 * Unset variables are left as-is for clear error messages.
 *
 * @param runtime - runtime with `env_get` capability
 * @param value - string that may contain `$$VAR$$` references
 * @returns string with env vars resolved
 */
export const resolve_env_vars = (runtime: Pick<EnvDeps, 'env_get'>, value: string): string => {
	return value.replace(ENV_VAR_PATTERN, (match, name: string) => {
		const resolved = runtime.env_get(name);
		// leave unresolved for the validation phase to report
		return resolved !== undefined ? resolved : match;
	});
};

/**
 * Check if a string contains unresolved env var references.
 *
 * @param value - string to check
 * @returns `true` if string contains `$$VAR$$` patterns
 */
export const has_env_vars = (value: string): boolean => {
	// use a fresh regex to avoid global regex lastIndex state issues
	return /\$\$[A-Za-z_][A-Za-z0-9_]*\$\$/.test(value);
};

/**
 * Get list of env var names referenced in a string.
 *
 * @param value - string to scan
 * @returns array of variable names (without `$$` delimiters)
 */
export const get_env_var_names = (value: string): Array<string> => {
	const names: Array<string> = [];
	let match;
	// reset regex lastIndex since it's global
	const pattern = new RegExp(ENV_VAR_PATTERN.source, 'g');
	while ((match = pattern.exec(value)) !== null) {
		names.push(match[1]!);
	}
	return names;
};

/**
 * Resolve env vars in an object's string values (shallow).
 *
 * @param runtime - runtime with `env_get` capability
 * @param obj - object with string values
 * @returns new object with env vars resolved
 */
export const resolve_env_vars_in_object = <T extends Record<string, unknown>>(
	runtime: Pick<EnvDeps, 'env_get'>,
	obj: T,
): T => {
	const result = {...obj} as Record<string, unknown>;
	for (const [key, value] of Object.entries(result)) {
		if (typeof value === 'string') {
			result[key] = resolve_env_vars(runtime, value);
		}
	}
	return result as T;
};

/**
 * Resolve env vars and throw if any are missing/empty.
 *
 * Use this for values that must be present.
 *
 * @param runtime - runtime with `env_get` capability
 * @param value - string with `$$VAR$$` references
 * @param context - description for error message (e.g., `"target.host"`)
 * @returns resolved string
 * @throws error if any referenced env var is missing or empty
 */
export const resolve_env_vars_required = (
	runtime: Pick<EnvDeps, 'env_get'>,
	value: string,
	context: string,
): string => {
	const missing: Array<string> = [];

	const result = value.replace(ENV_VAR_PATTERN, (match, name: string) => {
		const resolved = runtime.env_get(name);
		if (resolved === undefined || resolved === '') {
			missing.push(name);
			return match; // keep original for error message
		}
		return resolved;
	});

	if (missing.length > 0) {
		throw new Error(
			`Missing required environment variable(s) for ${context}: ${missing.join(', ')}`,
		);
	}

	return result;
};

/**
 * An env var reference found in a config.
 */
export interface EnvVarRef {
	/** Variable name (without `$$` delimiters). */
	name: string;
	/** Path where the reference was found (e.g., `"target.host"`, `"resources[3].path"`). */
	path: string;
}

/**
 * Recursively scan an object for `$$VAR$$` env var references.
 *
 * Walks all string values in the object tree and extracts env var names
 * with their path context for error reporting.
 *
 * @param obj - object to scan (typically a config)
 * @returns array of env var references with paths
 */
export const scan_env_vars = (obj: unknown): Array<EnvVarRef> => {
	const refs: Array<EnvVarRef> = [];
	scan_recursive(obj, '', refs);
	return refs;
};

/**
 * Recursive helper for `scan_env_vars`.
 */
const scan_recursive = (value: unknown, path: string, refs: Array<EnvVarRef>): void => {
	if (typeof value === 'string') {
		const names = get_env_var_names(value);
		for (const name of names) {
			refs.push({name, path});
		}
	} else if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			scan_recursive(value[i], `${path}[${i}]`, refs);
		}
	} else if (value !== null && typeof value === 'object') {
		for (const [key, v] of Object.entries(value)) {
			const new_path = path ? `${path}.${key}` : key;
			scan_recursive(v, new_path, refs);
		}
	}
	// primitives (number, boolean, null, undefined) have no env vars
};

/**
 * Result of env var validation.
 *
 * Uses discriminated union for better type narrowing:
 * - `ok: true, missing: null` — all vars present
 * - `ok: false, missing: EnvVarRef[]` — some vars missing
 */
export type EnvValidationResult =
	| {ok: true; missing: null}
	| {ok: false; missing: Array<EnvVarRef>};

/**
 * Validate that all referenced env vars exist in the environment.
 *
 * Returns all missing refs (including duplicates by name). Grouping
 * and deduplication is handled by `format_missing_env_vars` at display time.
 *
 * @param runtime - runtime with `env_get` capability
 * @param refs - env var references from `scan_env_vars`
 * @returns validation result with any missing vars
 */
export const validate_env_vars = (
	runtime: Pick<EnvDeps, 'env_get'>,
	refs: Array<EnvVarRef>,
): EnvValidationResult => {
	let missing: Array<EnvVarRef> | null = null;

	for (const ref of refs) {
		const value = runtime.env_get(ref.name);
		if (value === undefined || value === '') {
			(missing ??= []).push(ref);
		}
	}

	return missing === null ? {ok: true, missing: null} : {ok: false, missing};
};

/**
 * Options for `format_missing_env_vars`.
 */
export interface FormatMissingEnvVarsOptions {
	/** Path to env file if one was loaded. */
	env_file?: string;
	/** Hint text for how to set up the environment. */
	setup_hint?: string;
}

/**
 * Format missing env vars error message.
 *
 * Groups refs by variable name so each missing var is shown once
 * with all paths where it's referenced.
 *
 * @param missing - missing env var references (may contain duplicate names)
 * @param options - formatting options
 * @returns formatted error message for display
 */
export const format_missing_env_vars = (
	missing: Array<EnvVarRef>,
	options?: FormatMissingEnvVarsOptions,
): string => {
	const lines: Array<string> = ['Missing required environment variables:', ''];

	// group by variable name, preserving insertion order
	const grouped: Map<string, Array<string>> = new Map();
	for (const ref of missing) {
		let paths = grouped.get(ref.name);
		if (!paths) {
			paths = [];
			grouped.set(ref.name, paths);
		}
		paths.push(ref.path);
	}

	for (const [name, paths] of grouped) {
		lines.push(`  ${name} - used in ${paths.join(', ')}`);
	}

	lines.push('');
	const env_file = options?.env_file;
	if (env_file) {
		lines.push(`Loaded from: ${env_file}`);
		lines.push(`Add these to your ${env_file} file.`);
		if (options.setup_hint) {
			lines.push(options.setup_hint);
		}
	} else {
		lines.push('Use --env_file to load environment variables from a file.');
	}

	return lines.join('\n');
};
