import '../assert_dev_env.ts';

/**
 * Raw-socket HTTP/1.1 exchanges, for tests that need to control exactly which
 * bytes reach the server.
 *
 * `fetch` frames a request itself and sends all of it, so some server
 * behaviors can't be reached through it: what a server does with two requests
 * in one write, with duplicate or malformed headers, with a request head whose
 * body never follows, or with a chunked body that is never terminated. This
 * writes caller-built bytes over `node:net` and hands back what the server
 * sent, plus just enough parsing to read a status or one whole response.
 *
 * Everything is `latin1`-decoded, so a string's length is its byte length.
 *
 * Plain TCP only: an `https:` URL is not spoken to over TLS, and the host must
 * be a name or an IPv4 address — a bracketed IPv6 literal does not connect.
 *
 * @module
 */

import { connect } from 'node:net';

/**
 * The read window a raw exchange gets by default in the cross suites. The
 * server holds every byte it will get when the wait starts, so a backend that
 * answers on what it has answers at once, and one that waits for more runs the
 * whole window.
 */
export const RAW_HTTP_READ_TIMEOUT_MS = 2000;

/** What a raw exchange read back, and how it ended. */
export interface RawHttpExchange {
	/** Every byte the server sent, `latin1`-decoded. */
	readonly received: string;
	/**
	 * `true` when the connection ended before the exchange stopped reading —
	 * the server closed it, or it never opened (a refused or unresolvable
	 * address reads as closed, with nothing received).
	 */
	readonly closed_by_server: boolean;
}

/** Options for `raw_http_exchange`. */
export interface RawHttpExchangeOptions {
	/** How long to read before giving up on the server. */
	readonly read_timeout_ms: number;
	/**
	 * When the exchange stops reading. `'close'` reads until the server closes
	 * the connection; `'response'` stops as soon as one whole response has
	 * arrived (`raw_http_parse_response`), for a server that answers and then
	 * keeps the connection open. Either way the read timeout bounds it.
	 *
	 * `'response'` stops at the first response the bytes frame, so it is for a
	 * final response carrying `Content-Length` or chunked framing: a `1xx`
	 * interim response ends the read, and so does the head of a response
	 * delimited by the connection closing, before its body.
	 *
	 * @default 'close'
	 */
	readonly until?: 'close' | 'response';
}

/** One parsed HTTP/1.1 response. */
export interface RawHttpResponse {
	readonly status: number;
	/** Response headers, names lowercased; a repeated name keeps its last value. */
	readonly headers: Readonly<Record<string, string>>;
	/** The response body, with any chunked framing removed. */
	readonly body: string;
}

/**
 * Open a raw TCP socket to `base_url`, write `request_bytes` once, and collect
 * what the server sends back until it closes the connection, a whole response
 * has arrived (`until: 'response'`), or `read_timeout_ms` elapses.
 *
 * Write errors are swallowed: a server that refuses a request and closes
 * mid-upload surfaces as `EPIPE` / `ECONNRESET` on the unfinished write, and
 * what a caller asserts on is what was read back. A write error also ends the
 * socket, so bytes the server sent just before it can go unread — a caller
 * that needs to read a refusal reliably sends nothing the server will leave
 * unread.
 *
 * @param base_url - the server's base URL; only its host and port are used
 * @param request_bytes - the bytes to send, `latin1`-encoded
 */
export const raw_http_exchange = (
	base_url: string,
	request_bytes: string,
	options: RawHttpExchangeOptions
): Promise<RawHttpExchange> =>
	new Promise((resolve) => {
		const { read_timeout_ms, until = 'close' } = options;
		const url = new URL(base_url);
		const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
		const socket = connect({ host: url.hostname, port });
		let received = '';
		let settled = false;
		const finish = (closed_by_server: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve({ received, closed_by_server });
		};
		const timer = setTimeout(() => finish(false), read_timeout_ms);
		socket.setEncoding('latin1');
		socket.on('connect', () => socket.write(request_bytes, 'latin1'));
		socket.on('data', (chunk: string) => {
			received += chunk;
			if (until === 'response' && raw_http_parse_response(received)) finish(false);
		});
		socket.on('error', () => {}); // EPIPE/ECONNRESET on a mid-write close is expected
		socket.on('close', () => finish(true));
	});

/**
 * Render request headers as raw HTTP/1.1 header lines, each ending in CRLF.
 *
 * @param headers - header names to values, sent in iteration order
 * @returns the lines, concatenated
 */
export const raw_http_header_lines = (headers: Record<string, string>): string =>
	Object.entries(headers)
		.map(([name, value]) => `${name}: ${value}\r\n`)
		.join('');

/**
 * Parse a response body as JSON.
 *
 * @param body - the body text
 * @returns the parsed value, or `undefined` when the body is not JSON
 */
export const raw_http_parse_json = (body: string): unknown => {
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
};

/**
 * Count HTTP response status lines in a raw byte stream. Deliberately
 * **unanchored** (no `^`/`m`): a second pipelined response is concatenated
 * straight after the first response's body, which carries no trailing newline,
 * so a line-anchored match would miss it — and missing a smuggled second
 * response is a silent false negative. It counts exactly the status lines as
 * long as no response header or body contains the literal `HTTP/1.x NNN`.
 */
export const raw_http_count_responses = (raw: string): number =>
	(raw.match(/HTTP\/1\.[01] \d{3}/g) ?? []).length;

/** The status code of the first HTTP response in a raw byte stream, or `null` if none. */
export const raw_http_first_status = (raw: string): number | null => {
	const match = /HTTP\/1\.[01] (\d{3})/.exec(raw);
	return match ? Number(match[1]) : null;
};

/**
 * Remove chunked framing from a body.
 *
 * @returns the decoded body, or `null` when the terminating chunk hasn't arrived
 */
const decode_chunked = (raw: string): string | null => {
	let body = '';
	let offset = 0;
	for (;;) {
		const line_end = raw.indexOf('\r\n', offset);
		if (line_end === -1) return null;
		// a chunk-size line may carry `;extension`s after the hex size
		const size = Number.parseInt(raw.slice(offset, line_end), 16);
		if (!Number.isFinite(size)) return null;
		const data_start = line_end + 2;
		// the last chunk is followed by optional trailers and an empty line
		if (size === 0) return raw.includes('\r\n\r\n', line_end) ? body : null;
		if (raw.length < data_start + size + 2) return null;
		body += raw.slice(data_start, data_start + size);
		offset = data_start + size + 2;
	}
};

/**
 * Parse the first response in a raw byte stream, once all of it has arrived.
 *
 * The body is delimited by `Transfer-Encoding: chunked` or `Content-Length`.
 * A response carrying neither is delimited by the connection closing, which
 * the bytes alone don't show, so its body is whatever followed the head.
 *
 * @param raw - the bytes read so far, `latin1`-decoded
 * @returns the response, or `null` when the head or the framed body is incomplete
 */
export const raw_http_parse_response = (raw: string): RawHttpResponse | null => {
	const head_end = raw.indexOf('\r\n\r\n');
	if (head_end === -1) return null;
	const [status_line, ...header_lines] = raw.slice(0, head_end).split('\r\n');
	const status_match = /^HTTP\/1\.[01] (\d{3})/.exec(status_line!);
	if (!status_match) return null;
	const headers: Record<string, string> = {};
	for (const line of header_lines) {
		const colon = line.indexOf(':');
		if (colon <= 0) continue;
		headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
	}
	const status = Number(status_match[1]);
	const rest = raw.slice(head_end + 4);
	if (headers['transfer-encoding']?.toLowerCase().includes('chunked')) {
		const body = decode_chunked(rest);
		return body === null ? null : { status, headers, body };
	}
	const content_length = headers['content-length'];
	if (content_length !== undefined) {
		const length = Number(content_length);
		if (!Number.isSafeInteger(length) || length < 0 || rest.length < length) return null;
		return { status, headers, body: rest.slice(0, length) };
	}
	return { status, headers, body: rest };
};
