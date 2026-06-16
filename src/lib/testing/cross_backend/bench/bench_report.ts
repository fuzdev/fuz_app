import '../../assert_dev_env.ts';

import {benchmark_format_markdown} from '@fuzdev/fuz_util/benchmark_format.ts';
import {
	benchmark_stats_compare,
	type BenchmarkComparison,
} from '@fuzdev/fuz_util/benchmark_stats.ts';

import type {CrossImplBenchResult} from './run_cross_impl_bench.ts';

/**
 * Reporting adapters over a `CrossImplBenchResult` — all built on fuz_util's
 * formatters + Welch comparison. Markdown for human eyeballs, a per-scenario
 * TS-vs-reference significance verdict, and a self-describing JSON artifact.
 *
 * @module
 */

/** Per-scenario markdown table (one row per backend), each under an `###` heading. */
export const format_cross_impl_markdown = (result: CrossImplBenchResult): string =>
	result.scenarios
		.map((scenario) => {
			const results = result.entries.filter((e) => e.scenario === scenario).map((e) => e.result);
			return `### ${scenario}\n\n${benchmark_format_markdown(results)}`;
		})
		.join('\n\n');

/** One backend's result compared against the reference backend, per scenario. */
export interface CrossImplComparisonEntry {
	readonly scenario: string;
	/** The reference backend (`a` side of the comparison). */
	readonly reference: string;
	/** The compared backend (`b` side). */
	readonly backend: string;
	readonly comparison: BenchmarkComparison;
}

export interface CompareCrossImplOptions {
	/** Backend to compare every other backend against. Defaults to `result.backends[0]`. */
	readonly reference?: string;
}

/**
 * Welch-test verdict for every non-reference backend vs the reference, per
 * scenario. With deno + node + rust and `reference: 'deno'` you get
 * `node vs deno` and `rust vs deno` for each scenario.
 */
export const compare_cross_impl = (
	result: CrossImplBenchResult,
	options?: CompareCrossImplOptions,
): Array<CrossImplComparisonEntry> => {
	const reference = options?.reference ?? result.backends[0];
	if (reference === undefined) return [];
	const out: Array<CrossImplComparisonEntry> = [];
	for (const scenario of result.scenarios) {
		const ref_entry = result.entries.find(
			(e) => e.scenario === scenario && e.backend === reference,
		);
		if (!ref_entry) continue;
		for (const e of result.entries) {
			if (e.scenario !== scenario || e.backend === reference) continue;
			out.push({
				scenario,
				reference,
				backend: e.backend,
				comparison: benchmark_stats_compare(ref_entry.result.stats, e.result.stats),
			});
		}
	}
	return out;
};

/**
 * Render the comparison entries as one line each. The prefix lists the
 * reference first to match `benchmark_stats_compare`'s "First" (= the `a`
 * arg = reference) / "Second" (= the `b` arg = backend) in the
 * recommendation text — `compare_cross_impl` passes `(reference, backend)`.
 */
export const format_cross_impl_comparison = (
	entries: ReadonlyArray<CrossImplComparisonEntry>,
): string =>
	entries
		.map((e) => `${e.scenario}: ${e.reference} vs ${e.backend} — ${e.comparison.recommendation}`)
		.join('\n');

/**
 * Self-describing JSON artifact: one entry per backend × scenario with the
 * percentiles (raw-sample tail), the resolved budget, and iteration count.
 * Diffable and reviewable without a TS runtime; the seed for the deferred
 * static-docs comparison surface.
 */
export const format_cross_impl_json = (result: CrossImplBenchResult): string =>
	JSON.stringify(
		{
			generated_at: new Date().toISOString(),
			backends: result.backends,
			scenarios: result.scenarios,
			entries: result.entries.map((e) => ({
				backend: e.backend,
				scenario: e.scenario,
				iterations: e.result.iterations,
				budget: e.result.budget,
				stats: {
					mean_ns: e.result.stats.mean_ns,
					p50_ns: e.result.stats.p50_ns,
					p90_ns: e.result.stats.p90_ns,
					p95_ns: e.result.stats.p95_ns,
					p99_ns: e.result.stats.p99_ns,
					min_ns: e.result.stats.min_ns,
					max_ns: e.result.stats.max_ns,
					std_dev_ns: e.result.stats.std_dev_ns,
					ops_per_second: e.result.stats.ops_per_second,
					outlier_ratio: e.result.stats.outlier_ratio,
					sample_size: e.result.stats.sample_size,
				},
			})),
		},
		null,
		2,
	);
