import '../assert_dev_env.ts';

/**
 * JSON-RPC call-site primitives for the cross-backend suites.
 *
 * The stateful suites (the cell verbs, account lifecycle, role grants, tokens,
 * facts, audit reads) POST raw JSON-RPC envelopes over a cross-process
 * `FetchTransport`, threading ids and auth headers across calls, and parse
 * every success `result` against the verb's declared Zod **output** schema —
 * the wire-shape parity gate. A TS↔Rust envelope drift, not just a payload
 * field drift, fails the assertion.
 *
 * @module
 */

import { assert } from 'vitest';
import type { z } from 'zod';

import { create_rpc_post_init } from '../rpc_helpers.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';

/** Minimal JSON-RPC envelope shape the suites read off responses. */
export interface RpcResult {
	/** The HTTP status the reply carried. */
	readonly status: number;
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** How much of a non-envelope reply body `cross_rpc_call`'s error quotes. */
const BODY_HEAD_LENGTH = 200;

/**
 * POST a JSON-RPC call over a cross-process `FetchTransport` with the given
 * auth headers. Distinct from `testing/rpc_helpers.ts`'s `app`-based `rpc_call`: this
 * variant drives the cookie-jar `FetchTransport` the cross-backend harness
 * spawns against, and returns the slim `RpcResult` the suites read.
 *
 * @param transport - the transport to send on
 * @param path - the RPC endpoint path
 * @param method - the JSON-RPC method
 * @param params - the request params
 * @param headers - auth and other headers, merged over the JSON defaults
 * @returns the response's HTTP `status`, `ok`, `result` and `error`
 * @throws Error when the reply is not a JSON object — naming the method, the
 *   HTTP status and the head of the body, so a proxy page or a crash reads
 *   as what it is
 */
export const cross_rpc_call = async (
	transport: FetchTransport,
	path: string,
	method: string,
	params: unknown,
	headers: Record<string, string>
): Promise<RpcResult> => {
	const init = create_rpc_post_init(method, params);
	Object.assign(init.headers as Record<string, string>, headers);
	const res = await transport(path, init);
	const text = await res.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = undefined;
	}
	if (body === null || typeof body !== 'object') {
		throw new Error(
			`${method}: expected a JSON-RPC envelope, got status ${res.status} with body: ` +
				JSON.stringify(text.slice(0, BODY_HEAD_LENGTH))
		);
	}
	const envelope = body as { result?: unknown; error?: RpcResult['error'] };
	return { status: res.status, ok: res.ok, result: envelope.result, error: envelope.error };
};

/** Pull `error.data.reason` off an RPC error envelope (undefined if absent). */
export const error_reason = (r: RpcResult): unknown =>
	r.error && typeof r.error.data === 'object' && r.error.data !== null
		? (r.error.data as Record<string, unknown>).reason
		: undefined;

/**
 * Assert the call succeeded and the `result` matches the verb's declared
 * output schema — the wire-shape parity gate. Returns the parsed output.
 */
export const expect_output = <T>(r: RpcResult, schema: z.ZodType<T>): T => {
	assert.ok(r.ok, `expected success, got ${JSON.stringify(r.error)}`);
	const parsed = schema.safeParse(r.result);
	assert.ok(
		parsed.success,
		`result does not match output schema: ${
			parsed.success ? '' : JSON.stringify(parsed.error.issues)
		} (got ${JSON.stringify(r.result)})`
	);
	return parsed.data;
};
