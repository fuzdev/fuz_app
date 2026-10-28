/**
 * Write updates to `.env` files while preserving formatting.
 *
 * `update_env_content` is the one env-file writer: a pure line rebuild that
 * `update_env_variable` (read, update, write) and `dev/setup.ts`'s
 * `setup_env_file` both build on, so every value lands quoted and escaped the
 * same way and round-trips through `parse_dotenv`.
 *
 * @module
 */

import type { FsReadDeps, FsRemoveDeps, FsWriteDeps } from '../runtime/deps.ts';
import { write_file_atomic } from '../runtime/fs.ts';

/**
 * Set `key` to `value` in dotenv `content`, returning the new content.
 * Preserves existing formatting, comments, and other variables.
 *
 * Behavior:
 * - **Duplicate keys**: updates the LAST occurrence (matches dotenv behavior)
 * - **Inline comments**: preserved after the value (e.g., `KEY=value # comment`)
 * - **Quote style**: a quoted value stays quoted; an unquoted one stays bare
 *   unless the new value would not read back bare (surrounding whitespace, a
 *   `#` comment marker, a leading quote, a line break), which is quoted
 * - **`export ` prefix**: preserved when updating an `export KEY=…` line
 * - **Absent key**: appended as a quoted assignment
 *
 * The line is rebuilt from its parts, so no character of `value` (`$&`, `` $` ``,
 * `$'`, `\`) is interpreted.
 *
 * @param content - dotenv file content (`''` for a new file)
 * @param key - the environment variable name
 * @param value - the new value
 * @returns the updated content
 */
export const update_env_content = (content: string, key: string, value: string): string => {
	// TODO CRLF: split on `/\r?\n/` + remember per-line delimiter (pinned by edge_cases.test.ts)
	// Preserve trailing-newline state: `split('\n')` on `'a\n'` yields `['a', '']`
	// — drop that trailing empty so appends don't insert a blank line. Re-add
	// the trailing `\n` at the end if the original had one.
	if (content === '') return `${key}=${quote_value(value)}\n`;
	const has_trailing_newline = content.endsWith('\n');
	const lines = content.split('\n');
	if (has_trailing_newline) lines.pop();

	// Find the LAST occurrence of the key (matches dotenv "last wins" behavior)
	const last_match_idx = find_last_key_line_index(lines, key);

	const updated_lines = lines.map((line, idx) => {
		if (idx === last_match_idx) {
			// preserve a leading `export ` (the rest of the line's leading
			// whitespace is normalized away, same as for a plain assignment)
			const export_prefix = line.trimStart().startsWith('export ') ? 'export ' : '';
			const equals_pos = line.indexOf('=');
			const value_part = line.substring(equals_pos + 1);

			const inline_comment = extract_inline_comment(value_part);
			const trimmed_value = value_part.trim();
			const written =
				is_quoted_value(trimmed_value) || !reads_back_bare(value) ? quote_value(value) : value;
			return `${export_prefix}${key}=${written}${inline_comment}`;
		}
		return line;
	});

	if (last_match_idx === -1) {
		updated_lines.push(`${key}=${quote_value(value)}`);
	}

	return updated_lines.join('\n') + (has_trailing_newline ? '\n' : '');
};

/**
 * Updates or adds an environment variable in an env file — read,
 * `update_env_content`, then an atomic replace at mode `0o600` (an env file
 * holds secrets, so the fresh owner-only inode also tightens a permissive
 * hand-made one). A missing file is created.
 *
 * A read-modify-write: a concurrent writer's update can be lost (the last
 * replace wins), though the file is never left half-written.
 *
 * @param deps - file read and write capabilities; pass `remove` too for best-effort temp cleanup on a failed write
 * @param env_path - path to the env file
 * @param key - the environment variable name (e.g., `'SOME_CONFIGURATION_KEY'`)
 * @param value - the new value for the environment variable
 * @mutates filesystem - atomically replaces `env_path` at mode `0o600`
 * @throws Error if the read or the write fails
 */
export const update_env_variable = async (
	deps: FsReadDeps & FsWriteDeps & Partial<FsRemoveDeps>,
	env_path: string,
	key: string,
	value: string
): Promise<void> => {
	const stat = await deps.stat(env_path);
	const content = stat ? await deps.read_text_file(env_path) : '';
	await write_file_atomic(deps, env_path, update_env_content(content, key, value), { mode: 0o600 });
};

// Keep this tokenization aligned with `parse_dotenv` in `env/dotenv.ts`:
// trim, skip empties/comments, strip a leading `export `, split on the first `=`.
const find_last_key_line_index = (lines: Array<string>, key: string): number => {
	if (!key) return -1;
	let last_match_idx = -1;
	lines.forEach((line, idx) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) return;
		const assignment = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
		const eq_index = assignment.indexOf('=');
		if (eq_index === -1) return;
		if (assignment.slice(0, eq_index).trim() === key) last_match_idx = idx;
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
 * Whether `value`, written unquoted, reads back unchanged through
 * `parse_dotenv` — no surrounding whitespace, no leading quote or `#`, no
 * whitespace-then-`#` comment marker, no line break.
 */
const reads_back_bare = (value: string): boolean =>
	value === value.trim() &&
	!has_newline_chars(value) &&
	!is_quoted_value(value) &&
	!value.startsWith('#') &&
	!/\s#/.test(value);

/**
 * Order matters: backslashes must be escaped first so the introduced
 * backslashes from later replacements aren't re-escaped.
 */
const escape_for_double_quoted = (value: string): string =>
	value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
