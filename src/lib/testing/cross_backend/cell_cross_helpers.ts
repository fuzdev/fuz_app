import '../assert_dev_env.ts';

/**
 * Shared call-site primitives for the cell cross-backend parity suites
 * (`testing/cross_backend/cell_crud.ts` + `testing/cross_backend/cell_relations.ts`).
 *
 * The cell verbs are stateful and authz-shaped, so both suites POST raw
 * JSON-RPC envelopes (threading ids + auth headers across calls) and parse
 * every success `result` against the verb's declared Zod **output** schema —
 * the wire-shape parity gate. A TS↔Rust envelope drift, not just a payload
 * field drift, fails the assertion.
 *
 * `$lib`-free by contract (relative specifiers only) so the suites can be
 * imported from the spawnable cross-process test files.
 *
 * @module
 */

import { assert } from 'vitest';
import type { z } from 'zod';

import { create_rpc_post_init } from '../rpc_helpers.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';

/** Minimal JSON-RPC envelope shape the suites read off responses. */
export interface RpcResult {
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/**
 * POST a JSON-RPC call over a cross-process `FetchTransport` with the given
 * auth headers. Distinct from `testing/rpc_helpers.ts`'s `app`-based `rpc_call`: this
 * variant drives the cookie-jar `FetchTransport` the cross-backend harness
 * spawns against, and returns the slim `RpcResult` the cell suites read.
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
	const body = (await res.json()) as { result?: unknown; error?: RpcResult['error'] };
	return { ok: res.ok, result: body.result, error: body.error };
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
