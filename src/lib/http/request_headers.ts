/**
 * The readers of the request headers the gates decide on — `Origin` (the
 * origin check), `Origin` and `Referer` (browser context), `Host` (the host
 * gate) and `Content-Type` (the CORS simple-request refusal) — as pure
 * functions over header lines.
 *
 * One rule per reader, the Rust spine's `fuz_http::request_headers` reading
 * the same one, and the shared table
 * `testing/cross_backend/request_header_conformance.json` holding both to the
 * same rows. Each reader takes the header's lines — one field value per
 * header line, in the order sent, outer SP and HTAB already stripped
 * (`get_header_lines` of `http/header_lines.ts` on a request) — so a header
 * sent twice is something it can see.
 *
 * A malformed `Origin`, `Host` or `Content-Type` — an empty line, more than
 * one line, a byte the grammar doesn't hold — reads `refused`, never
 * `absent`: reading a malformed browser signal as no signal at all would fail
 * open past the gate it feeds.
 *
 * **Join-invariance.** A runtime without a per-line view (Bun, an in-process
 * `app.request`) hands the spine one line holding the repeated lines joined
 * with `, `. No origin, host or media type holds a comma, so each reader
 * refuses one anywhere in its value: the join of a repeat is then refused as
 * the repeat itself is, and every reading is the same over the lines and over
 * their join.
 *
 * Hono-free: lines in, a reading out.
 *
 * @module
 */

import { trim_optional_whitespace } from './header_lines.ts';

/**
 * One header's reading: none sent, exactly one well-formed line, or refused.
 * Twin of the Rust `fuz_http::HeaderRead`.
 */
export type HeaderRead<T> =
	| { readonly kind: 'absent' }
	| { readonly kind: 'one'; readonly value: T }
	| { readonly kind: 'refused' };

const ABSENT: HeaderRead<never> = Object.freeze({ kind: 'absent' });
const REFUSED: HeaderRead<never> = Object.freeze({ kind: 'refused' });

/** Printable ASCII without the space or a comma — every byte of an origin or a host. */
const ORIGIN_OR_HOST_TEXT = /^[\x21-\x2b\x2d-\x7e]+$/;

/** Visible ASCII, the space and a tab, without a comma — what a `Content-Type` value may hold. */
const CONTENT_TYPE_TEXT = /^[\t\x20-\x2b\x2d-\x7e]*$/;

/** A MIME essence: `token "/" token` (RFC 9110 §8.3.1, §5.6.2). */
const MEDIA_TYPE_ESSENCE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Read the `Origin` lines: `absent` when there are none, `one` for exactly one
 * line of printable ASCII with no space or comma, `refused` otherwise — an
 * empty line, a second line, a byte outside that set.
 *
 * The opaque origin `null` reads `one`: it is a value a browser sends, and the
 * allowlist refuses it.
 *
 * @param origin_lines - the `Origin` header's lines
 */
export const read_origin = (origin_lines: ReadonlyArray<string>): HeaderRead<string> =>
	read_origin_or_host(origin_lines);

/**
 * Read the `Host` lines, by `read_origin`'s rule: `absent`, `one` well-formed
 * line, or `refused` — an empty `Host` names nothing, and more than one is
 * refused (RFC 9112 §3.2).
 *
 * @param host_lines - the `Host` header's lines
 */
export const read_host = (host_lines: ReadonlyArray<string>): HeaderRead<string> =>
	read_origin_or_host(host_lines);

const read_origin_or_host = (lines: ReadonlyArray<string>): HeaderRead<string> => {
	if (lines.length === 0) return ABSENT;
	if (lines.length > 1) return REFUSED;
	const value = lines[0]!;
	return ORIGIN_OR_HOST_TEXT.test(value) ? { kind: 'one', value } : REFUSED;
};

/**
 * Read the `Content-Type` lines to the MIME essence: `absent` when there are
 * none, `one` with the essence (the part before any `;`, stripped of SP and
 * HTAB, lowercased) when there is exactly one line of header text with no
 * comma whose essence is `token "/" token`, `refused` otherwise.
 *
 * A comma is refused anywhere in the value, a quoted parameter's included: a
 * joined repeat whose first line carries a parameter
 * (`application/json; charset=utf-8, text/plain`) has a well-formed essence,
 * and only refusing the comma reads it as the repeat it is.
 *
 * @param content_type_lines - the `Content-Type` header's lines
 */
export const read_content_type = (
	content_type_lines: ReadonlyArray<string>
): HeaderRead<string> => {
	if (content_type_lines.length === 0) return ABSENT;
	if (content_type_lines.length > 1) return REFUSED;
	const value = content_type_lines[0]!;
	if (!CONTENT_TYPE_TEXT.test(value)) return REFUSED;
	const semicolon = value.indexOf(';');
	const essence = trim_optional_whitespace(semicolon === -1 ? value : value.slice(0, semicolon));
	return MEDIA_TYPE_ESSENCE.test(essence) ? { kind: 'one', value: essence.toLowerCase() } : REFUSED;
};

/**
 * True when the request carries a browser-context header — any `Origin` or
 * `Referer` line, an empty or repeated one included. A presence test: a
 * malformed browser signal is still a browser signal.
 *
 * The bearer (`auth/bearer_auth.ts`) and daemon-token
 * (`auth/daemon_token_middleware.ts`) legs discard their credential when this
 * is true, and the request continues without it: a stolen bearer token can't
 * be replayed from a cross-origin page, and the loopback daemon token never
 * legitimately carries an `Origin`. It is not a proof that the caller is no
 * browser — a same-origin `GET` sends no `Origin`, and with
 * `referrerPolicy: 'no-referrer'` no `Referer` either. Distinct from the
 * origin check (`verify_request_source`), which gates a browser request
 * against the allowlist.
 *
 * @param origin_lines - the `Origin` header's lines
 * @param referer_lines - the `Referer` header's lines
 */
export const is_browser_context = (
	origin_lines: ReadonlyArray<string>,
	referer_lines: ReadonlyArray<string>
): boolean => origin_lines.length > 0 || referer_lines.length > 0;
