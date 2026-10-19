/**
 * Request source verification middleware for API protection.
 *
 * Verifies requests carry an `Origin` the server allows, or none.
 * CSRF protection is `SameSite: strict` on session cookies
 * (see `auth/session_middleware.ts`) plus the CORS simple-request refusal
 * (`http/simple_request.ts`) — `SameSite` alone admits same-site pages, which
 * include every other port on the same host. This module provides origin
 * allowlisting for locally-running services — preventing untrusted websites
 * from making requests as the user browses the web — and is the only gate on
 * the WebSocket upgrade, which is never preflighted.
 *
 * The allowlist grammar is shared with the Rust spine entry for entry:
 * `parse_allowed_origins` accepts and refuses the same entries, naming each
 * refusal with the same `AllowedOriginsErrorKind` string, and an accepted list
 * matches the same origins. The shared conformance table
 * (`testing/cross_backend/origin_conformance.json`) pins both.
 *
 * @module
 */

import { escape_regexp } from '@fuzdev/fuz_util/regexp.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';
import type { Context, Handler } from 'hono';
import { z } from 'zod';

import { ERROR_FORBIDDEN_ORIGIN } from './error_schemas.ts';
import type { MiddlewareCarveOut } from './middleware_spec.ts';
import { middleware_applies } from './schema_helpers.ts';

/**
 * True when the request looks like it originated from a browser context — it
 * carries an `Origin` or `Referer` header. Browsers attach these
 * automatically on the state-changing surface; loopback / CLI clients don't.
 * Uses `!== undefined` so an empty-string header still counts as browser
 * context. Checks `Referer` too (not just `Origin`) because some browser
 * requests send only `Referer`. Twin of the Rust spine's
 * `bearer_auth::is_browser_context`.
 *
 * The bearer (`auth/bearer_auth.ts`) and daemon-token
 * (`auth/daemon_token_middleware.ts`) middleware both silently discard their
 * credential when this is true: a stolen bearer token can't be replayed from a
 * browser, and the loopback daemon token never legitimately carries an
 * `Origin`. Distinct from `verify_request_source` — that gates browser
 * requests against an allowlist; this only detects browser context.
 */
export const is_browser_context = (c: Context): boolean =>
	c.req.header('Origin') !== undefined || c.req.header('Referer') !== undefined;

/**
 * Why one allowlist entry was refused. The wire names both spines emit — the
 * Rust spine's `OriginPatternError::kind` returns the same strings.
 */
export const OriginPatternErrorKind = z.enum([
	'empty_entry',
	'not_printable_ascii',
	'missing_scheme',
	'unsupported_scheme',
	'has_path',
	'has_userinfo',
	'missing_host',
	'invalid_host_char',
	'unbracketed_ipv6',
	'partial_wildcard',
	'non_canonical_ipv4',
	'unclosed_ipv6',
	'invalid_ipv6',
	'invalid_after_ipv6',
	'invalid_port',
	'default_port'
]);
export type OriginPatternErrorKind = z.infer<typeof OriginPatternErrorKind>;

/** Why an allowlist value was refused: `no_origins` (a blank value) or an entry's kind. */
export const AllowedOriginsErrorKind = z.enum(['no_origins', ...OriginPatternErrorKind.options]);
export type AllowedOriginsErrorKind = z.infer<typeof AllowedOriginsErrorKind>;

/** The operator-facing reason for each refusal kind. */
export const ALLOWED_ORIGINS_ERROR_MESSAGES: Readonly<Record<AllowedOriginsErrorKind, string>> = {
	no_origins: 'no origins supplied — list at least one',
	empty_entry: 'it is empty (a stray comma?)',
	not_printable_ascii:
		'an origin is printable ASCII with no spaces (an international hostname is written in its punycode form)',
	missing_scheme: 'it has no `scheme://`',
	unsupported_scheme: 'the scheme is neither http nor https',
	has_path:
		'an origin ends at the host or port — no path, query, or fragment, and no trailing slash',
	has_userinfo: 'an origin carries no userinfo',
	missing_host: 'it has no host',
	invalid_host_char:
		'a hostname holds none of `%`, `\\`, `^`, `|`, `<`, `>`, `[`, `]` (a browser sends it decoded, with no percent-encoding)',
	unbracketed_ipv6: 'an IPv6 address is written in brackets, `[::1]`',
	partial_wildcard: 'a `*` stands for one whole host label, as in `https://*.example.com`',
	non_canonical_ipv4:
		'a host ending in a number is an IPv4 address, which a browser sends as four decimal numbers 0-255 with no leading zeros and no trailing dot',
	unclosed_ipv6: 'the IPv6 address has no closing `]`',
	invalid_ipv6:
		'the bracketed host is not an IPv6 address written the way a browser sends it: hex groups without leading zeros, the longest run of zero groups as `::`, no dotted-quad tail, no zone',
	invalid_after_ipv6: 'only `:port` may follow the IPv6 address',
	invalid_port: 'the port is neither a number in 1-65535 (no leading zeros) nor `*`',
	default_port:
		"it names the scheme's default port, which a browser leaves out of `Origin` and `Host` — write it without the port"
};

/** One reason `parse_allowed_origins` refused a value. */
export interface AllowedOriginsError {
	readonly kind: AllowedOriginsErrorKind;
	/** The refused entry's 1-based position; absent for `no_origins`. */
	readonly index?: number;
	/** The refused entry as given, trimmed; absent for `no_origins`. */
	readonly entry?: string;
}

/** The longest excerpt of a refused entry an error message quotes. */
const ENTRY_EXCERPT_MAX = 200;

/**
 * Render one refusal for a boot error — the entry in double quotes with every
 * character but visible ASCII and the space escaped as `\uXXXX` (and `"` and
 * `\` backslash-escaped), so an env value can't put a control, bidi, or other
 * non-printing character in a log, nor close the quotes it is shown in.
 *
 * @param error - one of `parse_allowed_origins`'s errors
 * @returns the reason as one line
 */
export const format_allowed_origins_error = (error: AllowedOriginsError): string => {
	const reason = ALLOWED_ORIGINS_ERROR_MESSAGES[error.kind];
	if (error.index === undefined) return reason;
	const entry = error.entry ?? '';
	const excerpt =
		entry.length > ENTRY_EXCERPT_MAX ? entry.slice(0, ENTRY_EXCERPT_MAX) + '...' : entry;
	return `entry ${error.index} ${quote_ascii(excerpt)} is refused: ${reason}`;
};

/** Everything outside visible ASCII and the space, plus the quote and backslash. */
const NEEDS_ASCII_ESCAPE = /[^\x20-\x7e]|["\\]/g;

/**
 * `value` in double quotes, ASCII-only: `"` and `\` backslash-escaped, every
 * other UTF-16 code unit outside `\x20-\x7e` as `\uXXXX`.
 */
const quote_ascii = (value: string): string =>
	'"' +
	value.replace(NEEDS_ASCII_ESCAPE, (c) =>
		c === '"' || c === '\\' ? '\\' + c : '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
	) +
	'"';

/** Printable ASCII without the space. */
const VISIBLE_ASCII = /^[\x21-\x7e]*$/;

/** The ASCII whitespace an entry is trimmed of — space, tab, LF, FF, CR. */
const ASCII_WHITESPACE_EDGES = /^[ \t\n\f\r]+|[ \t\n\f\r]+$/g;

const trim_ascii_whitespace = (value: string): string => value.replace(ASCII_WHITESPACE_EDGES, '');

/**
 * Parses an allowlist value (conventionally the `FUZ_ALLOWED_ORIGINS` env var)
 * into regex matchers for request source verification.
 * Origin allowlisting for locally-running services — not the CSRF layer
 * (that's `SameSite: strict` on session cookies plus `http/simple_request.ts`).
 *
 * Entries are comma-separated and trimmed of ASCII whitespace. Each is written
 * the way a browser writes an `Origin` — `scheme://host[:port]` — where a whole
 * host label or the port may be `*`:
 * - Exact origins: `https://api.fuz.dev`, `http://localhost:3000`
 * - Wildcard labels: `https://*.fuz.dev` (each `*` is exactly one label, in any
 *   position — `api.fuz.dev` matches, `fuz.dev` and `a.b.fuz.dev` don't)
 * - Wildcard ports: `http://localhost:*` (any port or none)
 * - IPv6 addresses: `http://[::1]:3000`, `https://[2001:db8::1]` (exact)
 * - Combined: `https://*.fuz.dev:*`
 *
 * Refused, nothing normalized: anything but printable ASCII (punycode an
 * international hostname), a scheme other than http or https (`null`,
 * `file://`, `chrome-extension://`), a path, query, fragment or trailing
 * slash, userinfo, a character no hostname holds, a partial wildcard, an IPv4
 * address not written as four canonical decimal numbers (`127.1`), an IPv6
 * address not in the form a browser sends, a port outside `1..=65535` or with
 * leading zeros, the scheme's default port, and an empty entry. Every refused
 * entry is reported, not just the first.
 *
 * @param raw - the comma-separated allowlist value
 * @returns the matchers, or every refusal — `no_origins` when the value is blank
 */
export const parse_allowed_origins = (
	raw: string
): Result<{ origins: Array<RegExp> }, { errors: Array<AllowedOriginsError> }> => {
	if (trim_ascii_whitespace(raw) === '') {
		return { ok: false, errors: [{ kind: 'no_origins' }] };
	}
	const origins: Array<RegExp> = [];
	const errors: Array<AllowedOriginsError> = [];
	raw.split(',').forEach((part, i) => {
		const entry = trim_ascii_whitespace(part);
		const parsed = origin_pattern_to_regexp(entry);
		if (typeof parsed === 'string') {
			errors.push({ kind: parsed, index: i + 1, entry });
		} else {
			origins.push(parsed);
		}
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, origins };
};

/**
 * Tests if an `Origin` value matches any of the allowed patterns.
 * Pattern matching is case-insensitive (web hosts and schemes are). A value
 * that isn't visible ASCII matches nothing — a browser never sends one.
 */
export const should_allow_origin = (
	origin: string,
	allowed_patterns: ReadonlyArray<RegExp>
): boolean => VISIBLE_ASCII.test(origin) && allowed_patterns.some((p) => p.test(origin));

/**
 * Middleware that verifies the request source against an allowlist.
 *
 * Origin allowlisting (not the CSRF layer — that's `SameSite: strict` cookies
 * plus `http/simple_request.ts`):
 * - Checks the `Origin` header (if present) against the allowlist
 * - Allows requests without an `Origin` header (direct access, curl, etc.)
 * - Refuses an `Origin` that isn't visible ASCII, and a duplicated one — the
 *   runtimes join a repeated header into one value (`a, b`), which carries a
 *   space and so matches nothing
 *
 * Origin-only by design — Fetch spec mandates `Origin` on every unsafe
 * method (POST / PUT / DELETE / PATCH) regardless of `Referrer-Policy`,
 * so every real browser request on the state-changing surface carries it.
 * Non-browser clients (curl, server-to-server, CLI) don't ship auto-
 * attached session cookies, so CSRF isn't the relevant threat there —
 * auth (bearer / daemon token) is the actual control. A Referer fallback
 * would only widen the accepted-shape envelope without closing a real
 * CSRF hole. The Rust spine's `origin_layer` is the twin.
 *
 * `create_app_server` mounts it on every path (`ORIGIN_MIDDLEWARE_PATH`); a
 * request whose path a `carve_outs` entry matches passes unchecked — the named,
 * explicit exception, each with its reason, as the Rust stack's
 * `origin_carve_out` is.
 *
 * @param allowed_patterns - compiled regex patterns from `parse_allowed_origins`
 * @param carve_outs - paths the check skips, matched like a middleware path (`middleware_applies`)
 */
export const verify_request_source =
	(
		allowed_patterns: ReadonlyArray<RegExp>,
		carve_outs: ReadonlyArray<MiddlewareCarveOut> = []
	): Handler =>
	(c, next) => {
		if (carve_outs.some((carve_out) => middleware_applies(carve_out.path, c.req.path))) {
			return next();
		}
		// `!== undefined` so an empty-string Origin is present (abnormal, checked
		// against the allowlist — the empty string never matches)
		const origin = c.req.header('origin');
		if (origin !== undefined && !should_allow_origin(origin, allowed_patterns)) {
			return c.json({ error: ERROR_FORBIDDEN_ORIGIN }, 403);
		}
		// no Origin — direct access (curl, CLI); token auth is the control
		return next();
	};

/**
 * Validates one trimmed entry and compiles it to a matcher, or names its
 * refusal. The checks run in a fixed order and the first that fails names the
 * kind — the Rust spine runs the same order, so both name the same kind.
 *
 * The compiled regex is `^scheme://host(:port)?$`, case-insensitive: an exact
 * label matches itself, a `*` label `[^./:]+` (one non-empty label), a `:*`
 * port `(:\d+)?`.
 */
const origin_pattern_to_regexp = (entry: string): RegExp | OriginPatternErrorKind => {
	if (entry === '') return 'empty_entry';
	if (!VISIBLE_ASCII.test(entry)) return 'not_printable_ascii';
	const scheme_end = entry.indexOf('://');
	if (scheme_end === -1) return 'missing_scheme';
	const scheme = entry.slice(0, scheme_end).toLowerCase();
	if (scheme !== 'http' && scheme !== 'https') return 'unsupported_scheme';
	const authority = entry.slice(scheme_end + 3);
	if (/[/?#]/.test(authority)) return 'has_path';
	if (authority.includes('@')) return 'has_userinfo';

	let host_source: string;
	let port: string | null;
	if (authority.startsWith('[')) {
		const end = authority.indexOf(']');
		if (end === -1) return 'unclosed_ipv6';
		const inner = authority.slice(1, end);
		if (!is_ipv6_origin_form(inner)) return 'invalid_ipv6';
		const rest = authority.slice(end + 1);
		if (rest === '') {
			port = null;
		} else if (rest.startsWith(':')) {
			port = rest.slice(1);
		} else {
			return 'invalid_after_ipv6';
		}
		host_source = escape_regexp(authority.slice(0, end + 1));
	} else {
		const colon = authority.lastIndexOf(':');
		const host = colon === -1 ? authority : authority.slice(0, colon);
		port = colon === -1 ? null : authority.slice(colon + 1);
		if (host === '') return 'missing_host';
		if (host.includes(':')) return 'unbracketed_ipv6';
		if (/[%\\^|<>[\]]/.test(host)) return 'invalid_host_char';
		const labels = host.split('.');
		if (labels.some((label) => label.includes('*') && label !== '*')) return 'partial_wildcard';
		if (!is_canonical_ipv4_or_name(host)) return 'non_canonical_ipv4';
		host_source = labels
			.map((label) => (label === '*' ? '[^./:]+' : escape_regexp(label)))
			.join('\\.');
	}

	let port_source = '';
	if (port === '*') {
		port_source = '(?::\\d+)?';
	} else if (port !== null) {
		if (!/^[1-9]\d*$/.test(port) || Number(port) > 65535) return 'invalid_port';
		if (port === (scheme === 'https' ? '443' : '80')) return 'default_port';
		port_source = ':' + port;
	}

	return new RegExp('^' + escape_regexp(scheme + '://') + host_source + port_source + '$', 'i');
};

/**
 * True when `inner` (a bracketed host without its brackets) is an IPv6 address
 * written exactly as a browser serializes it — lowercase-insensitive hex groups
 * without leading zeros, the first longest run of two or more zero groups as
 * `::`, no dotted-quad tail. The URL parser is the serializer here: an address
 * it rewrites, or can't read, is refused rather than normalized.
 */
const is_ipv6_origin_form = (inner: string): boolean => {
	let hostname: string;
	try {
		hostname = new URL(`http://[${inner}]`).hostname;
	} catch {
		return false;
	}
	return hostname === `[${inner.toLowerCase()}]`;
};

/**
 * False when `host` (no brackets, wildcard labels allowed) is one a browser
 * reads as an IPv4 address and then writes differently. A browser takes any
 * host whose last label is a number — decimal or `0x` hex, one trailing dot
 * aside — for an IPv4 address and sends it as four decimal numbers.
 */
const is_canonical_ipv4_or_name = (host: string): boolean => {
	const name = host.endsWith('.') ? host.slice(0, -1) : host;
	const last = name.slice(name.lastIndexOf('.') + 1);
	const is_number = /^0[xX][0-9a-fA-F]*$/.test(last) || /^\d+$/.test(last);
	if (!is_number) return true;
	// a trailing dot makes a fifth, empty label
	const labels = host.split('.');
	return (
		labels.length === 4 &&
		labels.every(
			(label) => label === '*' || (/^(?:0|[1-9]\d{0,2})$/.test(label) && Number(label) <= 255)
		)
	);
};
