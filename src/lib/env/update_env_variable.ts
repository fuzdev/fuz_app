/**
 * Write updates to `.env` files while preserving formatting.
 *
 * @module
 */

import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

/**
 * Options for updating environment variables in a .env file.
 */
export interface UpdateEnvVariableOptions {
	/** Path to the .env file. */
	env_file_path: string;
	/** Function to read file contents (defaults to `node:fs/promises` `readFile`). */
	read_file?: (path: string, encoding: string) => Promise<string>;
	/** Function to write file contents (defaults to `node:fs/promises` `writeFile`). */
	write_file?: (path: string, content: string, encoding: string) => Promise<void>;
}

/**
 * Updates or adds an environment variable in the .env file.
 * Preserves existing formatting, comments, and other variables.
 *
 * Behavior:
 * - **Duplicate keys**: updates the LAST occurrence (matches dotenv behavior)
 * - **Inline comments**: preserved after the value (e.g., `KEY=value # comment`)
 * - **Quote style**: preserved from original (quoted/unquoted)
 *
 * @warning Not atomic; not safe for concurrent writers. Reads the file, mutates
 * in memory, then writes it back — a crash or concurrent write can corrupt
 * the file. Acceptable for single-user, infrequent edits; revisit if a
 * concurrent-writer consumer emerges.
 *
 * @param key - the environment variable name (e.g., `'SOME_CONFIGURATION_KEY'`)
 * @param value - the new value for the environment variable
 * @param options - file path and optional read/write overrides
 * @mutates filesystem - writes the updated content back to `options.env_file_path`
 * @throws Error if the file read fails for any reason other than `ENOENT`, or if the write fails
 */
export const update_env_variable = async (
	key: string,
	value: string,
	options: UpdateEnvVariableOptions,
): Promise<void> => {
	const {env_file_path, read_file = readFile, write_file = writeFile} = options;

	const file_path = resolve(env_file_path);
	let content = '';

	try {
		content = await read_file(file_path, 'utf-8');
	} catch (error: any) {
		if (error?.code !== 'ENOENT') {
			throw error;
		}
	}

	// TODO CRLF: split on `/\r?\n/` + remember per-line delimiter (pinned by edge_cases.test.ts)
	// Preserve trailing-newline state: `split('\n')` on `'a\n'` yields `['a', '']`
	// — drop that trailing empty so appends don't insert a blank line. Re-add
	// the trailing `\n` at the end if the original had one.
	const has_trailing_newline = content.endsWith('\n');
	const lines = content.split('\n');
	if (has_trailing_newline) lines.pop();

	// Find the LAST occurrence of the key (matches dotenv "last wins" behavior)
	const last_match_idx = find_last_key_line_index(lines, key);

	const updated_lines = lines.map((line, idx) => {
		if (idx === last_match_idx) {
			const equals_pos = line.indexOf('=');
			const value_part = line.substring(equals_pos + 1);

			const inline_comment = extract_inline_comment(value_part);
			const trimmed_value = value_part.trim();
			const has_quotes = is_quoted_value(trimmed_value);

			return has_quotes
				? `${key}=${quote_value(value)}${inline_comment}`
				: `${key}=${value}${inline_comment}`;
		}
		return line;
	});

	if (last_match_idx === -1) {
		if (content === '') {
			await write_file(file_path, `${key}=${quote_value(value)}\n`, 'utf-8');
			return;
		}
		updated_lines.push(`${key}=${quote_value(value)}`);
	}

	const updated_content = updated_lines.join('\n') + (has_trailing_newline ? '\n' : '');
	await write_file(file_path, updated_content, 'utf-8');
};

// Keep this tokenization aligned with `parse_dotenv` in `./dotenv.ts`:
// trim, skip empties/comments, split on the first `=`.
const find_last_key_line_index = (lines: Array<string>, key: string): number => {
	if (!key) return -1;
	let last_match_idx = -1;
	lines.forEach((line, idx) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) return;
		const eq_index = trimmed.indexOf('=');
		if (eq_index === -1) return;
		if (trimmed.slice(0, eq_index).trim() === key) last_match_idx = idx;
	});
	return last_match_idx;
};

const extract_inline_comment = (value_part: string): string => {
	const trimmed_value = value_part.trim();

	if (is_quoted_value(trimmed_value)) {
		const quote_char = trimmed_value[0]!;
		let closing_quote_idx = trimmed_value.indexOf(quote_char, 1);

		while (closing_quote_idx > 0 && is_quote_escaped(trimmed_value, closing_quote_idx)) {
			closing_quote_idx = trimmed_value.indexOf(quote_char, closing_quote_idx + 1);
		}

		if (closing_quote_idx !== -1) {
			const after_quote = trimmed_value.substring(closing_quote_idx + 1);
			const comment_match = /(\s*#.*)/.exec(after_quote);
			const captured_comment = comment_match?.[1];
			if (captured_comment) {
				return captured_comment;
			}
		}
	} else {
		// Leading `#` (e.g. `KEY=#c`) — whole trailing text is a comment. Emit
		// with a space separator so it can't merge with the new value and the
		// parser can round-trip the new value cleanly.
		const trimmed_vp = value_part.trimStart();
		if (trimmed_vp.startsWith('#')) return ' ' + trimmed_vp;

		// Require whitespace before `#` — symmetric with `parse_dotenv`, which
		// strips `\s+#...` from unquoted values. URL fragments (no whitespace
		// before `#`) are literal on both sides.
		const comment_match = /(\s+#.*)/.exec(value_part);
		const captured_comment = comment_match?.[1];
		if (captured_comment) {
			return captured_comment;
		}
	}

	return '';
};

/**
 * Checks if a quote character at a specific position is escaped by counting
 * consecutive backslashes before it. An odd count means the quote is escaped.
 */
const is_quote_escaped = (str: string, quote_pos: number): boolean => {
	let backslash_count = 0;
	let pos = quote_pos - 1;

	while (pos >= 0 && str[pos] === '\\') {
		backslash_count++;
		pos--;
	}

	return backslash_count % 2 === 1;
};

const QUOTE_CHARS = ['"', "'"] as const;

const is_quoted_value = (value: string): boolean =>
	QUOTE_CHARS.some((char) => value.startsWith(char));

/**
 * Wraps a value for safe insertion into a double- or single-quoted dotenv line.
 *
 * - Uses `'...'` when the value contains `"` but no `'`, no `\n`, and no `\r`
 *   (single-quoted dotenv values are taken literally — no escape processing,
 *   and a literal newline would break the line into two).
 * - Otherwise uses `"..."` with `\` → `\\`, `"` → `\"`, newline → `\n`, and
 *   CR → `\r` so the line stays a single parseable assignment and round-trips
 *   through `parse_dotenv` losslessly.
 */
const quote_value = (value: string): string => {
	if (value.includes('"') && !value.includes("'") && !has_newline_chars(value)) {
		return `'${value}'`;
	}
	return `"${escape_for_double_quoted(value)}"`;
};

const has_newline_chars = (value: string): boolean => value.includes('\n') || value.includes('\r');

/**
 * Order matters: backslashes must be escaped first so the introduced
 * backslashes from later replacements aren't re-escaped.
 */
const escape_for_double_quoted = (value: string): string =>
	value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
