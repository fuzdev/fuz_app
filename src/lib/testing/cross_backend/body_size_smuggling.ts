import '../assert_dev_env.ts';

/**
 * Cross-backend request-smuggling probe for the body-size limit's connection
 * handling — the security sibling of `body_size.ts`.
 *
 * When the server caps the request body it answers `413` on the
 * `Content-Length` header. The strong (defense-in-depth) posture is to close
 * the connection *without reading the oversized body*: HTTP/1.1 forbids reusing
 * a keep-alive connection whose request body wasn't consumed, because unread
 * body bytes would be parsed as the start of the next request — a classic
 * request-smuggling vector. This suite probes the boundary by **pipelining**:
 * it opens a raw TCP socket and sends, in one write, an oversized `POST`
 * immediately followed by a second `GET`. What it requires forks on the
 * backend's declared `oversized_reject_closes_connection` capability:
 *
 * - **Closes (Node / Deno / hyper)** — the pipelined GET goes unanswered, so
 *   **at most one** response comes back. `<= 1` rather than "exactly the 413"
 *   because the impls close differently at the TCP level (a graceful close
 *   delivers the 413 first; hyper's RST can drop the in-flight 413 before the
 *   client reads it), so demanding a cleanly-read 413 would be flaky. Node
 *   closes at once with the body unread — `create_app_server`'s body limit
 *   (`http/body_limit.ts`) refuses on the header and answers
 *   `Connection: close`, which is what makes `@hono/node-server` close. Deno
 *   closes once the whole declared body has arrived, which this probe's
 *   single write delivers; a client that withholds the body holds a Deno
 *   connection open, and no request behind the body is served either way.
 * - **Keeps the connection (Bun)** — `Bun.serve` sends that same 413, header
 *   included, then keeps the socket open, skips the declared body, and serves
 *   the GET. This is not a smuggle — the GET is delimited by the POST's
 *   `Content-Length`, not carved out of the body — so the property held here
 *   is **no desync**: the bytes read back are **exactly two** well-formed
 *   responses, the first the 413 and the second the same status and body the
 *   backend gives that GET on a connection of its own. Body bytes parsed as a
 *   request would show up as a different second response or as extra ones.
 *   Fewer than two fails too, with a message naming the capability: a backend
 *   on this arm that closes after the 413 belongs on the other one.
 *
 * The oversized body is rejected *with* a 413 on every backend — pinned
 * reliably over `fetch` by `describe_body_size_cross_tests`; this test owns
 * only the connection-handling half. A **positive control** (two pipelined
 * requests → `>= 2` responses) proves a second response *would* be seen if a
 * trailing request were processed — without it the close-posture `<= 1` would
 * be vacuous on a server that never reuses connections — and that the counter
 * isn't undercounting.
 *
 * Raw-socket by necessity (the `FetchTransport` can't pipeline two requests on
 * one connection), so — unlike `body_size.ts` — this is **cross-process only**
 * (no in-process leg; there is no socket in-process — the in-process pin is
 * that the reject never reads the request body, in
 * `server/create_app_server.db.test.ts`).
 *
 * Cited property: `docs/security.md` §"Body Size Limiting" (connection handling
 * on oversized reject).
 *
 * @module
 */

import { connect } from 'node:net';

import { describe, test, assert } from 'vitest';

import { SPINE_RPC_PATH } from './spine_surface_constants.ts';

/** Options for the smuggling probe — needs the raw URL, not a transport. */
export interface BodySizeSmugglingCrossTestOptions {
	/** Base URL the spawned backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** RPC endpoint path to target. Default `/api/rpc`. */
	readonly rpc_path?: string;
	/**
	 * Whether the backend closes the connection after an oversized-body `413`
	 * (`capabilities.oversized_reject_closes_connection`). `true` (default)
	 * requires that the pipelined GET goes unanswered — at most one response.
	 * `false` (Bun) requires no desync instead: exactly two well-formed
	 * responses, the 413 and one matching what the backend answers that GET
	 * sent alone — so `rpc_path` must answer a bare `GET` with a stable status
	 * and body, and a backend that closes after the 413 fails. Default `true`
	 * so a consumer that leaves the flag out fails loud on a backend that
	 * keeps the connection.
	 */
	readonly closes_connection?: boolean;
}

/** The shared 1 MiB cap (see `body_size.ts` for why it's a local constant). */
const BODY_LIMIT_DEFAULT_BYTES = 1024 * 1024;

/**
 * How long each raw exchange waits for the server to finish answering. A
 * backend that keeps the connection never closes it, so its exchange runs the
 * whole window.
 */
const RAW_READ_TIMEOUT_MS = 2000;

/**
 * Open a raw TCP socket to `base_url`, write `request_bytes` once, and collect
 * everything the server sends back until it closes the connection or
 * `read_timeout_ms` elapses. Write errors are swallowed: the server closing
 * mid-upload (the correct response to an oversized body) surfaces as
 * `EPIPE`/`ECONNRESET` on our unfinished write, which is exactly the behavior
 * under test — what matters is what we *read back*.
 */
const send_raw = (
	base_url: string,
	request_bytes: string,
	read_timeout_ms: number
): Promise<string> =>
	new Promise((resolve) => {
		const url = new URL(base_url);
		const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
		const socket = connect({ host: url.hostname, port });
		let received = '';
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(received);
		};
		const timer = setTimeout(finish, read_timeout_ms);
		socket.setEncoding('latin1');
		socket.on('connect', () => socket.write(request_bytes));
		socket.on('data', (chunk: string) => {
			received += chunk;
		});
		socket.on('error', () => {}); // EPIPE/ECONNRESET on mid-write close is expected
		socket.on('close', finish);
	});

/**
 * Count HTTP response status lines in a raw byte stream. Deliberately
 * **unanchored** (no `^`/`m`): a second pipelined response is concatenated
 * straight after the first response's body, which carries no trailing newline,
 * so a line-anchored match would miss it — and missing a smuggled second
 * response is a silent false negative. No response header or JSON error body
 * contains the literal `HTTP/1.x NNN`, so an unanchored match counts exactly
 * the status lines. The positive control below proves this counts 2 when the
 * server genuinely returns 2.
 */
const count_responses = (raw: string): number => (raw.match(/HTTP\/1\.[01] \d{3}/g) ?? []).length;

/** One response split out of a raw byte stream by `parse_responses`. */
interface RawResponse {
	readonly status: number;
	readonly body: string;
}

/**
 * Split a raw byte stream into the HTTP responses it holds, each framed on
 * its own `Content-Length` (a response without one runs to the end of the
 * stream). The stream is `latin1`-decoded, so a character is a byte.
 *
 * @returns the responses in order, or `null` when the bytes are not a
 * sequence of whole responses — text where a status line belongs, a head
 * with no end, a body shorter than its declared length
 */
const parse_responses = (raw: string): Array<RawResponse> | null => {
	const responses: Array<RawResponse> = [];
	let offset = 0;
	while (offset < raw.length) {
		const head_end = raw.indexOf('\r\n\r\n', offset);
		if (head_end === -1) return null;
		const [status_line, ...header_lines] = raw.slice(offset, head_end).split('\r\n');
		const status_match = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(status_line!);
		if (!status_match) return null;
		const body_start = head_end + 4;
		const length_line = header_lines.find((line) => /^content-length:/i.test(line));
		const body_end =
			length_line === undefined
				? raw.length
				: body_start + Number.parseInt(length_line.slice(length_line.indexOf(':') + 1), 10);
		// also false for a `NaN` length
		if (!(body_end >= body_start && body_end <= raw.length)) return null;
		responses.push({ status: Number(status_match[1]), body: raw.slice(body_start, body_end) });
		offset = body_end;
	}
	return responses;
};

export const describe_body_size_smuggling_cross_tests = (
	options: BodySizeSmugglingCrossTestOptions
): void => {
	const { base_url } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const closes_connection = options.closes_connection ?? true;
	const host = new URL(base_url).host;

	describe('body-size limit — request-smuggling resistance', () => {
		// Positive control: prove the server returns >1 response on a single
		// connection. Without this the smuggling assertion below would be
		// vacuously green on a server that simply never reuses connections — and
		// it also validates `count_responses` actually counts a second response.
		test('control: two pipelined requests → ≥2 responses (connection reuse is real)', async () => {
			const two_requests =
				`GET ${rpc_path} HTTP/1.1\r\nHost: ${host}\r\n\r\n` +
				`GET ${rpc_path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
			const response = await send_raw(base_url, two_requests, RAW_READ_TIMEOUT_MS);
			const n = count_responses(response);
			assert.ok(
				n >= 2,
				`expected ≥2 responses on one keep-alive connection (got ${n}); without ` +
					`connection reuse — or with an undercounting matcher — the smuggling ` +
					`assertion below is not a real signal. Raw head: ${response.slice(0, 120)}`
			);
		});

		test('oversized POST + pipelined GET → no request smuggled', async () => {
			const oversized_len = BODY_LIMIT_DEFAULT_BYTES + 1024;
			const pipelined_get = `GET ${rpc_path} HTTP/1.1\r\nHost: ${host}\r\n\r\n`;
			// One write: an over-cap POST (rejected on Content-Length) immediately
			// followed by a GET.
			const payload =
				`POST ${rpc_path} HTTP/1.1\r\n` +
				`Host: ${host}\r\n` +
				`Content-Type: application/json\r\n` +
				`Content-Length: ${oversized_len}\r\n` +
				`\r\n` +
				'x'.repeat(oversized_len) +
				pipelined_get;

			const response = await send_raw(base_url, payload, RAW_READ_TIMEOUT_MS);
			const n = count_responses(response);

			if (closes_connection) {
				// The reject closes the connection, so the pipelined GET is never
				// reached — **at most one** response comes back (the 413, or none if
				// the close raced the read). A *second* response means the connection
				// was kept and the GET served. The control above proves a second
				// response *would* be seen, so `<= 1` is a real signal.
				assert.ok(
					n <= 1,
					`expected at most one response (oversized reject closes the connection; the ` +
						`pipelined GET must not be reached). Saw ${n}. Raw head: ${response.slice(0, 120)}`
				);
				return;
			}

			// The backend keeps the connection (Bun): the 413, then its answer to
			// the GET, and nothing else. Hold it to **no desync** — the body bytes
			// were skipped as a body, never parsed as a request.
			assert.ok(
				n >= 2,
				`expected two responses (the 413 + the reply to the pipelined GET) from a ` +
					`backend declared to keep the connection after an oversized-body 413. Saw ` +
					`${n} within ${RAW_READ_TIMEOUT_MS}ms. If this backend closes the connection ` +
					`after the 413, declare \`oversized_reject_closes_connection: true\` for it ` +
					`(this suite's \`closes_connection\`). Raw head: ${response.slice(0, 120)}`
			);
			assert.ok(
				n <= 2,
				`expected exactly two responses (the 413 + one reply to the pipelined GET); ` +
					`more means the oversized body was parsed as requests (a desync). ` +
					`Saw ${n}. Raw head: ${response.slice(0, 120)}`
			);
			const responses = parse_responses(response);
			assert.ok(
				responses !== null,
				`expected the bytes read back to be whole HTTP responses, each framed on its ` +
					`Content-Length. Raw head: ${response.slice(0, 240)}`
			);
			assert.strictEqual(
				responses.length,
				n,
				`expected one status line per framed response; a difference means a status ` +
					`line sits inside another response's body. Raw head: ${response.slice(0, 240)}`
			);
			const [first, second] = responses;
			assert.strictEqual(first!.status, 413, 'the first response is the oversized reject');
			// A request carved out of the body would not be this GET, so the reply
			// must be the one the same GET gets on its own connection.
			const alone = parse_responses(
				await send_raw(
					base_url,
					`GET ${rpc_path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
					RAW_READ_TIMEOUT_MS
				)
			);
			assert.ok(alone?.length === 1, 'expected one response to the GET sent alone');
			assert.deepStrictEqual(
				second,
				alone[0],
				`expected the second response to be the backend's reply to the pipelined ` +
					`GET (same status and body as that GET sent alone); anything else means ` +
					`the bytes after the 413 were not framed as that request`
			);
		});
	});
};
