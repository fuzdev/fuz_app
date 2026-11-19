import '../assert_dev_env.ts';

/**
 * What a response does to the session cookie, read off its `Set-Cookie`
 * lines — shared by the conformance runner (`expect.set_cookie` and its
 * always-on no-mint-on-refusal floor) and the cross-backend differential,
 * which compares the classification across backends since it compares header
 * names, not values.
 *
 * Both readings spell the expected lines through the spine's own formatters
 * (`format_session_clear_cookie`, `format_session_set_cookie`), so the harness
 * and the spine cannot drift apart silently: a clear or a mint whose bytes
 * differ from what the formatters write — an attribute moved, dropped or
 * added — classifies as no effect at all (`null`).
 *
 * @module
 */

import {
	format_session_clear_cookie,
	format_session_set_cookie,
	is_cookie_value
} from '../../auth/session_cookie.ts';

/**
 * What a response does to the session cookie, by its `Set-Cookie` lines for
 * the cookie's name, in order:
 *
 * - `none` — no line for the session cookie
 * - `clear` — exactly one line, the clearing string
 * - `set` — exactly one line minting a cookie: a non-empty value, the fixed
 *   attributes, a positive `Max-Age`
 * - `clear_then_set` — the clear followed by a mint, what a login answers when
 *   the request carried a session cookie that does not verify: the session
 *   middleware prepares the clear before the handler appends the new cookie
 */
export type SessionCookieEffect = 'none' | 'clear' | 'set' | 'clear_then_set';

/** The name a `Set-Cookie` line sets — the text before its first `=`, or `null` with none. */
const set_cookie_name = (line: string): string | null => {
	const eq = line.indexOf('=');
	return eq <= 0 ? null : line.slice(0, eq).trim();
};

/**
 * The `Set-Cookie` lines that name the session cookie, in response order.
 *
 * @param set_cookies - every `Set-Cookie` line of the response, in order
 * @param cookie_name - the session cookie's name
 */
export const filter_session_set_cookies = (
	set_cookies: ReadonlyArray<string>,
	cookie_name: string
): Array<string> => set_cookies.filter((line) => set_cookie_name(line) === cookie_name);

/** The positive integer a `Max-Age=` attribute spells, else `null`. */
const MAX_AGE_REGEX = /;\s*max-age=(\d+)\s*(?:;|$)/i;

/**
 * Whether `line` mints the session cookie byte for byte as
 * `format_session_set_cookie` writes it: a non-empty cookie-octet value and a
 * positive `Max-Age`.
 */
const is_session_mint_line = (line: string, cookie_name: string): boolean => {
	if (!line.startsWith(`${cookie_name}=`)) return false;
	const rest = line.slice(cookie_name.length + 1);
	const semi = rest.indexOf(';');
	if (semi === -1) return false;
	const value = rest.slice(0, semi);
	if (value === '' || !is_cookie_value(value)) return false;
	const max_age_match = MAX_AGE_REGEX.exec(rest);
	if (!max_age_match?.[1]) return false;
	const max_age = Number(max_age_match[1]);
	if (!Number.isSafeInteger(max_age) || max_age <= 0) return false;
	return line === format_session_set_cookie(cookie_name, value, max_age);
};

/**
 * Classify what a response does to the session cookie.
 *
 * @param set_cookies - every `Set-Cookie` line of the response, in order
 * @param cookie_name - the session cookie's name
 * @returns the effect, or `null` when the session cookie's lines are none of
 *   the shapes `SessionCookieEffect` names — two mints, a clear after a mint, a
 *   clear or mint whose bytes differ from the formatters'
 */
export const classify_session_cookie_effect = (
	set_cookies: ReadonlyArray<string>,
	cookie_name: string
): SessionCookieEffect | null => {
	const lines = filter_session_set_cookies(set_cookies, cookie_name);
	const clear = format_session_clear_cookie(cookie_name);
	if (lines.length === 0) return 'none';
	const [first, second] = lines;
	if (lines.length === 1 && first !== undefined) {
		if (first === clear) return 'clear';
		if (is_session_mint_line(first, cookie_name)) return 'set';
		return null;
	}
	if (
		lines.length === 2 &&
		first === clear &&
		second !== undefined &&
		is_session_mint_line(second, cookie_name)
	) {
		return 'clear_then_set';
	}
	return null;
};

/**
 * The `Set-Cookie` lines that would hand the client a session cookie: a line
 * for the session cookie's name whose value is non-empty or whose `Max-Age` is
 * positive. Read loosely, unlike `classify_session_cookie_effect`, so a mint in
 * a shape no formatter writes still counts — this is the floor a refusal is
 * held to, and a malformed mint is still a mint.
 *
 * @param set_cookies - every `Set-Cookie` line of the response, in order
 * @param cookie_name - the session cookie's name
 */
export const find_session_cookie_mints = (
	set_cookies: ReadonlyArray<string>,
	cookie_name: string
): Array<string> =>
	filter_session_set_cookies(set_cookies, cookie_name).filter((line) => {
		const rest = line.slice(line.indexOf('=') + 1);
		const semi = rest.indexOf(';');
		const value = (semi === -1 ? rest : rest.slice(0, semi)).trim();
		if (value !== '') return true;
		const max_age = MAX_AGE_REGEX.exec(rest)?.[1];
		return max_age !== undefined && Number(max_age) > 0;
	});
