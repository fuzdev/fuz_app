import './assert_dev_env.ts';

/**
 * A recording `SetupFlowLogger`, so a setup flow's test asserts each line and
 * the method (and so the stream) it went through without touching `console`.
 *
 * @module
 */

import type { SetupFlowLogger } from '../dev/setup.ts';

/** A `SetupFlowLogger` method name. */
export type SetupFlowLogMethod = keyof SetupFlowLogger;

/** One call a `RecordingSetupFlowLogger` got: the method and its message. */
export type SetupFlowLogEntry = [method: SetupFlowLogMethod, msg: string];

/** A `SetupFlowLogger` that records each call, in order, instead of printing. */
export interface RecordingSetupFlowLogger extends SetupFlowLogger {
	/** Every call, in order, as `[method, msg]`. */
	entries: Array<SetupFlowLogEntry>;
}

/**
 * Build a `SetupFlowLogger` that records each call into `entries`, printing
 * nothing. It is a `SetupLogger` too, so a test passes one recorder to a
 * flow and to the `dev/setup.ts` helpers it calls, and asserts the whole
 * output in order.
 *
 * @returns a logger recording each call in its `entries`
 */
export const create_recording_setup_flow_logger = (): RecordingSetupFlowLogger => {
	const entries: Array<SetupFlowLogEntry> = [];
	return {
		entries,
		ok: (msg) => void entries.push(['ok', msg]),
		skip: (msg) => void entries.push(['skip', msg]),
		warn: (msg) => void entries.push(['warn', msg]),
		error: (msg) => void entries.push(['error', msg]),
		print: (msg) => void entries.push(['print', msg]),
		print_error: (msg) => void entries.push(['print_error', msg])
	};
};

/**
 * The messages one method of a recorder got.
 *
 * @param log - the recorder
 * @param method - which method's calls
 * @returns their messages, in order
 */
export const setup_flow_log_messages = (
	log: RecordingSetupFlowLogger,
	method: SetupFlowLogMethod
): Array<string> => log.entries.filter(([m]) => m === method).map(([, msg]) => msg);
