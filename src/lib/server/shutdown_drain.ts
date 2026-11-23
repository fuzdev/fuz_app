/**
 * The bounded wait `AppServer.close` makes for the work still in flight, and
 * the report of what it gave up on.
 *
 * Its own module, free of any server framework, so a process that serves the
 * app (`testing/cross_backend/testing_server_core.ts`) reads the report
 * without loading the server. Twin of the Rust spine's shutdown drain
 * (`fuz_http::serve_with_shutdown` and its `ServeShutdown`).
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';

import type { RequestTracker } from '../http/pending_effects.ts';
import type { AuditEmitter } from '../auth/audit_emitter.ts';

/**
 * Default bound on `AppServer.close`'s wait for the effects still in flight
 * (`AppServerOptions.shutdown_drain_timeout_ms`). Twin of the Rust spine's
 * `DEFAULT_DRAIN_TIMEOUT`.
 */
export const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

/**
 * What `AppServer.close` gave up on at its drain bound
 * (`drain_effects_on_shutdown`), each counted on its own: a request still
 * waiting on its audit writes has those writes counted in `audit_writes` too,
 * so the counts are not summed. Every count `0` is a shutdown that drained
 * everything. Twin of the Rust spine's `fuz_http::ServeShutdown`.
 */
export interface ShutdownDrainGivenUp {
	/**
	 * Requests still held — HTTP requests and WS messages alike, each with its
	 * handler or its effect flush still running, and WS upgrades still opening.
	 */
	requests: number;
	/** Pool writes of the audit emitter still in flight. */
	audit_writes: number;
	/**
	 * Upkeep tasks still running — the auth cleanup pass in progress when
	 * `auth_cleanup` scheduled one. Twin of `ServeShutdown`'s
	 * `upkeep_given_up`; here the pass is left to finish rather than aborted.
	 */
	upkeep: number;
}

/**
 * Whether a shutdown gave up on anything — its drain bound ran out before
 * every wait finished. A process reports it as a failed exit. Twin of the
 * Rust `ServeShutdown::gave_up`.
 *
 * @param report - what `AppServer.close` resolved
 */
export const shutdown_gave_up = (report: ShutdownDrainGivenUp): boolean =>
	report.requests > 0 || report.audit_writes > 0 || report.upkeep > 0;

/**
 * Wait for the upkeep stops (the auth cleanup's pass in progress), then the
 * requests held (HTTP requests, WS messages and WS upgrades still opening,
 * one tracker — each until its handler has returned and its flush settled)
 * and then the audit emitter's pool writes, until none is left or
 * `timeout_ms` passes — then log an error naming what was given up on. One
 * bound for all of it. Never rejects. The Rust shutdown joins its upkeep after
 * the request drain; both wait concurrently against one deadline, so only the
 * wait order differs.
 *
 * @param requests - the request tracker
 * @param audit - the audit emitter
 * @param upkeep - each upkeep task's stop, already requested; one still pending at the bound is counted
 * @param timeout_ms - the bound
 * @param log - where a give-up is logged
 * @returns what was given up on, every count `0` when everything settled
 */
export const drain_effects_on_shutdown = async (
	requests: Pick<RequestTracker, 'drain_inflight' | 'inflight_count'>,
	audit: Pick<AuditEmitter, 'drain_inflight' | 'inflight_count'>,
	upkeep: ReadonlyArray<Promise<void>>,
	timeout_ms: number,
	log: Logger
): Promise<ShutdownDrainGivenUp> => {
	let upkeep_pending = upkeep.length;
	const drain = async (): Promise<void> => {
		// the upkeep first, so a write a pass started is in the loop below
		await Promise.all(
			upkeep.map(async (stopped) => {
				await stopped;
				upkeep_pending--;
			})
		);
		// until both are empty: a flush's post-commit thunk can start an audit
		// write, and a request accepted meanwhile is held too
		do {
			await requests.drain_inflight();
			await audit.drain_inflight();
		} while (requests.inflight_count() > 0 || audit.inflight_count() > 0);
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timed_out = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeout_ms);
	});
	try {
		await Promise.race([drain(), timed_out]);
	} finally {
		clearTimeout(timer);
	}
	const given_up: ShutdownDrainGivenUp = {
		requests: requests.inflight_count(),
		audit_writes: audit.inflight_count(),
		upkeep: upkeep_pending
	};
	if (!shutdown_gave_up(given_up)) return given_up;
	log.error(
		`create_app_server: shutdown gave up after ${timeout_ms}ms on work still running — ${given_up.requests} request(s) (handler, effect flush, or WS open), ${given_up.audit_writes} audit row write(s), ${given_up.upkeep} upkeep task(s)`
	);
	return given_up;
};
