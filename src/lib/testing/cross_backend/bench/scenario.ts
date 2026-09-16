import '../../assert_dev_env.ts';

import { rpc_call } from '../../rpc_helpers.ts';
import type { FetchTransport } from '../../transports/fetch_transport.ts';
import type { BackendCapabilities } from '../capabilities.ts';

/**
 * Context handed to a `BenchScenario.run`. Carries a ready, pre-authed
 * transport (the bootstrapped keeper's, by default) plus the resolved RPC
 * path and the backend's declared capabilities. A scenario fires one round
 * trip (or a small fixed *idempotent* sequence) against it — no per-call
 * `_testing_reset`, which is the correctness-test model and would dominate
 * the timing.
 *
 * @module
 */
export interface BenchScenarioContext {
	/** Pre-authed transport — the bootstrapped keeper's session cookie jar. */
	readonly transport: FetchTransport;
	/** RPC endpoint path, e.g. `'/api/rpc'`. */
	readonly rpc_path: string;
	/** Declared capabilities of the backend this context targets. */
	readonly capabilities: BackendCapabilities;
}

/**
 * One benchmarkable wire scenario. The `run` body is the `Benchmark` task fn:
 * it must `throw` on a non-success response so the benchmark records a failed
 * iteration rather than timing an error path as if it succeeded.
 *
 * Scenarios should be **idempotent** — they run thousands of times against a
 * single bootstrapped backend with no reset between iterations. Prefer reads;
 * a mutating scenario must not accumulate unbounded state.
 */
export interface BenchScenario {
	/** Scenario name (groups the per-backend results in the report). */
	readonly name: string;
	/**
	 * Optional capability gate — return `false` to skip this scenario on a
	 * backend that can't serve it (e.g. a WS scenario needs `capabilities.ws`).
	 */
	readonly requires?: (capabilities: BackendCapabilities) => boolean;
	/** The timed body. Throws on a non-success response. */
	readonly run: (ctx: BenchScenarioContext) => Promise<void>;
}

/** Fire one authed JSON-RPC call; throw on a non-success envelope. */
const rpc_scenario =
	(method: string, params?: unknown) =>
	async (ctx: BenchScenarioContext): Promise<void> => {
		const result = await rpc_call({ app: ctx.transport, path: ctx.rpc_path, method, params });
		if (!result.ok) {
			throw new Error(
				`bench scenario '${method}' failed: ${result.error.code} ${result.error.message}`
			);
		}
	};

/**
 * Starter cross-impl scenarios — all on the standard spine surface, so they
 * run on every backend (TS Hono, Rust spine), and all reads, so they're safe
 * to repeat against one bootstrapped keeper without state accumulation.
 *
 * - `account_verify` — the dispatch + auth-resolve floor (no real query work).
 * - `account_session_list` — an authed DB read.
 * - `audit_log_list` — an admin paginated read (the keeper holds `ROLE_ADMIN`).
 *
 * `login` is deliberately omitted: the cross-process test binaries wire a
 * fast `TestingArgon2idHasher`, so a login scenario would measure dispatch
 * rather than real Argon2 cost — misleading without its own clearly-labeled
 * tier.
 */
export const default_bench_scenarios: ReadonlyArray<BenchScenario> = [
	{ name: 'account_verify', run: rpc_scenario('account_verify') },
	{ name: 'account_session_list', run: rpc_scenario('account_session_list') },
	{ name: 'audit_log_list', run: rpc_scenario('audit_log_list', { limit: 20 }) }
];
