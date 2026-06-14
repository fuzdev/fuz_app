import '../assert_dev_env.js';

/**
 * Cross-backend parity suite for the request body-size limit.
 *
 * `create_app_server` (TS) and the Rust spine both cap the request body at a
 * 1 MiB default (`DEFAULT_MAX_BODY_SIZE` / `fuz_http`'s
 * `DEFAULT_BODY_LIMIT_BYTES`) and reject oversized payloads with `413` and the
 * canonical flat REST body `{error: 'payload_too_large'}` — *before* auth,
 * origin, or dispatch run (middleware step 4). Each impl unit-tests this in
 * isolation, but nothing fires an oversized POST over the wire, so the
 * cross-impl agreement on the status + body shape (and on the exact `>` cap
 * boundary, not an off-by-one divergence) was unpinned. Three cases:
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
 *
 * **Real-socket connection hazard (cross-process only).** When the server caps
 * the body it answers 413 and closes the connection *before* the client
 * finishes uploading — correct HTTP, since an unread request body can't share a
 * keep-alive socket. The client's pool can then hand that now-dead socket to
 * the very next request (observed as `other side closed`). So every request
 * here goes through `fetch_retrying_once`: a request that inherits the poisoned
 * socket retries onto a fresh connection, which both keeps the suite
 * deterministic *and* evicts the dead socket so it can't strand a later cross
 * suite in the same process. In-process (`app.request`) has no socket, so the
 * hazard is cross-process-only and the retry never fires there.
 *
 * Like origin/payload rejection, this is middleware-level flat REST — not the
 * JSON-RPC envelope the conformance-table runner expects — so it's an
 * imperative suite, not a `conformance_table` row. Runs both legs via the
 * shared `{setup_test, capabilities}` protocol: the in-process leg
 * (`auth/body_size_parity.db.test.ts`, plain `gro test`) and the cross-process
 * leg (`cross_backend/body_size.cross.test.ts`, the TS spine binaries + Rust
 * `testing_spine_stub` over real HTTP). The body-size limit is on every spine,
 * so the suite is ungated.
 *
 * Cited property: `docs/security.md` §"Body Size Limiting".
 *
 * `$lib`-free by contract (relative specifiers only), like the sibling
 * cross-backend suites.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {account_verify_action_spec} from '../../auth/account_action_specs.js';
import {ERROR_PAYLOAD_TOO_LARGE} from '../../http/error_schemas.js';
import type {FetchTransport} from '../transports/fetch_transport.js';
import type {RpcPathCrossSuiteOptions} from './setup.js';
import {SPINE_RPC_PATH} from './default_spine_surface.js';

/**
 * Options for the body-size parity suite — the standard RPC-dispatched
 * cross-suite shape (`setup_test` / `capabilities` / `rpc_path`); aliases the
 * shared `RpcPathCrossSuiteOptions` rather than minting a duplicate.
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
	const base = JSON.stringify({jsonrpc: '2.0', method, id, params: {pad: ''}});
	const pad = 'x'.repeat(Math.max(0, target_bytes - base.length));
	return JSON.stringify({jsonrpc: '2.0', method, id, params: {pad}});
};

/** A small, well-formed nullary `account_verify` body — well under the cap. */
const small_envelope = (id: string): string =>
	JSON.stringify({jsonrpc: '2.0', method: account_verify_action_spec.method, id});

/**
 * Issue a request, retrying once if the call *throws* (vs. returning a
 * response). A request handed the keep-alive socket the server closed on an
 * oversized-body rejection fails at the transport layer before any response;
 * one retry opens a fresh connection (and drops the dead socket from the
 * pool). Keyed on "threw at all" rather than a specific error code so it holds
 * across the node / deno / bun cross runtimes, which surface different errors.
 */
const fetch_retrying_once = async (
	transport: FetchTransport,
	path: string,
	init: RequestInit,
): Promise<Response> => {
	try {
		return await transport(path, init);
	} catch {
		return await transport(path, init);
	}
};

export const describe_body_size_cross_tests = (options: BodySizeCrossTestOptions): void => {
	const {setup_test} = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	/** POST `body` to the RPC path as the keeper, retry-once on a dead socket. */
	const post = (fixture: Awaited<ReturnType<typeof setup_test>>, body: string): Promise<Response> =>
		fetch_retrying_once(fixture.transport, rpc_path, {
			method: 'POST',
			headers: {...fixture.create_session_headers(), 'content-type': 'application/json'},
			body,
		});

	describe('body-size limit parity', () => {
		test('over-limit POST (cap + 1) → 413 payload_too_large (refused before dispatch)', async () => {
			const fixture = await setup_test();
			// Keeper session cookie + the transport's default allowed Origin, so
			// neither auth nor origin is the cause — only the body size. One byte
			// over the cap: both impls reject on a strict `>`.
			const res = await post(fixture, sized_envelope('over-limit', BODY_LIMIT_DEFAULT_BYTES + 1));
			assert.strictEqual(res.status, 413, 'a body one byte over the cap must be rejected with 413');
			const body = (await res.json().catch(() => undefined)) as {error?: unknown} | undefined;
			assert.strictEqual(body?.error, ERROR_PAYLOAD_TOO_LARGE);
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
	});
};
