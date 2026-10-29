/**
 * The credential deadline — the moment a resolved credential stops
 * authenticating, which a long-lived connection opened on it must not outlive.
 *
 * A WebSocket or an SSE stream is authorized once, at open, and closed on
 * revocation by identity. Expiry has no revocation event: nothing is written
 * when a session or token passes its `expires_at`. So the auth middleware
 * computes the deadline once (`ResolvedAuth.credential_deadline`) and the
 * transport closes the connection when it arrives
 * (`schedule_credential_deadline`).
 *
 * The deadline is the earliest of what the credential carries:
 *
 * - **Session** — the signed cookie's embedded expiry and the `auth_session`
 *   row's `expires_at`.
 * - **API token** — the `api_token` row's `expires_at`; an eternal token
 *   (`expires_at IS NULL`) has none.
 * - **Daemon token** — none: it has no row and no expiry, and a rotation
 *   closes no connection.
 *
 * A row's expiry is read as **remaining time measured on the database clock**
 * (`EXPIRES_IN_MS_SQL`, `expires_at - NOW()` in the same statement that checks
 * `expires_at > NOW()`), then anchored to this process's monotonic clock
 * (`performance.now()`) — so a skew between the database's clock and the
 * server's moves no deadline. The cookie's expiry is a wall-clock second this
 * server signed, read against the same wall clock the cookie check reads.
 *
 * The monotonic clock stops while the host is suspended, so a deadline on it
 * alone would hold a connection past its credential by the time asleep. The
 * wait (`schedule_credential_deadline`) therefore also carries the deadline on
 * the wall clock (`Date.now()`), which keeps running through a suspend, and
 * fires at whichever is reached first: after a resume, within one timer step
 * (`CREDENTIAL_DEADLINE_TIMER_CAP_MS`, an hour). The wall deadline is taken
 * from the time left when the wait starts, so a skew between the database's
 * clock and the server's still moves nothing. A wall clock stepped forward
 * can fire it early; the client reconnects through the gates, the fail-closed
 * side of the trade.
 *
 * The twin of the Rust spine's `fuz_auth::ResolvedAuth::credential_deadline`
 * and `fuz_realtime`'s deadline wait.
 *
 * @module
 */

/**
 * SQL expression for a row's remaining lifetime in milliseconds, measured on
 * the database clock — `NULL` when `expires_at` is `NULL` (an eternal API
 * token). `float8`, so every driver reads it as a JS number.
 */
export const EXPIRES_IN_MS_SQL = '(EXTRACT(EPOCH FROM (expires_at - NOW())) * 1000)::float8';

/**
 * The longest single timer the deadline wait sets — one hour, far inside
 * `setTimeout`'s ceiling (2^31 - 1 ms, about 24.8 days, past which a timer
 * fires at once) and the Rust twin's tokio ceiling, and short enough that a
 * resume from suspend is noticed within it. A longer deadline is reached
 * through several.
 */
export const CREDENTIAL_DEADLINE_TIMER_CAP_MS = 3_600_000;

/**
 * The deadline `now` plus the shortest of `remaining_ms`, as a monotonic
 * `performance.now()` timestamp, or `null` when no entry carries one.
 *
 * A negative or `NaN` entry — a row its own `expires_at > NOW()` check
 * already refused, read at the boundary — counts as zero.
 *
 * @param remaining_ms - each source's remaining lifetime in ms, `null` for none
 * @param now - the monotonic clock reading to anchor to
 * @returns the deadline, or `null` for a credential with no expiry
 */
export const credential_deadline_after = (
	remaining_ms: ReadonlyArray<number | null>,
	now: number = performance.now()
): number | null => {
	let shortest: number | null = null;
	for (const ms of remaining_ms) {
		if (ms === null) continue;
		const clamped = Number.isNaN(ms) ? 0 : Math.max(0, ms);
		if (shortest === null || clamped < shortest) shortest = clamped;
	}
	return shortest === null ? null : now + shortest;
};

/**
 * The next timer toward `deadline` from `now`: what remains, capped at
 * `CREDENTIAL_DEADLINE_TIMER_CAP_MS`, or `null` once the deadline is reached.
 *
 * @param deadline - the monotonic deadline
 * @param now - the monotonic clock reading
 * @returns the next delay in ms, or `null` when the deadline has passed
 */
export const next_credential_deadline_delay = (deadline: number, now: number): number | null => {
	const remaining = deadline - now;
	if (!(remaining > 0)) return null;
	return Math.min(remaining, CREDENTIAL_DEADLINE_TIMER_CAP_MS);
};

/**
 * Call `on_expire` once `deadline` has passed, waiting in timers of at most
 * `CREDENTIAL_DEADLINE_TIMER_CAP_MS`, each re-reading the clock against the
 * absolute deadline — so a session's 30 days (past `setTimeout`'s ceiling)
 * does not fire at once. Each wake-up also checks the same deadline on the
 * wall clock, so a host suspend, which stops the monotonic clock, delays the
 * close by at most one timer after the resume (module doc).
 *
 * A `null` deadline schedules nothing. The returned function cancels the wait
 * and is safe to call more than once, before or after it fires.
 *
 * @param deadline - the monotonic deadline (`ResolvedAuth.credential_deadline`)
 * @param on_expire - run once, when the deadline passes
 * @returns a cancel function
 */
export const schedule_credential_deadline = (
	deadline: number | null,
	on_expire: () => void
): (() => void) => {
	if (deadline === null) return () => {};
	// the same deadline on the wall clock, which a suspend does not stop
	const wall_deadline = Date.now() + (deadline - performance.now());
	let timer: ReturnType<typeof setTimeout> | null = null;
	let cancelled = false;
	const step = (): void => {
		timer = null;
		if (cancelled) return;
		const delay = next_credential_deadline_delay(deadline, performance.now());
		if (delay === null || Date.now() >= wall_deadline) {
			cancelled = true;
			on_expire();
			return;
		}
		timer = setTimeout(step, delay);
		// a pending deadline never holds the process open on its own
		if (typeof timer === 'object' && 'unref' in timer) timer.unref();
	};
	step();
	return () => {
		cancelled = true;
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};
};
