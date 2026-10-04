/**
 * Periodic background task primitive.
 *
 * The loop every long-running process reaches for when it owns upkeep — an
 * expiry sweep, a cleanup pass: one pass at startup, then one per interval,
 * until stopped. `start_periodic` is that loop in one place, so a sweep is
 * its pass plus one call, and every sweep keeps the same rules for a slow
 * pass, a failed pass, and shutdown. `start_auth_cleanup` (`auth/cleanup.ts`)
 * is built on it; a consumer's own sweeps use it the same way:
 *
 * ```ts
 * const temp_sweep = start_periodic('temp sweep', 60 * 60 * 1000, () => sweep_temps(root), log);
 * // … serve …
 * // on shutdown, before what the pass uses is torn down
 * await temp_sweep.stop();
 * ```
 *
 * Twin of the Rust spine's `fuz_sys::periodic::spawn_periodic`. The schedule
 * is the same; shutdown differs, because a promise cannot be dropped — see
 * `start_periodic`.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';

/**
 * The longest interval `start_periodic` accepts: the largest delay a timer
 * honors (a signed 32-bit count of milliseconds, about 24.8 days). Past it
 * `setTimeout` fires after one millisecond instead, which would turn a long
 * interval into a pass loop.
 */
export const PERIODIC_INTERVAL_MS_MAX = 2 ** 31 - 1;

/** A running periodic task — the result of `start_periodic`. */
export interface PeriodicTask {
	/**
	 * End the schedule. No pass starts once this is called, and the returned
	 * promise resolves when the pass in progress, if any, has finished — it
	 * never rejects. Await it before tearing down what the pass uses (the
	 * database, say). The wait has no bound of its own; a shutdown with a
	 * deadline races it. Safe to call more than once.
	 */
	stop: () => Promise<void>;
}

/**
 * Run `pass` now, then once per `interval_ms`, until `stop` is called.
 *
 * - **Startup pass.** The first pass starts before this returns; later passes
 *   follow one `interval_ms` apart, start to start.
 * - **A slow pass delays the schedule.** Passes never overlap, and a pass that
 *   overruns its interval pushes the next one back: the next pass starts when
 *   the slow one ends, the one after a full `interval_ms` later — no burst of
 *   catch-up passes.
 * - **A failed pass is logged, never fatal.** A pass that throws or rejects
 *   is logged at `warn` with `name` and the error object itself — so the log
 *   carries its stack and its `cause` — and the loop goes on to the next
 *   interval, so an outage is retried rather than ending the upkeep for the
 *   life of the process.
 * - **`stop` finishes the pass in progress.** It ends the schedule at once and
 *   resolves when a pass in progress has finished; nothing is dropped
 *   mid-flight.
 *
 * The timer is unref'd where the runtime hands back a timer object (Node,
 * Bun), so a task nobody stopped does not hold the process open.
 *
 * `pass` is called once per pass and returns that pass's promise. `name`
 * labels the task in the failure log.
 *
 * Twin of the Rust `spawn_periodic`. The schedule is that loop's
 * `MissedTickBehavior::Delay`. Shutdown differs: the Rust task drops a pass
 * in progress when its token is cancelled, so joining it is prompt and a pass
 * must be safe to drop; here the pass runs to its end and `stop` waits for it.
 *
 * @param name - labels the task in the failure log
 * @param interval_ms - milliseconds between the start of one pass and the start of the next
 * @param pass - one pass; called once per pass, its resolved value is ignored
 * @param log - where a failed pass is logged
 * @returns the task's `stop`
 * @throws Error if `interval_ms` is not a positive finite number or exceeds `PERIODIC_INTERVAL_MS_MAX` — at the call site, before any pass starts
 */
export const start_periodic = (
	name: string,
	interval_ms: number,
	pass: () => Promise<unknown>,
	log: Logger
): PeriodicTask => {
	if (!Number.isFinite(interval_ms) || interval_ms <= 0 || interval_ms > PERIODIC_INTERVAL_MS_MAX) {
		throw new Error(
			`start_periodic (${name}): interval_ms must be a positive number of milliseconds no greater than ${
				PERIODIC_INTERVAL_MS_MAX
			}, got ${interval_ms}`
		);
	}

	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let in_progress: Promise<void> | null = null;

	const run_pass = async (): Promise<void> => {
		try {
			await pass();
		} catch (error) {
			// the error object itself, so the log carries its stack and cause
			log.warn(`${name} pass failed:`, error);
		}
	};

	// One pass plus the timer for the next one's earliest start. The next pass
	// starts when both have happened — the interval elapsed and this pass
	// finished — whichever comes last, so passes never overlap and an overrun
	// delays the schedule by exactly its length.
	const start_pass = (): void => {
		let due = false;
		let finished = false;
		timer = setTimeout(() => {
			timer = null;
			due = true;
			if (finished) start_pass();
		}, interval_ms);
		// allow the process to exit even if the timer is still pending
		if (typeof timer === 'object' && 'unref' in timer) {
			timer.unref();
		}
		in_progress = run_pass()
			// `run_pass` rejects only if the logger itself throws; swallowed so
			// `stop` never rejects and nothing surfaces as an unhandled rejection
			.catch(() => {})
			.finally(() => {
				in_progress = null;
				finished = true;
				if (due && !stopped) start_pass();
			});
	};
	start_pass();

	return {
		stop: async (): Promise<void> => {
			stopped = true;
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			await in_progress;
		}
	};
};
