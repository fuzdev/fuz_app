import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the request body-size limit.
 *
 * `create_app_server` (TS) and the Rust spine both cap the request body at a
 * 1 MiB default (`DEFAULT_MAX_BODY_SIZE` / `fuz_http`'s
 * `DEFAULT_BODY_LIMIT_BYTES`) and reject oversized payloads with `413` and the
 * canonical flat REST body `{error: 'payload_too_large'}`. A declared
 * `Content-Length` over the cap is refused on the header, *before* auth,
 * origin, or dispatch run (middleware step 4). Each impl unit-tests this in
 * isolation; this suite pins the cross-impl agreement on the status + body
 * shape, and on the exact `>` cap boundary (not an off-by-one divergence). The
 * cases:
 *
 * - **over-limit POST (cap + 1 byte) → 413** `payload_too_large`, refused
 *   before any handler runs (the limit fires ahead of origin verification + the
 *   dispatcher, so an over-cap body is rejected regardless of how well-formed it
 *   is). Exactly one byte over — both impls reject on a strict `>`, so this is
 *   the tight upper boundary, and staying just over keeps it clear of any
 *   larger framework-default limit that would answer with a different body.
 * - **at-limit POST (exactly the cap) → not 413** — one byte under the
 *   rejection threshold passes the size gate and reaches the dispatcher (the
 *   downstream status is irrelevant; only "not size-rejected" is asserted). The
 *   boundary sibling of the case above.
 * - **under-limit POST (small) → 200** — a small, well-formed authenticated
 *   `account_verify` envelope sails through to a successful handler response,
 *   the positive control that the route works for normal traffic.
 * - The cap answering a declared length ahead of the origin check and auth —
 *   over-cap with a disallowed `Origin` and no credential → 413 — is pinned per
 *   transport by the front-door table (`transport_composition.ts`), beside the
 *   under-cap 403 that shows the origin check still runs.
 * - **over-limit chunked POST (no `Content-Length`), authenticated → 413** —
 *   a body with no declared length is refused by the bytes that arrive.
 *
 * **Implementation-defined, not pinned here.** Without a declared length the
 * two spines measure at different points: the TS spine reads the body up to
 * the cap before any later middleware runs, so its 413 comes ahead of the
 * origin check and auth; the Rust spine counts as the handler reads, so a
 * refusal made on the headers (a disallowed `Origin`) answers first and a
 * handler that never reads the body answers its own status. Only the
 * authenticated, allowed-origin chunked case — where nothing else refuses —
 * has one answer on every backend. A repeated `Content-Length` with equal
 * values is also the implementation's: the TS spine answers 400
 * `invalid_content_length` where its runtime's parser hands the repeat over,
 * and hyper folds it into one value and accepts.
 *
 * **Over a real socket the over-cap cases send no byte the server won't
 * read.** A server that caps the body answers 413 and may close the
 * connection with the rest of the upload unread — correct HTTP, since an
 * unread request body can't share a keep-alive socket. A client still
 * uploading then has its write fail (`EPIPE`) and can lose the 413 the server
 * did send, so a whole over-cap body sent through `fetch` reads its answer
 * only some of the time. Given a `base_url`, the suite speaks to the socket
 * directly (`raw_http_exchange`) and holds back what the refusal doesn't need:
 *
 * - a **declared** over-cap length is sent as the request head alone —
 *   `Content-Length` one over the cap and not one body byte. The 413 must
 *   arrive within `RAW_HTTP_READ_TIMEOUT_MS`, which also pins that the refusal is
 *   made on the header: a backend that reads the body before refusing, or has
 *   no cap, waits for bytes that never come and fails the case.
 * - the **chunked** body is sent up to one byte past the cap and never
 *   terminated. The server has read every byte sent by the time it has counted
 *   past the cap, so nothing is left unread, and the 413 must arrive without
 *   the body's end.
 *
 * With `base_url: null` there is no socket and no such race (the in-process
 * `app.request`), so the same cases send whole bodies through the fixture's
 * transport. The under-cap cases go through the transport either way.
 *
 * Like origin/payload rejection, this is middleware-level flat REST — not the
 * JSON-RPC envelope the conformance-table runner expects — so it's an
 * imperative suite, not a `conformance_table` row. Runs both legs via the
 * shared `setup_test` protocol: the in-process leg
 * (`auth/body_size_parity.db.test.ts`, plain `gro test`) and the cross-process
 * leg (`cross_backend/body_size.cross.test.ts`, the TS spine binaries + Rust
 * `testing_spine_stub` over real HTTP). The body-size limit is on every spine,
 * so the suite is ungated.
 *
 * Cited property: `docs/security.md` §"Body Size Limiting".
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { account_verify_action_spec } from '../../auth/account_action_specs.ts';
import { ERROR_PAYLOAD_TOO_LARGE } from '../../http/error_schemas.ts';
import {
	raw_http_exchange,
	raw_http_header_lines,
	raw_http_parse_json,
	raw_http_parse_response,
	RAW_HTTP_READ_TIMEOUT_MS,
	type RawHttpResponse
} from '../transports/raw_http.ts';
import type { RpcPathCrossSuiteOptions, TestFixture } from './setup.ts';
import { SPINE_BODY_LIMIT_DEFAULT_BYTES, SPINE_RPC_PATH } from './spine_surface_constants.ts';

/**
 * Options for the body-size parity suite — the standard RPC-dispatched
 * cross-suite shape (`setup_test` / `rpc_path`) plus where the backend's
 * socket is. The limit is on every spine, so no case is capability-gated and
 * the flag bundle is not on the shape.
 */
export interface BodySizeCrossTestOptions extends RpcPathCrossSuiteOptions {
	/**
	 * Base URL the spawned backend is reachable at (e.g. `http://localhost:1178`),
	 * or `null` for an in-process run, which has no socket. Given a URL, the
	 * over-cap cases write to the socket directly and send only the bytes the
	 * refusal needs; with `null` they send whole bodies through the fixture's
	 * transport.
	 *
	 * Pass the URL whenever the fixture's transport reaches a real socket.
	 * `null` there uploads each whole over-cap body through `fetch`, where the
	 * write races the close that follows the 413 and the case fails some of the
	 * time.
	 */
	readonly base_url: string | null;
}

/**
 * Build an `account_verify` JSON-RPC envelope whose serialized length is
 * *exactly* `target_bytes`, by growing a `params.pad` string to fill. Every
 * character is ASCII, so the string length equals the UTF-8 byte length equals
 * the `Content-Length` the transport sends — which is what the body-size
 * middleware measures. `account_verify` takes no params, but at/over the cap
 * the size check fires before input validation, so the padded shape is never
 * reached on the rejection path.
 */
const sized_envelope = (id: string, target_bytes: number): string => {
	const method = account_verify_action_spec.method;
	const base = JSON.stringify({ jsonrpc: '2.0', method, id, params: { pad: '' } });
	const pad = 'x'.repeat(Math.max(0, target_bytes - base.length));
	return JSON.stringify({ jsonrpc: '2.0', method, id, params: { pad } });
};

/** A small, well-formed nullary `account_verify` body — well under the cap. */
const small_envelope = (id: string): string =>
	JSON.stringify({ jsonrpc: '2.0', method: account_verify_action_spec.method, id });

/** Chunk size of the streamed over-cap body. */
const STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * A request body of `total_bytes` delivered as a stream, so the request
 * carries no `Content-Length` (`Transfer-Encoding: chunked` over a socket).
 * Single-use.
 */
const streamed_body = (total_bytes: number): ReadableStream<Uint8Array> => {
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		pull: (controller) => {
			if (sent >= total_bytes) {
				controller.close();
				return;
			}
			const size = Math.min(STREAM_CHUNK_BYTES, total_bytes - sent);
			sent += size;
			controller.enqueue(new Uint8Array(size).fill(0x78));
		}
	});
};

/** The status and parsed JSON body the over-cap cases assert on. */
interface SizedResponse {
	readonly status: number;
	readonly body: unknown;
}

const to_sized_response = async (res: Response): Promise<SizedResponse> => ({
	status: res.status,
	body: await res.json().catch(() => undefined)
});

/**
 * Write `request_bytes` to the backend's socket and read the one response it
 * must answer with — without being sent anything more.
 *
 * @param withheld - what the request leaves unsent, for the failure message
 */
const exchange_withholding = async (
	base_url: string,
	request_bytes: string,
	withheld: string
): Promise<SizedResponse> => {
	const { received, closed_by_server } = await raw_http_exchange(base_url, request_bytes, {
		read_timeout_ms: RAW_HTTP_READ_TIMEOUT_MS,
		until: 'response'
	});
	const response: RawHttpResponse | null = raw_http_parse_response(received);
	assert.ok(
		response,
		`expected a whole response with ${withheld} withheld; ` +
			(closed_by_server
				? `the server closed the connection first`
				: `none arrived within ${RAW_HTTP_READ_TIMEOUT_MS}ms — the backend is waiting for bytes ` +
					`it should refuse without`) +
			`. Received: ${received ? received.slice(0, 120) : 'nothing'}`
	);
	return { status: response.status, body: raw_http_parse_json(response.body) };
};

/** Assert a response is the canonical over-cap refusal. */
const assert_payload_too_large = (res: SizedResponse, message: string): void => {
	assert.strictEqual(res.status, 413, message);
	assert.strictEqual((res.body as { error?: unknown } | undefined)?.error, ERROR_PAYLOAD_TOO_LARGE);
};

export const describe_body_size_cross_tests = (options: BodySizeCrossTestOptions): void => {
	const { setup_test, base_url } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	/** POST `body` to the RPC path as the keeper. */
	const post = (fixture: TestFixture, body: string): Promise<Response> =>
		fixture.transport(rpc_path, {
			method: 'POST',
			headers: { ...fixture.create_session_headers(), 'content-type': 'application/json' },
			body
		});

	/**
	 * POST as the keeper, with the backend's own `Origin` and a declared
	 * `Content-Length` one byte over the cap. Over a socket only the head is
	 * sent; in-process, the whole body.
	 */
	const post_over_limit_declared = async (
		fixture: TestFixture,
		id: string
	): Promise<SizedResponse> => {
		const headers = fixture.create_session_headers();
		const content_length = SPINE_BODY_LIMIT_DEFAULT_BYTES + 1;
		if (base_url === null) {
			return to_sized_response(
				await fixture.transport(rpc_path, {
					method: 'POST',
					headers: { ...headers, 'content-type': 'application/json' },
					body: sized_envelope(id, content_length)
				})
			);
		}
		const url = new URL(base_url);
		return exchange_withholding(
			base_url,
			`POST ${rpc_path} HTTP/1.1\r\n` +
				raw_http_header_lines({
					host: url.host,
					origin: url.origin,
					...headers,
					'content-type': 'application/json',
					'content-length': String(content_length)
				}) +
				`\r\n`,
			'the declared body'
		);
	};

	/**
	 * POST a chunked body past the cap as the keeper. Over a socket the body
	 * stops one byte past the cap, unterminated; in-process, a whole streamed
	 * body runs past it.
	 */
	const post_over_limit_chunked = async (fixture: TestFixture): Promise<SizedResponse> => {
		if (base_url === null) {
			return to_sized_response(
				await fixture.transport(rpc_path, {
					method: 'POST',
					headers: { ...fixture.create_session_headers(), 'content-type': 'application/json' },
					body: streamed_body(SPINE_BODY_LIMIT_DEFAULT_BYTES + 1024),
					// a streamed request body needs half-duplex `fetch`
					duplex: 'half'
				} as RequestInit)
			);
		}
		const url = new URL(base_url);
		// whole chunks up to exactly the cap, then a one-byte chunk's size line
		// and its byte — and neither that chunk's closing CRLF nor the
		// terminating chunk, so the last byte sent is the first one past the cap
		const whole_chunk = `${STREAM_CHUNK_BYTES.toString(16)}\r\n${'x'.repeat(STREAM_CHUNK_BYTES)}\r\n`;
		return exchange_withholding(
			base_url,
			`POST ${rpc_path} HTTP/1.1\r\n` +
				raw_http_header_lines({
					host: url.host,
					origin: url.origin,
					...fixture.create_session_headers(),
					'content-type': 'application/json',
					'transfer-encoding': 'chunked'
				}) +
				`\r\n` +
				whole_chunk.repeat(SPINE_BODY_LIMIT_DEFAULT_BYTES / STREAM_CHUNK_BYTES) +
				`1\r\nx`,
			`the chunked body's end`
		);
	};

	describe('body-size limit parity', () => {
		test('over-limit POST (cap + 1) → 413 payload_too_large (refused before dispatch)', async () => {
			const fixture = await setup_test();
			// Keeper session cookie + the default allowed Origin, so neither auth
			// nor origin is the cause — only the size. One byte over the cap: both
			// impls reject on a strict `>`.
			const res = await post_over_limit_declared(fixture, 'over-limit');
			assert_payload_too_large(res, 'a body one byte over the cap must be rejected with 413');
		});

		test('at-limit POST (exactly the cap) → not size-rejected', async () => {
			const fixture = await setup_test();
			// Exactly at the cap is one byte under the `>` threshold, so it clears
			// the size gate and reaches the dispatcher. Whatever the dispatcher
			// then returns, it must not be the 413 — that's the lower boundary.
			const res = await post(fixture, sized_envelope('at-limit', SPINE_BODY_LIMIT_DEFAULT_BYTES));
			assert.notStrictEqual(res.status, 413, 'a body exactly at the cap must not be size-rejected');
		});

		test('under-limit POST (small) → 200', async () => {
			const fixture = await setup_test();
			// Small well-formed body: clears the cap and reaches the
			// `account_verify` handler, the positive control that normal traffic
			// passes (and the 413 above is size-gated, not a blanket rejection).
			const res = await post(fixture, small_envelope('under-limit'));
			assert.strictEqual(res.status, 200, 'an under-limit authenticated request must pass');
		});

		test('over-limit chunked POST (no Content-Length), authenticated → 413', async () => {
			const fixture = await setup_test();
			// Keeper session + the default allowed Origin, so nothing but the size
			// refuses. No declared length for the header check to read, so the
			// refusal is by the bytes that arrive.
			const res = await post_over_limit_chunked(fixture);
			assert_payload_too_large(
				res,
				'a chunked body past the cap must be rejected with 413 when nothing else refuses'
			);
		});
	});
};
