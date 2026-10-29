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

import { HEALTH_PATH, HealthResponse } from '../http/health_schema.ts';

/** `probe_backend`'s answer: live, or why not. */
export type BackendProbeResult = Result<object, { error: string }>;

/** The refusal for a `2xx` whose body isn't the health reply. */
export const BACKEND_PROBE_NOT_HEALTH = 'not a health response';

/** How long the default fetch waits for the health reply before the probe reads as down. */
export const BACKEND_PROBE_TIMEOUT_MS = 10_000;

/**
 * The client's read of the health reply — loose, so a field added to the
 * route's output never reads as a dead backend. The route spec stays strict.
 */
const HealthReply = z.looseObject(HealthResponse.shape);

/**
 * Probe whether the backend is serving: its health route must answer `2xx`
 * with a body that parses as `HealthResponse`.
 *
 * @param fetch_health - fetches the health route (injectable for tests and signals); the default times out after `timeout_ms`, an injected one owns its own signal
 * @param timeout_ms - how long the default fetch waits before the probe reads as down
 * @returns `{ok: true}` when the backend answered, else the reason it didn't
 */
export const probe_backend = async (
	fetch_health: () => Promise<Response> = () =>
		fetch(HEALTH_PATH, { signal: AbortSignal.timeout(timeout_ms) }),
	timeout_ms: number = BACKEND_PROBE_TIMEOUT_MS
): Promise<BackendProbeResult> => {
	let response: Response;
	try {
		response = await fetch_health();
	} catch (err) {
		if ((err as { name?: unknown } | null)?.name === 'TimeoutError') {
			return { ok: false, error: `no reply within ${timeout_ms}ms` };
		}
		return { ok: false, error: to_error_message(err, 'network error') };
	}
	if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { ok: false, error: BACKEND_PROBE_NOT_HEALTH };
	}
	if (!HealthReply.safeParse(body).success) {
		return { ok: false, error: BACKEND_PROBE_NOT_HEALTH };
	}
	return { ok: true };
};

/** Options for `BackendProbe`. */
export interface BackendProbeOptions {
	/** Fetches the health route — defaults to `fetch(HEALTH_PATH)` with a timeout. */
	fetch_health?: () => Promise<Response>;
	/** How long the default fetch waits for the reply — defaults to `BACKEND_PROBE_TIMEOUT_MS`. */
	timeout_ms?: number;
}

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

	readonly #fetch_health: (() => Promise<Response>) | undefined;
	readonly #timeout_ms: number | undefined;
	#latest = 0;

	constructor(options?: BackendProbeOptions) {
		this.#fetch_health = options?.fetch_health;
		this.#timeout_ms = options?.timeout_ms;
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
		const result = await probe_backend(this.#fetch_health, this.#timeout_ms);
		if (id === this.#latest) {
			this.reachable = result.ok;
			this.error = result.ok ? null : result.error;
			this.probing = false;
		}
		return result.ok;
	}
}
