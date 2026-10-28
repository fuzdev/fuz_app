import './assert_dev_env.ts';

import { assert } from 'vitest';

import type { ConnectionCloser, ConnectionCloseTarget } from '../actions/connection_closer.ts';

/**
 * Record of a single `ConnectionCloser` call — the `ConnectionCloseTarget` a
 * `close_connections` was given, or `{kind: 'all'}` for
 * `close_all_connections`.
 */
export type RecordedClose = ConnectionCloseTarget | { kind: 'all' };

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
		close_connections: (target) => {
			calls.push(target);
			return 1;
		},
		close_all_connections: () => {
			calls.push({ kind: 'all' });
			return 1;
		}
	};
	return { closer, calls };
};

/**
 * Pin a single recorded close call to `expected` (deep equality).
 *
 * Throws via `assert.ok` if `call` is `undefined` — index a recorded
 * `calls` array directly (`calls[0]`) and let this helper handle the
 * missing-element case.
 */
export const assert_close_call = (
	call: RecordedClose | undefined,
	expected: RecordedClose
): void => {
	assert.ok(call, 'expected a recorded close call');
	assert.deepEqual(call, expected);
};
