/**
 * A request header as the lines the client sent — one field value per header
 * line, in order — where the Fetch `Headers` a handler normally reads has
 * already folded them into one string.
 *
 * The credential readers (`auth/credential_headers.ts`) and the gate readers
 * (`http/request_headers.ts`) decide on the lines: a credential header sent
 * twice is discarded, an `Origin` or `Host` sent twice is refused, and that
 * takes knowing it was sent twice. `Headers.get` joins repeated lines with
 * `, `, and `@hono/node-server` builds a WebSocket upgrade's `Headers` from
 * Node's deduplicated view, which keeps only the first `Authorization`,
 * `Host`, `Referer` or `Content-Type` line and drops every empty one — so on
 * that path neither the join nor an empty line shows.
 *
 * @module
 */

import type { Context } from 'hono';

/**
 * The names and values of the request's header lines, alternating, as Node's
 * `IncomingMessage.rawHeaders` holds them — from the `c.env.incoming` that
 * `@hono/node-server` passes a handler, on plain requests and on WebSocket
 * upgrades alike.
 */
const to_node_raw_headers = (env: unknown): ReadonlyArray<string> | null => {
	if (typeof env !== 'object' || env === null) return null;
	const incoming = (env as { incoming?: unknown }).incoming;
	if (typeof incoming !== 'object' || incoming === null) return null;
	const raw_headers = (incoming as { rawHeaders?: unknown }).rawHeaders;
	if (!Array.isArray(raw_headers) || raw_headers.length % 2 !== 0) return null;
	return raw_headers.every((entry) => typeof entry === 'string') ? raw_headers : null;
};

/**
 * Strip HTTP optional whitespace — SP and HTAB, nothing else — from both ends
 * of a field value or a part of one. `String.prototype.trim` strips more: a
 * header byte 0xA0 reaches a handler as U+00A0, which it counts as whitespace.
 *
 * @param text - a field value, or a part of one
 * @returns `text` without its leading and trailing SP and HTAB
 */
export const trim_optional_whitespace = (text: string): string => {
	let start = 0;
	let end = text.length;
	while (start < end && is_optional_whitespace(text.charCodeAt(start))) start++;
	while (end > start && is_optional_whitespace(text.charCodeAt(end - 1))) end--;
	return text.slice(start, end);
};

const is_optional_whitespace = (code: number): boolean => code === 0x20 || code === 0x09;

/**
 * Read one request header as the lines it was sent in.
 *
 * On `@hono/node-server` the lines come from the request's raw header list
 * (`c.env.incoming.rawHeaders`), so a header sent twice is two entries. A
 * runtime with no per-line view — Bun, and an in-process `app.request` — gives
 * the Fetch `Headers` value as the single line: repeated lines arrive already
 * joined (`; ` for `Cookie`, `, ` otherwise), and a caller that must tell a
 * repeat from one line reads a grammar that refuses the join.
 *
 * @param c - the request context
 * @param name - the header name, in any case
 * @returns the header's field values, outer SP and HTAB stripped, in the order sent — `[]` when the request carries no such header
 */
export const get_header_lines = (c: Context, name: string): Array<string> => {
	const raw_headers = to_node_raw_headers(c.env);
	if (raw_headers === null) {
		const value = c.req.raw.headers.get(name);
		return value === null ? [] : [trim_optional_whitespace(value)];
	}
	const lower_name = name.toLowerCase();
	const lines: Array<string> = [];
	for (let i = 0; i < raw_headers.length; i += 2) {
		if (raw_headers[i]!.toLowerCase() === lower_name) {
			lines.push(trim_optional_whitespace(raw_headers[i + 1]!));
		}
	}
	return lines;
};
