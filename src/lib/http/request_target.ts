/**
 * The strict readers of the request target: the query string to its pairs,
 * and one path segment to its text — each percent-decoded, or refused.
 *
 * An escape that doesn't decode is refused, never left literal and never
 * replaced with U+FFFD: a `%` not followed by two hex digits is a
 * `malformed_escape`, and decoded bytes that are not UTF-8 are
 * `invalid_utf8`. A literal spelling would make `%FF` and `%25FF` one value,
 * and a lossy one would make every invalid sequence the same U+FFFD — either
 * way a handler reads a value the client never sent. The Rust spine's
 * `fuz_http::request_target` reads by the same rule, and the shared table
 * `testing/cross_backend/request_target_conformance.json` holds both to the
 * same rows.
 *
 * The pure readers take text and are Hono-free. `read_request_query_pairs`
 * and `read_request_route_params` apply them to a request (a type-only import
 * of the Hono context): every read of the query or the path params in the
 * spine goes through one of the two.
 *
 * @module
 */

import type { Context } from 'hono';
import type { Result } from '@fuzdev/fuz_util/result.ts';

/** Why a query string or a path segment doesn't decode. */
export const PERCENT_DECODE_ERRORS = ['malformed_escape', 'invalid_utf8'] as const;

/**
 * Why a query string or a path segment doesn't decode: a `%` not followed by
 * two hex digits, or decoded bytes that are not UTF-8. Twin of the Rust
 * `fuz_http::PercentDecodeError`.
 */
export type PercentDecodeError = (typeof PERCENT_DECODE_ERRORS)[number];

/** One query pair, decoded: its name and its value. */
export type QueryPair = readonly [name: string, value: string];

/** A decoded query string, or why it doesn't decode. */
export type QueryPairsRead = Result<
	{ readonly value: ReadonlyArray<QueryPair> },
	{ readonly error: PercentDecodeError }
>;

/** A decoded path segment, or why it doesn't decode. */
export type PathSegmentRead = Result<
	{ readonly value: string },
	{ readonly error: PercentDecodeError }
>;

const HEX_DIGIT = /^[0-9A-Fa-f]$/;

const UTF8 = new TextEncoder();
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Percent-decode `text` strictly: every `%` must start an escape of two hex
 * digits, and the decoded bytes must be UTF-8. A malformed escape anywhere is
 * reported ahead of invalid bytes, since it is found in the scan and the bytes
 * are judged after it.
 */
const percent_decode_strict = (text: string): PathSegmentRead => {
	if (!text.includes('%')) return { ok: true, value: text };
	const bytes: Array<number> = [];
	for (let i = 0; i < text.length;) {
		const char = text[i]!;
		if (char === '%') {
			const high = text[i + 1];
			const low = text[i + 2];
			if (
				high === undefined ||
				low === undefined ||
				!HEX_DIGIT.test(high) ||
				!HEX_DIGIT.test(low)
			) {
				return { ok: false, error: 'malformed_escape' };
			}
			bytes.push(Number.parseInt(high + low, 16));
			i += 3;
		} else {
			// a run of literal text, as its UTF-8 bytes
			const next = text.indexOf('%', i);
			const end = next === -1 ? text.length : next;
			for (const byte of UTF8.encode(text.slice(i, end))) bytes.push(byte);
			i = end;
		}
	}
	try {
		return { ok: true, value: UTF8_STRICT.decode(new Uint8Array(bytes)) };
	} catch {
		return { ok: false, error: 'invalid_utf8' };
	}
};

/**
 * Read one raw path segment to its text: percent-decoded strictly, `+` left a
 * plus (a path is no form encoding).
 *
 * @param segment - a segment of the raw request path, between two `/`
 */
export const read_path_segment = (segment: string): PathSegmentRead =>
	percent_decode_strict(segment);

/**
 * Read a raw query string to its pairs, in order: split on `&` (an empty
 * piece is no pair), each piece split at its first `=` (none reads an empty
 * value), `+` read as a space, then name and value percent-decoded strictly.
 * Every pair is read, a repeated key's and a nameless one's included, and the
 * first component that doesn't decode refuses the whole string — a key no
 * handler reads included, so no reader of one key sees a query another reader
 * would refuse.
 *
 * What a pair means is the caller's: `query_first` takes a key's first
 * occurrence, and `to_query_record` builds the record a route's query schema
 * parses.
 *
 * @param query - the text after `?`, or `null` for a target with none
 */
export const read_query_pairs = (query: string | null): QueryPairsRead => {
	const pairs: Array<QueryPair> = [];
	if (query === null || query === '') return { ok: true, value: pairs };
	for (const piece of query.split('&')) {
		if (piece === '') continue;
		const equals = piece.indexOf('=');
		const raw_name = equals === -1 ? piece : piece.slice(0, equals);
		const raw_value = equals === -1 ? '' : piece.slice(equals + 1);
		const name = percent_decode_strict(raw_name.replaceAll('+', ' '));
		if (!name.ok) return name;
		const value = percent_decode_strict(raw_value.replaceAll('+', ' '));
		if (!value.ok) return value;
		pairs.push([name.value, value.value]);
	}
	return { ok: true, value: pairs };
};

/**
 * The first value of `key` among `pairs` — a repeated key's later values are
 * ignored. Twin of the Rust `fuz_http::query_first`.
 *
 * @returns the value, `''` for a key with no value, `undefined` when absent
 */
export const query_first = (pairs: ReadonlyArray<QueryPair>, key: string): string | undefined =>
	pairs.find(([name]) => name === key)?.[1];

/**
 * The record a route's query schema parses: each name's first value, a
 * nameless pair skipped — what Hono's `c.req.query()` builds, on a
 * null-prototype object.
 */
export const to_query_record = (pairs: ReadonlyArray<QueryPair>): Record<string, string> => {
	const record: Record<string, string> = Object.create(null);
	for (const [name, value] of pairs) {
		if (name === '' || Object.hasOwn(record, name)) continue;
		record[name] = value;
	}
	return record;
};

/**
 * The path and the query of an absolute request URL, both as sent: the path
 * from the first `/` after the authority, the query the text after the first
 * `?` (`null` without one), a fragment dropped.
 *
 * @param url - the request URL, as the runtime serialized it
 */
export const split_request_url = (url: string): { path: string; query: string | null } => {
	const hash = url.indexOf('#');
	const without_fragment = hash === -1 ? url : url.slice(0, hash);
	const scheme_end = without_fragment.indexOf('://');
	const path_start = without_fragment.indexOf('/', scheme_end === -1 ? 0 : scheme_end + 3);
	if (path_start === -1) return { path: '/', query: null };
	const rest = without_fragment.slice(path_start);
	const question = rest.indexOf('?');
	return question === -1
		? { path: rest, query: null }
		: { path: rest.slice(0, question), query: rest.slice(question + 1) };
};

/**
 * A request's path as sent — nothing percent-decoded — which the assembled
 * server routes on (`new Hono({getPath})`), as the Rust spine's router
 * matches the raw `Uri::path`. So `/%61pi/x` is its own path, not `/api/x`,
 * on both spines, and every path-keyed layer (the auth and origin scopes,
 * the origin carve-outs, the session-cookie clear, the unmatched-route
 * handler) reads the spelling the router matched. Dot segments are the
 * runtime's: Node and Bun resolve them while building the request's URL,
 * before this runs.
 *
 * @param request - the request, its `url` as the runtime serialized it
 */
export const get_request_path = (request: Request): string => split_request_url(request.url).path;

/**
 * Read a request's query string strictly (`read_query_pairs`) — the one read
 * of the query in the spine: the route context's `query_pairs`, a route's
 * query schema, and the WebSocket upgrade's `acting`.
 *
 * @param c - the Hono context
 */
export const read_request_query_pairs = (c: Context): QueryPairsRead =>
	read_query_pairs(split_request_url(c.req.url).query);

/**
 * Read the matched route's path params, every escape in the request path
 * decoded strictly first — the one read of the path params in the spine.
 *
 * The whole path is read rather than each param's own segments: the router
 * matches the raw path (`get_request_path`), so a literal segment matches
 * only as the template spells it — no escape at all — and on a matched route
 * every escape is inside a param. Once every segment decodes, Hono's own
 * reading of each param — the raw matched text by `decodeURIComponent` — is
 * exactly its strict decoding, so the values are taken from Hono's match,
 * which knows which segments each param spans.
 *
 * @param c - the Hono context
 * @returns the params by name, or why the path doesn't decode
 */
export const read_request_route_params = (
	c: Context
): Result<{ readonly value: Record<string, string> }, { readonly error: PercentDecodeError }> => {
	for (const segment of split_request_url(c.req.url).path.split('/')) {
		const read = read_path_segment(segment);
		if (!read.ok) return read;
	}
	return { ok: true, value: c.req.param() };
};
