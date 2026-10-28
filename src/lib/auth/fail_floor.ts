/**
 * The wall-clock floor on auth-denial responses, shared by login and signup.
 *
 * Without a floor on denial paths, an attacker can tell cheap rejections
 * (signup's `no_matching_invite`, which bails before Argon2 and the
 * transaction) from expensive ones (`signup_conflict`, Argon2 + transaction +
 * rollback) by response time, and use the gap as a username-enumeration
 * oracle. Each route picks its own floor and jitter; this module holds the
 * delay and the loud warning when a floor is turned off. Twin of the Rust
 * spine's `fuz_auth::timing`.
 *
 * 429 responses take no floor — they short-circuit before any work, and their
 * timing is no enumeration signal.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';

/** Which denial-timing floor a disabled-floor banner names. */
export type FailFloor = 'login' | 'signup';

/** The stderr line a process prints when the login failure floor is off — the Rust spine's text. */
export const LOGIN_FAIL_FLOOR_DISABLED_BANNER =
	'!!! LOGIN FAILURE TIMING FLOOR DISABLED — test-only mode. A production server must never print this.';

/** The stderr line a process prints when the signup failure floor is off — the Rust spine's text. */
export const SIGNUP_FAIL_FLOOR_DISABLED_BANNER =
	'!!! SIGNUP FAILURE TIMING FLOOR DISABLED — test-only mode. A production server must never print this.';

const fail_floor_warned: Record<FailFloor, boolean> = { login: false, signup: false };

/**
 * Announce, once per module instance per floor, that a denial-timing floor is
 * off.
 *
 * Called by the route factories (`create_account_route_specs`,
 * `create_signup_route_specs`) at assembly when the configured floor is `0` or
 * less. A disabled floor turns off the username-enumeration defense, so — like
 * the rate limiters' `announce_rate_limiters_disabled` — it goes to stderr as
 * well as the log: a deployment that copied a test binary's `0` shows it in
 * its first lines of output. A positive floor prints nothing.
 *
 * @param floor - which floor
 * @param floor_ms - the configured floor
 * @param log - where the warning is logged beside the stderr banner
 */
export const warn_if_fail_floor_disabled = (
	floor: FailFloor,
	floor_ms: number,
	log: Logger
): void => {
	if (floor_ms > 0 || fail_floor_warned[floor]) return;
	fail_floor_warned[floor] = true;
	console.error(
		floor === 'login' ? LOGIN_FAIL_FLOOR_DISABLED_BANNER : SIGNUP_FAIL_FLOOR_DISABLED_BANNER
	);
	log.warn(`${floor} failure timing floor disabled — test-only mode`);
};

/**
 * Start the denial floor: a promise resolving `floor_ms` ± `jitter_ms` from
 * now, or at once when `floor_ms` is `0` or less (the floor disabled).
 *
 * Call it before the denial path's work and await it after, so the observed
 * response time is `max(work, delay)`, not `work + delay`. The timer starts
 * at the call. Uniform jitter keeps a stable clamp point from leaking when a
 * path occasionally exceeds the floor; `Math.random` suffices, since only the
 * exact delay must be unpredictable.
 *
 * @param floor_ms - the floor
 * @param jitter_ms - the jitter window on either side of the floor; `0` or less for none
 * @returns a promise resolving when the floor has passed
 */
export const start_fail_floor = (floor_ms: number, jitter_ms: number): Promise<void> => {
	if (floor_ms <= 0) return Promise.resolve();
	const jitter = jitter_ms > 0 ? Math.floor(Math.random() * (jitter_ms * 2 + 1)) - jitter_ms : 0;
	return new Promise((resolve) => setTimeout(resolve, floor_ms + jitter));
};
