/**
 * The bootstrap rate limit on the wire, probed in a backend's pre-bootstrap
 * window.
 *
 * Bootstrap is one-shot per backend, so the probe runs as the
 * `cross_backend_security` project's `before_bootstrap` hook, on both spines,
 * whose limiters that project enables: it sends wrong tokens from a forwarded
 * client address of its own until the per-IP budget is spent, and records the
 * refusal that follows — status, whole body, `Retry-After`. The project trusts
 * the loopback proxy, so the bucket is the forwarded address's, and the keeper
 * bootstrap that follows, from the harness's own address, is not throttled.
 * `bootstrap_rate_limit.cross.test.ts` asserts what was recorded.
 *
 * @module
 */

import type { BackendConfig } from '#lib/testing/cross_backend/backend_config.ts';
import { create_fetch_transport } from '#lib/testing/transports/fetch_transport.ts';

/**
 * The forwarded client address the probe spends its budget from — RFC 5737
 * TEST-NET-1, used by no other cross test, so no other case shares its bucket.
 */
export const BOOTSTRAP_RATE_LIMIT_PROBE_IP = '192.0.2.77';

/** The most wrong-token attempts the probe sends before it gives up on a 429. */
const PROBE_ATTEMPTS_MAX = 50;

/** What the probe recorded on one backend. */
export interface BootstrapRateLimitProbe {
	/** How many wrong tokens were refused `401` before the `429`. */
	readonly refused_before: number;
	readonly status: number;
	/** The parsed body, `null` for a body that is no JSON. */
	readonly body: unknown;
	/** The `Retry-After` header, `null` when absent. */
	readonly retry_after: string | null;
}

/**
 * Spend the bootstrap budget of `BOOTSTRAP_RATE_LIMIT_PROBE_IP` with wrong
 * tokens and record the refusal past it.
 *
 * @param config - the backend's config
 * @returns the refusal past the budget
 * @throws Error when a wrong token is answered other than `401` or `429`, or no `429` comes within `PROBE_ATTEMPTS_MAX` attempts
 */
export const probe_bootstrap_rate_limit = async (
	config: BackendConfig
): Promise<BootstrapRateLimitProbe> => {
	const transport = create_fetch_transport({ base_url: config.base_url });
	const { username, password } = config.bootstrap;
	for (let refused_before = 0; refused_before < PROBE_ATTEMPTS_MAX; refused_before++) {
		const response = await transport(config.bootstrap_path, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Forwarded-For': BOOTSTRAP_RATE_LIMIT_PROBE_IP
			},
			body: JSON.stringify({ token: 'not-the-bootstrap-token-0123456789', username, password })
		});
		const body: unknown = await response.json().catch(() => null);
		if (
			response.status === 401 &&
			JSON.stringify(body) === JSON.stringify({ error: 'invalid_token' })
		) {
			continue;
		}
		if (response.status !== 429) {
			throw new Error(
				`${config.name}: a wrong bootstrap token answered ${response.status} ${JSON.stringify(body)}, expected 401 or 429`
			);
		}
		return {
			refused_before,
			status: response.status,
			body,
			retry_after: response.headers.get('retry-after')
		};
	}
	throw new Error(
		`${config.name}: no 429 after ${PROBE_ATTEMPTS_MAX} wrong bootstrap tokens — is the bootstrap limiter on?`
	);
};
