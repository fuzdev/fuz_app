/**
 * Process ID validation shared by the `probe_process` implementations and
 * their callers.
 *
 * @module
 */

/** The largest process ID: `pid_t` is a signed 32-bit integer. */
export const PROCESS_ID_MAX = 2_147_483_647;

/**
 * Whether `pid` names one process: a positive integer within `pid_t` range.
 * 0 and negative numbers name process groups (`kill(0, …)` signals the
 * caller's own group, `kill(-1, …)` every process it may signal).
 *
 * @param pid - the candidate process ID
 */
export const is_process_id = (pid: number): boolean =>
	Number.isInteger(pid) && pid > 0 && pid <= PROCESS_ID_MAX;

/**
 * Refuse a `pid` that doesn't name one process (`is_process_id`).
 *
 * @param pid - the candidate process ID
 * @throws RangeError when `pid` is not a positive integer within `pid_t` range
 */
export const assert_process_id = (pid: number): void => {
	if (!is_process_id(pid)) {
		throw new RangeError(`not a process ID: ${pid} (a positive integer up to ${PROCESS_ID_MAX})`);
	}
};
