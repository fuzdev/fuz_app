import './assert_dev_env.ts';

import { assert } from 'vitest';

import type { ConnectionCloser } from '../actions/connection_closer.ts';

/** Record of a single `ConnectionCloser` method invocation. */
export interface RecordedClose {
	method: 'session' | 'token' | 'account';
	id: string;
}

export interface RecordingCloser {
	closer: ConnectionCloser;
	calls: Array<RecordedClose>;
}

/**
 * Build a `ConnectionCloser` that records every call into `calls` rather
 * than touching real transports. Each method returns 1 ("one connection
 * closed") regardless of whether a real connection exists — handlers
 * ignore the return value.
 *
 * To see a handler's closes, add the closer to the backend's
 * `deps.connection_closer` (`RealtimeCloser.add`), or build the action
 * factory's deps with it.
 */
export const create_recording_closer = (): RecordingCloser => {
	const calls: Array<RecordedClose> = [];
	const closer: ConnectionCloser = {
		close_sockets_for_session: (id) => {
			calls.push({ method: 'session', id });
			return 1;
		},
		close_sockets_for_token: (id) => {
			calls.push({ method: 'token', id });
			return 1;
		},
		close_sockets_for_account: (id) => {
			calls.push({ method: 'account', id });
			return 1;
		}
	};
	return { closer, calls };
};

/**
 * Pin `{method, id}` on a single recorded close call.
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
