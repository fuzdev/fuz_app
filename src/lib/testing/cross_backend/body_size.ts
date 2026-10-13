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
 * shape, on the exact `>` cap boundary (not an off-by-one divergence), and on
 * the cap answering ahead of the origin check and of auth. The cases:
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
 * - **over-limit POST with a disallowed `Origin` → 413**, not the origin
 *   check's 403, and **over-limit POST with no credentials → 413**, not 401:
 *   the cap answers a declared length ahead of both. The control — the same
 *   disallowed `Origin` on an under-limit body → 403 `forbidden_origin` —
 *   shows the origin check still runs.
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
 * **Real-socket connection hazard (cross-process only).** When the server caps
 * the body it answers 413 and closes the connection *before* the client
 * finishes uploading — correct HTTP, since an unread request body can't share a
 * keep-alive socket. Two things follow for the client. Its own upload races
 * that close, so the write can fail (`EPIPE`) before the 413 the server did
 * send is read; and its pool can hand the now-dead socket to the very next
 * request (observed as `other side closed`). So every request here goes
 * through `fetch_retrying_thrown`: a call that throws is re-sent on a fresh
 * connection, which both keeps the suite deterministic *and* evicts the dead
 * socket so it can't strand a later cross suite in the same process. A
 * returned response is never retried — it is the thing under assertion.
 * In-process (`app.request`) has no socket, so the hazard is
 * cross-process-only and the retry never fires there.
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
import { ERROR_FORBIDDEN_ORIGIN, ERROR_PAYLOAD_TOO_LARGE } from '../../http/error_schemas.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
import type { RpcPathCrossSuiteOptions } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';

/**
 * Options for the body-size parity suite — the standard RPC-dispatched
 * cross-suite shape (`setup_test` / `rpc_path`); aliases the shared
 * `RpcPathCrossSuiteOptions` rather than minting a duplicate. The limit is
 * on every spine, so no case is capability-gated and the flag bundle is not
 * on the shape.
 */
export type BodySizeCrossTestOptions = RpcPathCrossSuiteOptions;

/**
 * The shared 1 MiB default both impls ship (`DEFAULT_MAX_BODY_SIZE` in TS,
 * `DEFAULT_BODY_LIMIT_BYTES` in `fuz_http`). Kept as a local cross-impl
 * contract value rather than imported from either impl — the boundary it
 * pins is the shared default, and a change to either is a deliberate
 * cross-impl decision that would revisit this suite regardless.
 */
const BODY_LIMIT_DEFAULT_BYTES = 1024 * 1024;

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

/** An `Origin` no backend's allowlist admits. */
const DISALLOWED_ORIGIN = 'http://evil.com';

/** Chunk size of the streamed over-cap body. */
const STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * A request body of `total_bytes` delivered as a stream, so the request
 * carries no `Content-Length` (`Transfer-Encoding: chunked` over a socket).
 * Single-use — build one per attempt.
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

/** How many times a request is sent before a transport throw is let through. */
const FETCH_ATTEMPTS = 4;

/**
 * Issue a request, re-sending when the call *throws* (vs. returning a
 * response). An oversized upload racing the server's close, or a request
 * handed the keep-alive socket that close left dead, fails at the transport
 * layer before any response; a re-send opens a fresh connection (and drops the
 * dead socket from the pool). Keyed on "threw at all" rather than a specific
 * error code so it holds across the node / deno / bun cross runtimes, which
 * surface different errors. The last throw propagates, so an unreachable
 * backend still fails loudly.
 *
 * @param create_init - builds the request init; called per attempt, since a streamed body is single-use
 */
const fetch_retrying_thrown = async (
	transport: FetchTransport,
	path: string,
	create_init: () => RequestInit
): Promise<Response> => {
	let last_error: unknown;
	for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
		try {
			return await transport(path, create_init());
		} catch (error) {
			last_error = error;
		}
	}
	throw last_error;
};

/** Assert a response is the canonical over-cap refusal. */
const assert_payload_too_large = async (res: Response, message: string): Promise<void> => {
	assert.strictEqual(res.status, 413, message);
	const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
	assert.strictEqual(body?.error, ERROR_PAYLOAD_TOO_LARGE);
};

export const describe_body_size_cross_tests = (options: BodySizeCrossTestOptions): void => {
	const { setup_test } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	/** POST `body` to the RPC path as the keeper, re-sent when the transport throws. */
	const post = (fixture: Awaited<ReturnType<typeof setup_test>>, body: string): Promise<Response> =>
		fetch_retrying_thrown(fixture.transport, rpc_path, () => ({
			method: 'POST',
			headers: { ...fixture.create_session_headers(), 'content-type': 'application/json' },
			body
		}));

	describe('body-size limit parity', () => {
		test('over-limit POST (cap + 1) → 413 payload_too_large (refused before dispatch)', async () => {
			const fixture = await setup_test();
			// Keeper session cookie + the transport's default allowed Origin, so
			// neither auth nor origin is the cause — only the body size. One byte
			// over the cap: both impls reject on a strict `>`.
			const res = await post(fixture, sized_envelope('over-limit', BODY_LIMIT_DEFAULT_BYTES + 1));
			await assert_payload_too_large(res, 'a body one byte over the cap must be rejected with 413');
		});

		test('at-limit POST (exactly the cap) → not size-rejected', async () => {
			const fixture = await setup_test();
			// Exactly at the cap is one byte under the `>` threshold, so it clears
			// the size gate and reaches the dispatcher. Whatever the dispatcher
			// then returns, it must not be the 413 — that's the lower boundary.
			const res = await post(fixture, sized_envelope('at-limit', BODY_LIMIT_DEFAULT_BYTES));
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

		test('over-limit POST with a disallowed Origin → 413, not 403', async () => {
			const fixture = await setup_test();
			// Keeper session + a rogue Origin: the origin check would answer 403,
			// and the cap, which reads only the declared length, answers first.
			const res = await fetch_retrying_thrown(fixture.transport, rpc_path, () => ({
				method: 'POST',
				headers: {
					...fixture.create_session_headers(),
					origin: DISALLOWED_ORIGIN,
					'content-type': 'application/json'
				},
				body: sized_envelope('over-limit-evil-origin', BODY_LIMIT_DEFAULT_BYTES + 1)
			}));
			await assert_payload_too_large(
				res,
				'a declared length over the cap must answer 413 ahead of the origin check'
			);
		});

		test('under-limit POST with a disallowed Origin → 403 forbidden_origin', async () => {
			const fixture = await setup_test();
			// The control for the case above: the same request minus the size is
			// refused by the origin check, so the 413 there is the cap answering
			// first, not the origin check being absent.
			const res = await fetch_retrying_thrown(fixture.transport, rpc_path, () => ({
				method: 'POST',
				headers: {
					...fixture.create_session_headers(),
					origin: DISALLOWED_ORIGIN,
					'content-type': 'application/json'
				},
				body: small_envelope('under-limit-evil-origin')
			}));
			assert.strictEqual(res.status, 403, 'a disallowed Origin on an under-limit body is refused');
			const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
			assert.strictEqual(body?.error, ERROR_FORBIDDEN_ORIGIN);
		});

		test('over-limit POST with no credentials → 413, not 401', async () => {
			const fixture = await setup_test();
			// A cookie-jar-free transport: the dispatcher would answer 401, and
			// the cap answers first.
			const res = await fetch_retrying_thrown(fixture.fresh_transport(), rpc_path, () => ({
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: sized_envelope('over-limit-anonymous', BODY_LIMIT_DEFAULT_BYTES + 1)
			}));
			await assert_payload_too_large(
				res,
				'a declared length over the cap must answer 413 ahead of auth'
			);
		});

		test('over-limit chunked POST (no Content-Length), authenticated → 413', async () => {
			const fixture = await setup_test();
			// Keeper session + the default allowed Origin, so nothing but the size
			// refuses. The body is streamed: no declared length for the header
			// check to read, so the refusal is by the bytes that arrive.
			const res = await fetch_retrying_thrown(
				fixture.transport,
				rpc_path,
				() =>
					({
						method: 'POST',
						headers: { ...fixture.create_session_headers(), 'content-type': 'application/json' },
						body: streamed_body(BODY_LIMIT_DEFAULT_BYTES + 1024),
						// a streamed request body needs half-duplex `fetch`
						duplex: 'half'
					}) as RequestInit
			);
			await assert_payload_too_large(
				res,
				'a chunked body past the cap must be rejected with 413 when nothing else refuses'
			);
		});
	});
};
