/**
 * In-memory sliding window rate limiter.
 *
 * Tracks failed attempts per key (typically IP address) using a sliding
 * time window. No external dependencies — state resets on server restart.
 *
 * **Reserve, then settle.** A handler that checks the limiter, awaits work,
 * and records afterwards lets every request of a concurrent burst pass the
 * check before any of them records — a burst of any size gets through.
 * `RateLimiter.try_reserve` closes that: it admits a request and counts it in
 * flight in one synchronous step, and the attempt counts against the cap
 * until its `RateLimitReservation` is settled — `record` keeps it as an
 * attempt, `release` gives it back. Every handler whose outcome decides
 * whether the attempt counts reserves, and releases in a `finally` so an
 * early return or a throw never leaks an in-flight slot; `check` + `record`
 * stays for callers that record in the same synchronous step they check.
 *
 * **Attempts count while in flight, whatever their outcome** — so a burst of
 * *correct* concurrent attempts from one key is capped too. The password
 * surfaces therefore reserve with `RateLimiter.reserve`, which waits up to
 * `RESERVATION_WAIT_MAX_MS` for a slot when the cap is reached only by
 * attempts in flight, and refuses at once when it is reached by recorded ones.
 *
 * @module
 */

import type { Context } from 'hono';
import { LruMap } from '@fuzdev/fuz_util/lru_map.ts';

import { ERROR_RATE_LIMIT_EXCEEDED } from './http/error_schemas.ts';

/**
 * Default tracked-key cap: bounds worst-case memory under key-enumeration
 * attacks (an attacker rotating source IPs cannot grow the backing map
 * indefinitely between cleanup ticks). Tuned to comfortably fit real
 * traffic for a single-instance deployment while capping memory at a few
 * MB in the worst case.
 */
export const DEFAULT_RATE_LIMITER_MAX_KEYS = 100_000;

/**
 * Configuration for a rate limiter instance.
 */
export interface RateLimiterOptions {
	/** Maximum allowed attempts within the window. */
	max_attempts: number;
	/** Sliding window duration in milliseconds. */
	window_ms: number;
	/** Interval for pruning stale entries (0 disables the timer). */
	cleanup_interval_ms: number;
	/**
	 * Maximum tracked keys. When exceeded, the least-recently-used key is
	 * evicted — bounds memory under key-enumeration attacks. Default:
	 * `DEFAULT_RATE_LIMITER_MAX_KEYS` (100_000). Pass `null` to disable the
	 * cap (falls back to an unbounded `Map` — only recommended when the key
	 * set is known to be closed, e.g. a per-account limiter keyed to a
	 * bounded-size account table).
	 *
	 * LRU trade-off: every `check` / `record` call marks the key as
	 * most-recently-used, so keys under active attack stay fresh and won't
	 * be evicted. A slow-burn attacker spread across many low-volume keys
	 * can, however, drop out of the table and reset their budget — set
	 * `max_keys` high enough to fit the expected legitimate key set and
	 * this stays theoretical.
	 */
	max_keys?: number | null;
}

/**
 * Default options for per-IP auth rate limiting: 5 attempts per 15 minutes.
 * The default for each of the three per-surface IP limiters (login + password
 * change, signup, bootstrap) and the shared cap the Rust spine's
 * `DEFAULT_LOGIN_IP_RATE_LIMIT` pins.
 *
 * Deliberately **not** widened when the buckets became monotone (a success no
 * longer refunds them — see `RateLimiter.reset`). Widening would have bought
 * NAT'd egress headroom by loosening the one bound that caps credential
 * guessing from a single address; splitting one shared bucket into three
 * per-surface ones buys the same headroom without touching that bound.
 */
export const default_login_ip_rate_limit: RateLimiterOptions = {
	max_attempts: 5,
	window_ms: 15 * 60_000,
	cleanup_interval_ms: 5 * 60_000,
	max_keys: DEFAULT_RATE_LIMITER_MAX_KEYS
};

/** Default options for per-account login rate limiting: 10 attempts per 30 minutes. */
export const default_login_account_rate_limit: RateLimiterOptions = {
	max_attempts: 10,
	window_ms: 30 * 60_000,
	cleanup_interval_ms: 5 * 60_000,
	max_keys: DEFAULT_RATE_LIMITER_MAX_KEYS
};

/**
 * Default options for per-IP action-dispatcher rate limiting: 600 attempts
 * per 15 minutes. Shared by the HTTP RPC and WebSocket action dispatchers
 * (one budget per action, not per transport). Permissive — catches runaway
 * scripts and egregious oracle probes, but well above human or normal
 * automation pace. Tighten downstream for stricter deployments.
 */
export const default_action_ip_rate_limit: RateLimiterOptions = {
	max_attempts: 600,
	window_ms: 15 * 60_000,
	cleanup_interval_ms: 5 * 60_000,
	max_keys: DEFAULT_RATE_LIMITER_MAX_KEYS
};

/**
 * Default options for per-account action-dispatcher rate limiting: 1200
 * attempts per 15 minutes. Shared by the HTTP RPC and WebSocket action
 * dispatchers. Permissive — sustained ~80/min is well above any human
 * admin workflow; an oracle probing 10k addresses still finishes in
 * ~2 hours, slow enough to surface in audit. Tighten downstream.
 */
export const default_action_account_rate_limit: RateLimiterOptions = {
	max_attempts: 1200,
	window_ms: 15 * 60_000,
	cleanup_interval_ms: 5 * 60_000,
	max_keys: DEFAULT_RATE_LIMITER_MAX_KEYS
};

/**
 * Whether a server builds the rate limiters it is not handed —
 * `AppServerOptions.rate_limiters`.
 *
 * - `'enforced'` — every limiter left out of the options is a default
 *   instance. The only mode a production server uses, and the default.
 * - `'disabled_for_testing'` — every limiter left out is `null`, so nothing
 *   is throttled. For in-process test apps and test binaries: they drive many
 *   round-trips from one address, and the IP buckets are monotone within their
 *   window (a success never refunds them, see `RateLimiter.reset`), so a
 *   suite's failures pile up until every later call is refused.
 *
 * A limiter passed explicitly — an instance or `null` — wins over the mode
 * either way, so a rate-limit test enables just the limiter it pins. The
 * disabled mode is loud: `create_app_server` adds a surface warning, which
 * `log_startup_summary` logs at assembly, and the first limiter it leaves
 * `null` prints `RATE_LIMITERS_DISABLED_BANNER` to stderr once per module instance.
 *
 * Twin of the Rust spine's `fuz_auth::RateLimiterMode` (`Enforced` /
 * `DisabledForTesting`).
 */
export type RateLimiterMode = 'enforced' | 'disabled_for_testing';

/**
 * The stderr line a process prints the first time `'disabled_for_testing'`
 * leaves a limiter `null` — the same text as the Rust spine's.
 */
export const RATE_LIMITERS_DISABLED_BANNER =
	'!!! RATE LIMITERS DISABLED — test-only mode. A production server must never print this.';

let rate_limiters_disabled_announced = false;

/**
 * Print `RATE_LIMITERS_DISABLED_BANNER` with `console.error`, once per module instance.
 *
 * Deliberately on stderr as well as the surface warning, which goes through
 * the server's logger: a deployment that reached this mode is unprotected on
 * every password-bearing route, and that must show in its first lines of
 * output even with the logger silenced. Once per module instance, so a module
 * instance that assembles many in-process servers prints it once, while every spawned test
 * binary prints it at startup — the twin of the Rust spine's
 * `RateLimiterMode::limiter`.
 */
export const announce_rate_limiters_disabled = (): void => {
	if (rate_limiters_disabled_announced) return;
	rate_limiters_disabled_announced = true;
	console.error(RATE_LIMITERS_DISABLED_BANNER);
};

/**
 * `retry_after` reported while a key is at its cap only because of attempts
 * still in flight. Those settle within a request's lifetime, so the earliest
 * moment worth retrying is the next second, not the oldest recorded attempt's
 * expiry. Mirrors the Rust spine's `IN_FLIGHT_RETRY_AFTER_SECONDS`.
 */
export const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

/**
 * How long a password-surface reservation (`RateLimiter.reserve`) waits for a
 * slot when the key is at its cap only because of attempts still in flight,
 * before answering `429`. Mirrors the Rust spine's `RESERVATION_WAIT_MAX`.
 *
 * Counting attempts while they are in flight caps *successful* concurrent
 * attempts from one key too — a class behind one NAT logging in together.
 * Those attempts settle within a request's lifetime, so a short wait turns
 * most of those refusals into a late success, while a key at its cap on
 * *recorded* attempts is still refused at once.
 */
export const RESERVATION_WAIT_MAX_MS = 5_000;

/**
 * Result of a rate limit check or record operation.
 */
export interface RateLimitResult {
	/** Whether the request is allowed. */
	allowed: boolean;
	/** Remaining attempts before blocking, counting attempts still in flight. */
	remaining: number;
	/** Seconds until the oldest active attempt expires (0 if allowed). */
	retry_after: number;
}

/**
 * An attempt admitted by `RateLimiter.try_reserve` or `RateLimiter.reserve`,
 * counted against the key's cap until settled.
 *
 * Settle it exactly once: `record` keeps it as an attempt (a failure, on the
 * failure-counting surfaces), `release` gives it back. Both are idempotent and
 * the first call wins, so a handler calls `record` where the outcome is known
 * and `release` in a `finally`. When the key's entry was evicted or reset
 * meanwhile, `record` still records (into the key's current entry) and
 * `release` is a no-op. A reservation made against no limiter
 * (`try_reserve_optional` / `reserve_optional` with `null`) is inert.
 */
export interface RateLimitReservation {
	/**
	 * Settle as a recorded attempt.
	 *
	 * @param now - current timestamp in ms (defaults to `Date.now()`)
	 */
	record: (now?: number) => void;
	/** Settle without recording an attempt. */
	release: () => void;
}

/** Result of `RateLimiter.try_reserve` and `RateLimiter.reserve`. */
export type RateLimitReserveResult =
	{ ok: true; reservation: RateLimitReservation } | { ok: false; retry_after: number };

/** Options for `RateLimiter.reserve`. */
export interface RateLimitReserveOptions {
	/** How long to wait for a slot. Default `RESERVATION_WAIT_MAX_MS`. */
	max_wait_ms?: number;
	/** Stops the wait (a refusal, `retry_after: IN_FLIGHT_RETRY_AFTER_SECONDS`) — pass the request's signal. */
	signal?: AbortSignal;
}

/** The reservation a disabled limiter hands out: settling it does nothing. */
const INERT_RESERVATION: RateLimitReservation = Object.freeze({
	record: () => {},
	release: () => {}
});

/**
 * One key's attempts: recorded timestamps plus attempts reserved and not yet
 * settled. A reservation holds its entry by identity, so after an eviction or
 * a reset it never settles against a newer entry under the same key.
 */
interface RateLimitEntry {
	timestamps: Array<number>;
	in_flight: number;
}

/** The reservations parked on one key, and the wakers its next wake runs. */
interface RateLimitKeyWaiters {
	count: number;
	wakers: Set<() => void>;
}

/** Where a key stands against its cap. */
type RateLimitLoad =
	| { kind: 'free'; used: number }
	| { kind: 'recorded'; retry_after: number }
	| { kind: 'in_flight' };

const entry_is_idle = (entry: RateLimitEntry): boolean =>
	entry.timestamps.length === 0 && entry.in_flight === 0;

/**
 * In-memory sliding window rate limiter.
 *
 * Stores an array of timestamps per key, plus a count of attempts reserved
 * (`try_reserve`) and not yet settled. On `check`/`record`, timestamps
 * outside the window are pruned. `retry_after` reports seconds until the
 * oldest active timestamp expires.
 *
 * The backing store is an `LruMap` when `options.max_keys` is a positive
 * number (default `DEFAULT_RATE_LIMITER_MAX_KEYS`) and a plain `Map` when
 * `max_keys` is `null`. The `LruMap` path bounds memory under
 * key-enumeration attack at the cost of a slight per-op overhead and the
 * LRU trade-off described on `RateLimiterOptions.max_keys`.
 *
 * Parameters that accept `RateLimiter | null` (e.g. `login_ip_rate_limiter`,
 * `login_account_rate_limiter`) disable rate limiting when `null` is passed —
 * no checks are performed and all requests are allowed through.
 * `create_app_server` surfaces each disabled limiter as a warning diagnostic.
 */
export class RateLimiter {
	readonly options: RateLimiterOptions;

	/** Key → recorded attempt timestamps + attempts in flight. */
	readonly #attempts: Map<string, RateLimitEntry> | LruMap<string, RateLimitEntry>;

	#cleanup_timer: ReturnType<typeof setInterval> | null = null;

	/**
	 * `reserve` calls parked on a key at its in-flight cap, per key, with the
	 * wakers that key's settles, records, and resets run so each re-decides.
	 * Held apart from the attempts map, so evicting a key's entry strands none
	 * of its waiters; a key's slot is removed when its last waiter leaves. Per
	 * key, so a settle wakes only the waiters it can admit or refuse — never
	 * every waiter on the limiter.
	 */
	readonly #waiters: Map<string, RateLimitKeyWaiters> = new Map();

	constructor(options: RateLimiterOptions) {
		this.options = options;
		const max_keys =
			options.max_keys === undefined ? DEFAULT_RATE_LIMITER_MAX_KEYS : options.max_keys;
		this.#attempts = max_keys === null ? new Map() : new LruMap<string, RateLimitEntry>(max_keys);
		if (options.cleanup_interval_ms > 0) {
			this.#cleanup_timer = setInterval(() => this.cleanup(), options.cleanup_interval_ms);
			// Allow the process to exit even if the timer is still active.
			if (typeof this.#cleanup_timer === 'object' && 'unref' in this.#cleanup_timer) {
				this.#cleanup_timer.unref();
			}
		}
	}

	/** Number of tracked keys. */
	get size(): number {
		return this.#attempts.size;
	}

	/**
	 * Keys holding a parked-waiter slot right now (see `reserve`): each slot is
	 * removed with its key's last waiter. For tests pinning that a waiter
	 * leaves nothing behind; the twin of the Rust spine's test-only
	 * `waiter_keys`.
	 *
	 * @internal
	 */
	get waiter_keys(): number {
		return this.#waiters.size;
	}

	/**
	 * Custom inspect output that exposes only `options` and `size`, never the
	 * tracked keys. The key set is sensitive (usernames / IP addresses) and
	 * unbounded, so it must not leak into logs via `util.inspect` /
	 * `console.log`. The `#attempts` field is already `#private`, but this
	 * keeps the boundary explicit against `inspect(…, {showHidden: true})`
	 * and future field-visibility changes.
	 */
	[Symbol.for('nodejs.util.inspect.custom')](): { options: RateLimiterOptions; size: number } {
		return { options: this.options, size: this.size };
	}

	/**
	 * Check whether `key` is allowed without recording an attempt, counting
	 * recorded attempts and reserved ones still in flight.
	 *
	 * Prunes timestamps that fell outside the window as a side effect (and
	 * removes the key entirely when none remain and none are in flight), so
	 * the backing map stays bounded even under read-only traffic.
	 *
	 * A check followed by an awaited operation and then a `record` lets a
	 * concurrent burst past the cap; reserve with `try_reserve` instead.
	 *
	 * @param key - rate limit key (e.g. IP address)
	 * @param now - current timestamp in ms (defaults to `Date.now()`)
	 * @mutates internal map - prunes expired timestamps for `key`
	 */
	check(key: string, now: number = Date.now()): RateLimitResult {
		const load = this.#load(key, now);
		switch (load.kind) {
			case 'free':
				return { allowed: true, remaining: this.options.max_attempts - load.used, retry_after: 0 };
			case 'recorded':
				return { allowed: false, remaining: 0, retry_after: load.retry_after };
			case 'in_flight':
				return { allowed: false, remaining: 0, retry_after: IN_FLIGHT_RETRY_AFTER_SECONDS };
		}
	}

	/** Where `key` stands against the cap, pruning expired timestamps first. */
	#load(key: string, now: number): RateLimitLoad {
		const { max_attempts, window_ms } = this.options;
		const entry = this.#attempts.get(key);
		if (!entry) return { kind: 'free', used: 0 };

		const cutoff = now - window_ms;
		const active = entry.timestamps.filter((t) => t > cutoff);
		entry.timestamps = active;
		// A key with attempts in flight stays even with no live timestamp:
		// deleting it would drop the count it carries.
		if (entry_is_idle(entry)) {
			this.#attempts.delete(key);
			return { kind: 'free', used: 0 };
		}
		// At the cap on recorded attempts alone, wait for the oldest; at the
		// cap only with the in-flight attempts counted, a settle frees a slot.
		if (active.length >= max_attempts) {
			return { kind: 'recorded', retry_after: Math.ceil((active[0]! + window_ms - now) / 1000) };
		}
		const used = active.length + entry.in_flight;
		return used < max_attempts ? { kind: 'free', used } : { kind: 'in_flight' };
	}

	/**
	 * Record a failed attempt for `key` and return the updated result.
	 *
	 * @param key - rate limit key (e.g. IP address)
	 * @param now - current timestamp in ms (defaults to `Date.now()`)
	 * @mutates internal map - appends `now` to the timestamp list for `key` (after pruning expired entries)
	 */
	record(key: string, now: number = Date.now()): RateLimitResult {
		const { max_attempts, window_ms } = this.options;
		const cutoff = now - window_ms;

		let entry = this.#attempts.get(key);
		if (entry) {
			// Prune expired entries in place.
			entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
			entry.timestamps.push(now);
		} else {
			entry = { timestamps: [now], in_flight: 0 };
			this.#attempts.set(key, entry);
		}
		// A parked reservation re-decides: the key may now be at its cap on
		// recorded attempts, which refuses it at once.
		this.#wake(key);

		const timestamps = entry.timestamps;
		const count = timestamps.length + entry.in_flight;
		if (count <= max_attempts) {
			return { allowed: true, remaining: max_attempts - count, retry_after: 0 };
		}

		const oldest = timestamps[0]!;
		const retry_after = Math.ceil((oldest + window_ms - now) / 1000);
		return { allowed: false, remaining: 0, retry_after };
	}

	/**
	 * Admit an attempt for `key` and count it in flight, in one synchronous
	 * step.
	 *
	 * The attempt counts against the cap — for this request and every
	 * concurrent one — until the returned reservation is settled: recorded as
	 * an attempt, or released. So no burst of concurrent requests gets more
	 * than `max_attempts` past the limiter between them. Release in a
	 * `finally`: nothing settles a reservation for you, so one left unsettled
	 * holds its slot for the life of the process.
	 *
	 * @param key - rate limit key (e.g. IP address)
	 * @param now - current timestamp in ms (defaults to `Date.now()`)
	 * @returns the reservation, or `{ok: false, retry_after}` when recorded plus in-flight attempts already reach the cap (nothing is reserved then)
	 * @mutates internal map - increments `key`'s in-flight count, creating its entry when absent
	 */
	try_reserve(key: string, now: number = Date.now()): RateLimitReserveResult {
		const checked = this.check(key, now);
		if (!checked.allowed) return { ok: false, retry_after: checked.retry_after };
		return { ok: true, reservation: this.#admit(key) };
	}

	/**
	 * `try_reserve`, waiting up to `max_wait_ms` for a slot when the key is at
	 * its cap only because of attempts still in flight.
	 *
	 * Each settle (and record and reset) on the key wakes its waiters to
	 * re-decide — that key's only, so a settle costs nothing for waiters parked
	 * elsewhere: a freed slot is reserved; recorded attempts reaching the cap
	 * refuse at once with their real `retry_after`; reaching `max_wait_ms` (or
	 * `signal` aborting) refuses with `IN_FLIGHT_RETRY_AFTER_SECONDS`. At most
	 * `max_attempts` reservations wait on one key — one more is refused at
	 * once — so a flood can't park requests without bound. A waiter that
	 * leaves, by any path, leaves the key's waiter count as it found it. A
	 * waiter holds no place in a queue: each wake, every waiter re-decides, so
	 * one can lose every race for a freed slot until `max_wait_ms` refuses it.
	 *
	 * @param key - rate limit key (e.g. IP address)
	 * @param options - the wait bound and an abort signal
	 * @returns the reservation, or `{ok: false, retry_after}` as described (nothing is reserved then)
	 * @mutates internal map - increments `key`'s in-flight count on admission; counts the call in `key`'s waiters while it waits
	 */
	async reserve(
		key: string,
		options: RateLimitReserveOptions = {}
	): Promise<RateLimitReserveResult> {
		const { max_wait_ms = RESERVATION_WAIT_MAX_MS, signal } = options;
		const deadline = Date.now() + max_wait_ms;
		let parked = false;
		try {
			for (;;) {
				const load = this.#load(key, Date.now());
				if (load.kind === 'free') {
					this.#leave(key, parked);
					parked = false;
					return { ok: true, reservation: this.#admit(key) };
				}
				if (load.kind === 'recorded') return { ok: false, retry_after: load.retry_after };
				if (!parked) {
					let waiters = this.#waiters.get(key);
					if (waiters && waiters.count >= this.options.max_attempts) {
						return { ok: false, retry_after: IN_FLIGHT_RETRY_AFTER_SECONDS };
					}
					if (!waiters) {
						waiters = { count: 0, wakers: new Set() };
						this.#waiters.set(key, waiters);
					}
					waiters.count++;
					parked = true;
				}
				const remaining_ms = deadline - Date.now();
				if (remaining_ms <= 0 || !(await this.#wait_for_wake(key, remaining_ms, signal))) {
					return { ok: false, retry_after: IN_FLIGHT_RETRY_AFTER_SECONDS };
				}
			}
		} finally {
			this.#leave(key, parked);
		}
	}

	/** Leave `key`'s waiters, if parked there; the last one out removes the key's slot. */
	#leave(key: string, parked: boolean): void {
		if (!parked) return;
		const waiters = this.#waiters.get(key);
		if (!waiters) return;
		waiters.count--;
		if (waiters.count <= 0) this.#waiters.delete(key);
	}

	/** Resolves `true` on `key`'s next wake, `false` on timeout or abort; cleans up either way. */
	#wait_for_wake(
		key: string,
		timeout_ms: number,
		signal: AbortSignal | undefined
	): Promise<boolean> {
		return new Promise((resolve) => {
			const wakers = this.#waiters.get(key)?.wakers;
			if (signal?.aborted || !wakers) {
				resolve(false);
				return;
			}
			const done = (woke: boolean): void => {
				wakers.delete(waker);
				clearTimeout(timer);
				signal?.removeEventListener('abort', on_abort);
				resolve(woke);
			};
			const waker = (): void => done(true);
			const on_abort = (): void => done(false);
			const timer = setTimeout(() => done(false), timeout_ms);
			wakers.add(waker);
			signal?.addEventListener('abort', on_abort, { once: true });
		});
	}

	/** Run the wakers of the reservations parked on `key`. */
	#wake(key: string): void {
		const wakers = this.#waiters.get(key)?.wakers;
		if (!wakers) return;
		for (const waker of [...wakers]) waker();
	}

	/** Count one more attempt in flight on `key`, already found free. */
	#admit(key: string): RateLimitReservation {
		let entry = this.#attempts.get(key);
		if (!entry) {
			// A fresh key past `max_keys` evicts the least-recently-used entry,
			// in-flight attempts and all; their reservations settle as no-ops
			// (release) or into a fresh entry (record).
			entry = { timestamps: [], in_flight: 0 };
			this.#attempts.set(key, entry);
		}
		entry.in_flight++;
		const reserved = entry;
		let settled = false;
		const settle = (record: boolean, settle_now: number): void => {
			if (settled) return;
			settled = true;
			this.#settle(key, reserved, record, settle_now);
		};
		return {
			record: (record_now = Date.now()) => settle(true, record_now),
			release: () => settle(false, Date.now())
		};
	}

	#settle(key: string, reserved: RateLimitEntry, record: boolean, now: number): void {
		const current = this.#attempts.get(key);
		if (current !== reserved) {
			// The reserved entry is gone — evicted, or reset with nothing in
			// flight but this — so there is no in-flight count to give back. A
			// record still counts, against whatever the key holds now.
			if (record) this.record(key, now);
			else this.#wake(key);
			return;
		}
		reserved.in_flight = Math.max(0, reserved.in_flight - 1);
		if (record) {
			const cutoff = now - this.options.window_ms;
			reserved.timestamps = reserved.timestamps.filter((t) => t > cutoff);
			reserved.timestamps.push(now);
		} else if (entry_is_idle(reserved)) {
			this.#attempts.delete(key);
		}
		this.#wake(key);
	}

	/**
	 * Clear all attempts for `key`.
	 *
	 * **Account-grain keys only.** Called after a successful auth to forgive a
	 * user's own typos, which is safe because the key *is* the account being
	 * attacked — clearing it requires that account's credential and can only
	 * widen the budget against an account the caller already holds.
	 *
	 * Never call this on an **IP-aggregate** key. That bucket is the
	 * distributed-spray backstop, and success on one account must not zero the
	 * budget shared by every other account reachable from the same IP;
	 * otherwise an attacker interleaves their own logins (or, under open signup,
	 * throwaway account creations needing no credential at all) with guesses
	 * against arbitrary victims and sprays indefinitely from one address.
	 * The only success that records on an IP bucket is an open signup (charged
	 * like a failure); no success clears one, so with no reset each is a
	 * monotone-within-window counter that only time clears.
	 *
	 * Because they are monotone, the IP buckets are **one instance per auth
	 * surface** (`login_ip_rate_limiter`, `signup_ip_rate_limiter`,
	 * `bootstrap_ip_rate_limiter`) rather than one shared across all of them.
	 * A single instance meant a failure on any surface spent the budget that
	 * bounds guessing on every other one, and one caller's exhaustion denied
	 * four routes at once — a cost that used to be masked by the reset this
	 * doc forbids.
	 *
	 * Attempts still in flight on `key` (reserved by concurrent requests) are
	 * kept: a reset forgives what was recorded, not what is still running.
	 *
	 * @mutates internal map - removes the entry for `key`, or clears its timestamps while attempts are in flight
	 */
	reset(key: string): void {
		const entry = this.#attempts.get(key);
		if (entry && entry.in_flight > 0) {
			entry.timestamps = [];
		} else {
			this.#attempts.delete(key);
		}
		this.#wake(key);
	}

	/**
	 * Remove entries whose timestamps are all outside the window and that
	 * have no attempt in flight.
	 *
	 * @param now - current timestamp in ms (defaults to `Date.now()`)
	 * @mutates internal map - prunes expired timestamps and deletes empty keys
	 */
	cleanup(now: number = Date.now()): void {
		const cutoff = now - this.options.window_ms;
		// Snapshot before mutating: `LruMap.set()` on an existing key moves it
		// to the MRU end during iteration and causes re-visit in the same pass.
		// The `Map` path is unaffected but the snapshot is cheap on both.
		const entries = [...this.#attempts];
		for (const [key, entry] of entries) {
			entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
			if (entry_is_idle(entry)) {
				this.#attempts.delete(key);
			}
		}
	}

	/**
	 * Stop the cleanup timer. Safe to call multiple times.
	 *
	 * @mutates timer - clears the cleanup `setInterval` and nulls the handle
	 */
	dispose(): void {
		if (this.#cleanup_timer !== null) {
			clearInterval(this.#cleanup_timer);
			this.#cleanup_timer = null;
		}
	}
}

/**
 * `RateLimiter.try_reserve` against a limiter that may be absent.
 *
 * An inert reservation when `limiter` is `null` (disabled) or `key` is `null`
 * (no resolvable key — e.g. no client IP), so a handler reserves and settles
 * the same way whether or not the surface is limited. Twin of the Rust
 * spine's `try_reserve_optional`.
 *
 * @param limiter - the limiter, or `null` when disabled
 * @param key - rate limit key, or `null` to skip
 * @param now - current timestamp in ms (defaults to `Date.now()`)
 */
export const try_reserve_optional = (
	limiter: RateLimiter | null,
	key: string | null,
	now: number = Date.now()
): RateLimitReserveResult => {
	if (!limiter || key === null) return { ok: true, reservation: INERT_RESERVATION };
	return limiter.try_reserve(key, now);
};

/**
 * `RateLimiter.reserve` against a limiter that may be absent — an inert
 * reservation when `limiter` or `key` is `null`. Twin of the Rust spine's
 * `reserve_optional`.
 *
 * @param limiter - the limiter, or `null` when disabled
 * @param key - rate limit key, or `null` to skip
 * @param options - the wait bound and an abort signal
 */
export const reserve_optional = async (
	limiter: RateLimiter | null,
	key: string | null,
	options?: RateLimitReserveOptions
): Promise<RateLimitReserveResult> => {
	if (!limiter || key === null) return { ok: true, reservation: INERT_RESERVATION };
	return limiter.reserve(key, options);
};

/**
 * Create a `RateLimiter` with sensible defaults for per-IP login protection.
 *
 * @param options - override individual options; unset fields use `default_login_ip_rate_limit`
 */
export const create_rate_limiter = (options?: Partial<RateLimiterOptions>): RateLimiter => {
	return new RateLimiter({ ...default_login_ip_rate_limit, ...options });
};

/**
 * Build a 429 rate-limit-exceeded JSON response with `Retry-After` header.
 *
 * @param c - Hono context
 * @param retry_after - seconds until the client should retry
 * @returns a 429 Response
 */
export const rate_limit_exceeded_response = (c: Context, retry_after: number): Response =>
	c.json(
		{ error: ERROR_RATE_LIMIT_EXCEEDED, retry_after },
		{ status: 429, headers: { 'Retry-After': String(Math.ceil(retry_after)) } }
	);
