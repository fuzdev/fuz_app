/**
 * Backend liveness probe — whether the app's backend is serving, read from
 * its `/health` route.
 *
 * `AuthState.check_session` can't tell a backend that's down from a
 * logged-out caller, so a login gate probes `/health` to say the backend is
 * needed instead of showing a login form that can't work. Only the health
 * reply counts: a static server or an SPA fallback answering every path with
 * a `200` HTML page is not a backend, and neither is a network error.
 * Browser-safe — no server imports.
 *
 * @module
 */

import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import { z } from 'zod';
import type { Result } from '@fuzdev/fuz_util/result.ts';
import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';

import { HEALTH_PATH, HealthResponse } from '../http/health_schema.ts';

/** `probe_backend`'s answer: live, or why not. */
export type BackendProbeResult = Result<object, { error: string }>;

/** The refusal for a `2xx` whose body isn't the health reply. */
export const BACKEND_PROBE_NOT_HEALTH = 'not a health response';

/** The refusal for a probe its caller's `signal` aborted — a cancel, not a timeout. */
export const BACKEND_PROBE_ABORTED = 'aborted';

/** How long the default fetch waits for the health reply before the probe reads as down. */
export const BACKEND_PROBE_TIMEOUT_MS = 10_000;

/**
 * The client's read of the health reply — loose, so a field added to the
 * route's output never reads as a dead backend. The route spec stays strict.
 */
const HealthReply = z.looseObject(HealthResponse.shape);

/** Options for `probe_backend`; `BackendProbe` takes all but `signal`. */
export interface BackendProbeOptions {
	/**
	 * Fetches the health route — defaults to `fetch(HEALTH_PATH)` with a
	 * `timeout_ms` signal, combined with `signal` when given. An injected
	 * fetch owns its own signal.
	 */
	fetch_health?: () => Promise<Response>;
	/**
	 * How long the default fetch waits for the reply and its body — defaults
	 * to `BACKEND_PROBE_TIMEOUT_MS`; unused when `fetch_health` is injected.
	 */
	timeout_ms?: number;
	/**
	 * Cancels the default fetch, alongside its timeout; unused when
	 * `fetch_health` is injected. A probe that fails once it is aborted reports
	 * `BACKEND_PROBE_ABORTED` — whatever the signal's reason, so a deadline
	 * belongs in `timeout_ms`.
	 */
	signal?: AbortSignal;
}

const is_timeout_error = (err: unknown): boolean =>
	(err as { name?: unknown } | null)?.name === 'TimeoutError';

/**
 * Probe whether the backend is serving: its health route must answer `2xx`
 * with a body that parses as `HealthResponse`. A timeout while the reply or its
 * body is read reads as down — naming `timeout_ms` only when the default fetch
 * timed out, since an injected `fetch_health` owns its own signal. A failure
 * once the caller's `signal` aborted reports `BACKEND_PROBE_ABORTED`, not a
 * timeout or a down backend. A body that isn't JSON is
 * `BACKEND_PROBE_NOT_HEALTH`; any other failure reading it reports the error.
 *
 * @param options - the health fetch, the default fetch's timeout, and a signal to cancel it
 * @returns `{ok: true}` when the backend answered, else the reason it didn't
 */
export const probe_backend = async (options?: BackendProbeOptions): Promise<BackendProbeResult> => {
	const timeout_ms = options?.timeout_ms ?? BACKEND_PROBE_TIMEOUT_MS;
	// an injected fetch owns its own signal, so ours cancels and classifies only the default
	const signal = options?.fetch_health ? undefined : options?.signal;
	const fetch_health =
		options?.fetch_health ??
		(() => {
			const timeout = AbortSignal.timeout(timeout_ms);
			return fetch(HEALTH_PATH, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
		});
	const timed_out: BackendProbeResult = {
		ok: false,
		error: options?.fetch_health ? 'timed out' : `no reply within ${timeout_ms}ms`
	};
	let response: Response;
	try {
		response = await fetch_health();
	} catch (err) {
		if (signal?.aborted) return { ok: false, error: BACKEND_PROBE_ABORTED };
		if (is_timeout_error(err)) return timed_out;
		return { ok: false, error: to_error_message(err, 'network error') };
	}
	if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
	let body: unknown;
	try {
		body = await response.json();
	} catch (err) {
		// the fetch's signal governs the body stream too
		if (signal?.aborted) return { ok: false, error: BACKEND_PROBE_ABORTED };
		if (is_timeout_error(err)) return timed_out;
		if ((err as { name?: unknown } | null)?.name === 'SyntaxError') {
			return { ok: false, error: BACKEND_PROBE_NOT_HEALTH };
		}
		// a dropped connection mid-body, not a wrong body
		return { ok: false, error: to_error_message(err, 'network error') };
	}
	if (!HealthReply.safeParse(body).success) {
		return { ok: false, error: BACKEND_PROBE_NOT_HEALTH };
	}
	return { ok: true };
};

/**
 * Reactive `probe_backend` state for a login gate. `reachable` stays `null`
 * until a probe settles — through SSR and prerender too, so a gate that waits
 * on it renders its pending notice there.
 *
 * @example
 * ```ts
 * const backend = new BackendProbe();
 * if (BROWSER) void backend.probe();
 * // in markup: `backend.reachable === null` → checking; `!backend.reachable` → down
 * ```
 */
export class BackendProbe {
	/** Whether a probe is in flight. */
	probing: boolean = $state.raw(false);

	/** Whether the backend answered the last settled probe — `null` before one settles. */
	reachable: boolean | null = $state.raw(null);

	/** Why the last settled probe failed — `null` when it succeeded or none has settled. */
	error: string | null = $state.raw(null);

	readonly #options: OmitStrict<BackendProbeOptions, 'signal'> | undefined;
	#latest = 0;

	/**
	 * @param options - the health fetch and the default fetch's timeout; no `signal`, since one
	 *   that aborted would fail every later probe as `BACKEND_PROBE_ABORTED`
	 */
	constructor(options?: OmitStrict<BackendProbeOptions, 'signal'>) {
		// copy the two fields, so a wider options object never forwards a `signal`
		this.#options = options && {
			fetch_health: options.fetch_health,
			timeout_ms: options.timeout_ms
		};
	}

	/**
	 * Probe the backend and record the answer. A probe started while another
	 * is in flight supersedes it: only the latest one's answer is recorded.
	 *
	 * @returns whether the backend answered this probe
	 */
	async probe(): Promise<boolean> {
		const id = ++this.#latest;
		this.probing = true;
		const result = await probe_backend(this.#options);
		if (id === this.#latest) {
			this.reachable = result.ok;
			this.error = result.ok ? null : result.error;
			this.probing = false;
		}
		return result.ok;
	}
}
