import '../../assert_dev_env.js';

import {Benchmark} from '@fuzdev/fuz_util/benchmark.js';
import type {BenchmarkConfig, BenchmarkResult} from '@fuzdev/fuz_util/benchmark_types.js';

import type {BootstrappedBackendHandle} from '../setup.js';
import type {BenchScenario, BenchScenarioContext} from './scenario.js';

/**
 * Drive identical wire scenarios across several spawned backends and time each
 * round trip, so a TS impl and a Rust impl can be compared apples-to-apples
 * (both cross-process over real HTTP). The reusable cross-impl measurement
 * primitive.
 *
 * fuz_util's benchmark library is the engine — `Benchmark` runs each scenario
 * as a task and `BenchmarkResult.stats` carries the percentiles; this module
 * is the thin scenario→task→tagged-result adapter. Reporting (markdown,
 * TS-vs-Rust verdict, JSON artifact) lives in `bench_report.ts`.
 *
 * @module
 */

/** One backend × one scenario, with its timing result. */
export interface CrossImplBenchEntry {
	readonly backend: string;
	readonly scenario: string;
	readonly result: BenchmarkResult;
}

/** Full sweep across the supplied backends and scenarios. */
export interface CrossImplBenchResult {
	/** Backend names, in the order they were run. */
	readonly backends: ReadonlyArray<string>;
	/** Scenario names that ran on at least one backend. */
	readonly scenarios: ReadonlyArray<string>;
	readonly entries: ReadonlyArray<CrossImplBenchEntry>;
}

export interface RunCrossImplBenchOptions {
	/**
	 * Already-bootstrapped backends to benchmark. Each one's `keeper_transport`
	 * is the pre-authed transport scenarios fire against — bootstrap once, then
	 * hammer; no per-iteration reset.
	 */
	readonly handles: ReadonlyArray<BootstrappedBackendHandle>;
	readonly scenarios: ReadonlyArray<BenchScenario>;
	/** Overrides merged over the network-tuned defaults below. */
	readonly config?: Partial<BenchmarkConfig>;
}

/**
 * Network-tuned defaults — fuz_util's micro-benchmark defaults (warmup 10,
 * min 30, duration 1000ms) are sized for sub-microsecond functions. RPC round
 * trips are millisecond-scale and IO-bound, so warm the connection more and
 * collect a higher sample floor for stable tail percentiles.
 */
const DEFAULT_BENCH_CONFIG: BenchmarkConfig = {
	warmup_iterations: 20,
	min_iterations: 100,
	duration_ms: 3000,
	cooldown_ms: 100,
};

export const run_cross_impl_bench = async (
	options: RunCrossImplBenchOptions,
): Promise<CrossImplBenchResult> => {
	const config: BenchmarkConfig = {...DEFAULT_BENCH_CONFIG, ...options.config};
	const entries: Array<CrossImplBenchEntry> = [];

	for (const handle of options.handles) {
		const ctx: BenchScenarioContext = {
			transport: handle.keeper_transport,
			rpc_path: handle.config.rpc_path,
			capabilities: handle.config.capabilities,
		};
		for (const scenario of options.scenarios) {
			if (scenario.requires && !scenario.requires(handle.config.capabilities)) continue;
			// One task per Benchmark, named by the backend so the report tables
			// read as backend rows under a per-scenario heading.
			const bench = new Benchmark(config);
			bench.add({name: handle.config.name, fn: () => scenario.run(ctx), async: true});
			const [result] = await bench.run();
			entries.push({backend: handle.config.name, scenario: scenario.name, result: result!});
		}
	}

	const backends = options.handles.map((h) => h.config.name);
	const scenarios = [...new Set(entries.map((e) => e.scenario))];
	return {backends, scenarios, entries};
};
