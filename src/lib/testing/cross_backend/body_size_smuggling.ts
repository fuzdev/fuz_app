import '../assert_dev_env.js';

/**
 * Cross-backend request-smuggling probe for the body-size limit's connection
 * handling — the security sibling of `body_size.ts`.
 *
 * When the server caps the request body it answers `413` on the
 * `Content-Length` header and closes the connection *without reading the
 * oversized body*. That close is load-bearing: HTTP/1.1 forbids reusing a
 * keep-alive connection whose request body wasn't consumed, because the unread
 * body bytes would otherwise be parsed as the start of the next request — a
 * classic request-smuggling vector. This suite proves the mitigation holds end
 * to end by **pipelining**: it opens a raw TCP socket and sends, in one write,
 * an oversized `POST` immediately followed by a second `GET` request. A correct
 * server rejects the POST with `413` and never processes the trailing GET (the
 * connection closes with the GET bytes unconsumed); a vulnerable one would
 * drain past the body and answer the smuggled GET too. The assertion is
 * therefore "**at most one** HTTP response comes back" — a *second* response is
 * the smuggle. It's `<= 1` rather than "exactly the 413" because the impls close
 * differently at the TCP level (node-server graceful close delivers the 413
 * first; hyper's RST can drop the in-flight 413 before the client reads it), so
 * demanding a cleanly-read 413 would be flaky; the 413-ness itself is pinned
 * reliably over `fetch` by `describe_body_size_cross_tests`. A **positive
 * control** (two pipelined requests → >= 2 responses) proves a second response
 * *would* be seen if the trailing request were processed — without it the
 * `<= 1` assertion would be vacuous on a server that never reuses connections,
 * and it also proves the response counter isn't undercounting.
 *
 * Raw-socket by necessity (the `FetchTransport` can't pipeline two requests on
 * one connection), so — unlike `body_size.ts` — this is **cross-process only**
 * (no in-process leg; there is no socket in-process) and ungated (the limit is
 * on every spine). Robust by construction: it counts responses until the
 * socket closes or a short read timeout, so a server that closes (the expected
 * path) and one that merely holds the connection open without smuggling both
 * read as one response; only an actual second response fails.
 *
 * Cited property: `docs/security.md` §"Body Size Limiting" (connection close on
 * oversized reject).
 *
 * `$lib`-free by contract (relative + `node:` specifiers only).
 *
 * @module
 */

import {connect} from 'node:net';

import {describe, test, assert} from 'vitest';

import {SPINE_RPC_PATH} from './default_spine_surface.js';

/** Options for the smuggling probe — needs the raw URL, not a transport. */
export interface BodySizeSmugglingCrossTestOptions {
	/** Base URL the spawned backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** RPC endpoint path to target. Default `/api/rpc`. */
	readonly rpc_path?: string;
}

/** The shared 1 MiB cap (see `body_size.ts` for why it's a local constant). */
const BODY_LIMIT_DEFAULT_BYTES = 1024 * 1024;

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
	read_timeout_ms: number,
): Promise<string> =>
	new Promise((resolve) => {
		const url = new URL(base_url);
		const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
		const socket = connect({host: url.hostname, port});
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

export const describe_body_size_smuggling_cross_tests = (
	options: BodySizeSmugglingCrossTestOptions,
): void => {
	const {base_url} = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
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
			const response = await send_raw(base_url, two_requests, 2000);
			const n = count_responses(response);
			assert.ok(
				n >= 2,
				`expected ≥2 responses on one keep-alive connection (got ${n}); without ` +
					`connection reuse — or with an undercounting matcher — the smuggling ` +
					`assertion below is not a real signal. Raw head: ${response.slice(0, 120)}`,
			);
		});

		test('oversized POST + pipelined GET → smuggled request not processed', async () => {
			const oversized_len = BODY_LIMIT_DEFAULT_BYTES + 1024;
			// One write: an over-cap POST (rejected on Content-Length, body never
			// read) immediately followed by a GET. If the server wrongly drained
			// the unread body it would reach + answer this GET — a smuggle.
			const payload =
				`POST ${rpc_path} HTTP/1.1\r\n` +
				`Host: ${host}\r\n` +
				`Content-Type: application/json\r\n` +
				`Content-Length: ${oversized_len}\r\n` +
				`\r\n` +
				'x'.repeat(oversized_len) +
				`GET ${rpc_path} HTTP/1.1\r\nHost: ${host}\r\n\r\n`;

			const response = await send_raw(base_url, payload, 2000);

			// The security property is "the pipelined GET is not processed", i.e.
			// **at most one** response comes back (the 413, or none if the close
			// raced the read). A *second* response is the smuggle. We assert `<= 1`
			// rather than "exactly the 413" because the two impls close the
			// connection differently at the TCP level — node-server closes
			// gracefully (the 413 is delivered first), hyper sends an RST that can
			// drop the in-flight 413 before the client reads it — and demanding a
			// cleanly-read 413 here would be flaky. That the oversized body is
			// rejected *with* a 413 is pinned reliably (over `fetch`) by
			// `describe_body_size_cross_tests`; this test owns only the no-smuggle
			// half. The control above proves a second response *would* be seen if
			// the GET were processed, so `<= 1` is a real signal, not a vacuous one.
			const n = count_responses(response);
			assert.ok(
				n <= 1,
				`expected at most one response (the GET must not be smuggled in off the ` +
					`unread body); a second response means it was. Saw ${n}. Raw head: ${response.slice(0, 120)}`,
			);
		});
	});
};
