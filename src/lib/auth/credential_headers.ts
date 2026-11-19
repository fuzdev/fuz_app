/**
 * The grammar of the three credential headers — the session cookie in
 * `Cookie`, the API token in `Authorization: Bearer`, the daemon token in
 * `X-Daemon-Token` — as pure readers over header lines.
 *
 * One spelling per credential, the Rust spine's `fuz_auth::credential_headers`
 * reading the same one: a value either reads exactly, or it is not that
 * credential. Nothing is decoded, unquoted, or repaired — a lenient side
 * would authenticate a request the other refuses. The shared table
 * `testing/cross_backend/credential_conformance.json` holds both to the same
 * rows.
 *
 * Each reader takes the header's lines — one field value per header line, in
 * the order sent, outer SP and HTAB already stripped (`get_header_lines` of
 * `http/header_lines.ts` on a request) — so "sent twice" is something a reader
 * can see and decide on.
 *
 * Hono-free: the middleware legs call these, and so does the
 * `_testing_credential_read` action.
 *
 * @module
 */

import { trim_optional_whitespace } from '../http/header_lines.ts';
import { is_api_token_shaped } from './api_token.ts';
import { is_daemon_token_shaped } from './daemon_token.ts';

/** The `Authorization` scheme of an API token, with the one SP that follows it. */
const BEARER_PREFIX = 'bearer ';

/**
 * Read the session cookie's value out of the request's `Cookie` lines.
 *
 * Several `Cookie` lines read as one value joined with `; ` — what Node and
 * Bun hand a handler, and RFC 9113's rule for HTTP/2 cookie crumbs. The value
 * is split on `;`, each pair is stripped of SP and HTAB at both ends (no other
 * byte — not the U+00A0 a `0xA0` arrives as), and the first pair that begins
 * with exactly `<cookie_name>=` wins. Its value is the rest of the pair,
 * verbatim: not percent-decoded, not unquoted, whitespace after the `=` kept.
 * A first pair that will not verify is not skipped for a later one.
 *
 * A pair with an empty value (`name=`) is present, and reads `''` — an
 * invalid cookie to whatever verifies it, not an absent one.
 *
 * @param cookie_lines - the `Cookie` header's lines
 * @param cookie_name - the session cookie's name
 * @returns the cookie's value as sent, or `null` when no pair names it
 */
export const read_session_cookie_value = (
	cookie_lines: ReadonlyArray<string>,
	cookie_name: string
): string | null => {
	const prefix = `${cookie_name}=`;
	// walking the lines in order is reading their `; ` join: the separator
	// holds the `;` the split is on
	for (const line of cookie_lines) {
		for (const part of line.split(';')) {
			const pair = trim_optional_whitespace(part);
			if (pair.startsWith(prefix)) return pair.slice(prefix.length);
		}
	}
	return null;
};

/**
 * Read the API token out of the request's `Authorization` lines.
 *
 * The header must be exactly one line: the scheme `Bearer` in any ASCII case,
 * one SP, and a value `is_api_token_shaped` accepts — nothing before, between,
 * or after. A header sent twice is discarded whatever its lines hold, never
 * resolved to one of them.
 *
 * A runtime that shows no per-line view (`get_header_lines`) hands repeated
 * lines over as one, joined with `, `. No token holds a comma, so the join
 * fails the shape and is discarded as the repeat it is; a lone line that
 * happens to hold `, ` reads the same on both spines.
 *
 * @param authorization_lines - the `Authorization` header's lines
 * @returns the token to look up, or `null` when the header carries none
 */
export const read_bearer_token = (authorization_lines: ReadonlyArray<string>): string | null => {
	if (authorization_lines.length !== 1) return null;
	const value = authorization_lines[0]!;
	if (value.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) return null;
	const token = value.slice(BEARER_PREFIX.length);
	return is_api_token_shaped(token) ? token : null;
};

/**
 * Read the daemon token out of the request's `X-Daemon-Token` lines.
 *
 * The header must be exactly one line holding a value
 * `is_daemon_token_shaped` accepts. A header sent twice is discarded — an
 * empty second line included — and, as for `read_bearer_token`, a join with
 * `, ` fails the shape.
 *
 * @param daemon_token_lines - the `X-Daemon-Token` header's lines
 * @returns the token to compare, or `null` when the header carries none
 */
export const read_daemon_token = (daemon_token_lines: ReadonlyArray<string>): string | null => {
	if (daemon_token_lines.length !== 1) return null;
	const value = daemon_token_lines[0]!;
	return is_daemon_token_shaped(value) ? value : null;
};
