/**
 * Dotenv file parsing and loading.
 *
 * Provides `parse_dotenv` for parsing dotenv-format strings
 * and `load_env_file` for reading and parsing env files from disk.
 *
 * @module
 */

import type { FsReadDeps } from '../runtime/deps.ts';

/**
 * Parse a dotenv-format string into a record.
 *
 * Values wrapped in `"..."` have `\\` → `\`, `\"` → `"`, `\n` → newline,
 * and `\r` → carriage-return decoded (symmetric with the writer in
 * `update_env_variable`). Values wrapped in `'...'` are taken literally —
 * no escape processing. Unquoted values are unchanged.
 *
 * Inline comments are stripped after a closing quote (e.g. `KEY="v" # c` → `v`)
 * and after whitespace on unquoted values (e.g. `KEY=v # c` → `v`). Unquoted
 * values keep `#` literal when no whitespace precedes it so URL fragments
 * like `KEY=https://x.com#frag` round-trip unchanged.
 *
 * A leading `export ` on a line is ignored, so a shell-sourceable `.env`
 * (`export KEY=value`) parses identically to a plain `KEY=value`.
 *
 * Trailing whitespace on unquoted values is lost (the raw value is trimmed);
 * wrap the value in `"..."` or `'...'` to preserve surrounding spacing.
 *
 * @param content - dotenv file content
 * @returns parsed key-value pairs
 */
// Line tokenization (trim, skip empties/comments, strip a leading `export `,
// split on first `=`) is mirrored in `update_env_variable.ts`'s
// `find_last_key_line_index`.
export const parse_dotenv = (content: string): Record<string, string> => {
	const result: Record<string, string> = {};
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		// tolerate a leading `export ` so shell-sourceable `.env` files parse
		// the same as plain `KEY=value` ones
		const assignment = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
		const eq_index = assignment.indexOf('=');
		if (eq_index === -1) continue;
		const key = assignment.slice(0, eq_index).trim();
		let value = assignment.slice(eq_index + 1).trim();

		if (value.startsWith('"')) {
			const close = find_closing_double_quote(value);
			if (close !== -1 && is_comment_or_empty_after(value, close)) {
				value = unescape_double_quoted(value.slice(1, close));
			}
		} else if (value.startsWith("'")) {
			const close = value.indexOf("'", 1);
			if (close !== -1 && is_comment_or_empty_after(value, close)) {
				value = value.slice(1, close);
			}
		} else if (value.startsWith('#')) {
			// Leading `#` on an unquoted value means the value is empty and the
			// rest is a comment (`KEY=#c` or `KEY= # c` → `''`).
			value = '';
		} else {
			// Unquoted: strip trailing `\s+#...` so `KEY=v # c` → `v` while
			// `KEY=https://x.com#frag` (no whitespace before `#`) stays literal.
			const comment_idx = value.search(/\s+#/);
			if (comment_idx !== -1) value = value.slice(0, comment_idx).trimEnd();
		}

		result[key] = value;
	}
	return result;
};

/**
 * Find the index of the unescaped closing `"` in a `"..."`-wrapped value.
 * Returns -1 if no closing quote is found. Caller guarantees `value[0] === '"'`.
 */
const find_closing_double_quote = (value: string): number => {
	let i = 1;
	while (i < value.length) {
		const ch = value[i];
		if (ch === '\\' && i + 1 < value.length) {
			i += 2;
			continue;
		}
		if (ch === '"') return i;
		i++;
	}
	return -1;
};

/**
 * Returns true if everything after `pos` (the closing quote) is whitespace
 * or a `# ...` inline comment. Used to decide whether the line is a clean
 * `KEY="value" [# comment]` assignment vs. something we should leave raw.
 */
const is_comment_or_empty_after = (value: string, pos: number): boolean =>
	/^\s*(#.*)?$/.test(value.slice(pos + 1));

/**
 * Single-pass unescape for the inside of a `"..."` dotenv value.
 *
 * Recognizes `\\` → `\`, `\"` → `"`, `\n` → newline, `\r` → CR. Any other
 * backslash is emitted literally. A chained `.replace(/\\\\/g, '\\').replace(...)`
 * would mishandle real-backslash followed by escaped-quote (`\\"` on disk
 * = `[\][\]["]` would collapse to `"` instead of `\"`).
 */
const unescape_double_quoted = (s: string): string => {
	let result = '';
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === '\\' && i + 1 < s.length) {
			const next = s[i + 1];
			if (next === '\\' || next === '"') {
				result += next;
				i += 2;
				continue;
			}
			if (next === 'n') {
				result += '\n';
				i += 2;
				continue;
			}
			if (next === 'r') {
				result += '\r';
				i += 2;
				continue;
			}
		}
		result += ch;
		i++;
	}
	return result;
};

/**
 * Load and parse an env file.
 *
 * Returns null only when the file does not exist. Other read errors
 * (permission denied, I/O failure, etc.) are re-thrown so callers can
 * distinguish "no file" from "couldn't read".
 *
 * @param runtime - runtime with `read_text_file` capability
 * @param path - path to env file
 * @returns parsed env record, or `null` if file doesn't exist
 * @throws Error if reading fails for any reason other than `ENOENT` / `NotFound`
 */
export const load_env_file = async (
	runtime: Pick<FsReadDeps, 'read_text_file'>,
	path: string
): Promise<Record<string, string> | null> => {
	try {
		const content = await runtime.read_text_file(path);
		return parse_dotenv(content);
	} catch (error: any) {
		// Node (`ENOENT`) and Deno (`Deno.errors.NotFound`) — handle both.
		if (error?.code === 'ENOENT' || error?.name === 'NotFound') return null;
		throw error;
	}
};
