import './assert_dev_env.ts';

import { assert } from 'vitest';

import type { ConnectionCloser } from '../actions/connection_closer.ts';

/**
 * Record of a single `ConnectionCloser` method invocation. `at` is the
 * value of a monotonically-increasing sequence counter at the time of
 * the call — pair with `create_emit_ordering_audit_factory` to record both
 * close + audit emit calls into the same sequence for ordering tests.
 */
export interface RecordedClose {
	method: 'session' | 'token' | 'account';
	id: string;
	at: number;
}

export interface RecordingCloser {
	closer: ConnectionCloser;
	calls: Array<RecordedClose>;
}

/**
 * Build a `ConnectionCloser` that records every call into `calls` rather
 * than touching real transports. Each method returns 1 ("one socket
 * closed") regardless of whether a real socket exists — handlers
 * typically ignore the return value.
 *
 * Pass `seq_ref` to share the sequence counter with a sibling
 * `create_emit_ordering_audit_factory` so tests can pin close-vs-emit
 * ordering at the handler call site. Without `seq_ref`, the closer
 * uses a fresh internal counter — `at: N` values within a single test
 * are meaningful, but cannot be compared against audit emit ordering.
 */
export const create_recording_closer = (seq_ref?: { value: number }): RecordingCloser => {
	const calls: Array<RecordedClose> = [];
	const seq = seq_ref ?? { value: 0 };
	const closer: ConnectionCloser = {
		close_sockets_for_session: (id) => {
			calls.push({ method: 'session', id, at: seq.value++ });
			return 1;
		},
		close_sockets_for_token: (id) => {
			calls.push({ method: 'token', id, at: seq.value++ });
			return 1;
		},
		close_sockets_for_account: (id) => {
			calls.push({ method: 'account', id, at: seq.value++ });
			return 1;
		}
	};
	return { closer, calls };
};

/**
 * Pin `{method, id}` on a single recorded close call without baking in
 * the `at: N` sequence number. Use at every "did the closer fire?"
 * assertion site; the sequence number is only meaningful for dedicated
 * ordering tests (paired with `create_emit_ordering_audit_factory`).
 *
 * Throws via `assert.ok` if `call` is `undefined` — index a recorded
 * `calls` array directly (`calls[0]`) and let this helper handle the
 * missing-element case.
 */
export const assert_close_call = (
	call: RecordedClose | undefined,
	method: 'session' | 'token' | 'account',
	id: string
): void => {
	assert.ok(call, 'expected a recorded close call');
	assert.strictEqual(call.method, method);
	assert.strictEqual(call.id, id);
};
