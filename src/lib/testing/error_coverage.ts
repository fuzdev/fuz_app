import './assert_dev_env.ts';

/**
 * Error reachability coverage tracking.
 *
 * Tracks which declared error codes are actually exercised in tests.
 * `ErrorCoverageCollector` records status codes (optionally with body
 * `error` codes) observed during test runs, then `assert_error_coverage`
 * compares against each route's error map (`resolve_route_errors`) to find
 * uncovered error paths — one per declared code at each status, read from
 * the map's definitions.
 *
 * @module
 */

import { assert } from 'vitest';

import type { RouteSpec } from '../http/route_spec.ts';
import { get_route_errors, type RouteErrors } from '../http/schema_helpers.ts';
import { find_route_spec, assert_response_matches_spec } from './integration_helpers.ts';

/** Uncovered entry — a declared code at a status of a route, never observed. */
export interface UncoveredEntry {
	method: string;
	path: string;
	status: number;
	/** The declared code missing. */
	code: string;
}

/** Options controlling which routes/statuses are considered for coverage. */
export interface CoverageFilterOptions {
	/** Routes to skip, in `'METHOD /path'` format. */
	ignore_routes?: Array<string>;
	/** HTTP status codes to skip. */
	ignore_statuses?: Array<number>;
}

/** Internal coverage entry yielded by the shared walk. */
interface CoverageEntry {
	method: string;
	path: string;
	status: number;
	code: string;
	covered: boolean;
}

/**
 * Shared walk over declared error paths.
 *
 * Single source of truth for the route → status → code traversal used by
 * both `uncovered()` and `assert_error_coverage`. Yields one entry per
 * declared (status, code) of each route's error map, read from its
 * definitions, with a `covered` flag, applying the "any-code" rule
 * (status-only observation covers all declared codes).
 */
const walk_coverage = (
	collector: ErrorCoverageCollector,
	route_specs: Array<RouteSpec>,
	options?: CoverageFilterOptions
): Array<CoverageEntry> => {
	const ignore_routes = new Set(options?.ignore_routes);
	const ignore_statuses = new Set(options?.ignore_statuses);
	const entries: Array<CoverageEntry> = [];
	for (const spec of route_specs) {
		const route_key = `${spec.method} ${spec.path}`;
		if (ignore_routes.has(route_key)) continue;
		// a code with two shapes at one status is one path
		const seen: Set<string> = new Set();
		for (const { status, code } of get_route_errors(collector.route_errors, spec).defs) {
			if (ignore_statuses.has(status)) continue;
			const status_key = `${spec.method} ${spec.path}:${status}`;
			const code_key = `${status_key}:${code}`;
			if (seen.has(code_key)) continue;
			seen.add(code_key);
			const covered = collector.observed.has(status_key) || collector.observed.has(code_key);
			entries.push({ method: spec.method, path: spec.path, status, code, covered });
		}
	}
	return entries;
};

/**
 * Tracks which route × status (and route × status × code) combinations have
 * been exercised in tests.
 *
 * Use `record()` to log an observed status (optionally with the body's `error`
 * code), or `assert_and_record()` to combine response validation with tracking
 * (auto-extracts `body.error` from the response when present).
 * After all tests, call `uncovered()` to find declared error paths never
 * exercised.
 *
 * An observation recorded without a code still satisfies "any-code" coverage
 * requirements for the same status — i.e., if a caller records just the status,
 * all declared codes for that status are considered covered. Per-code tracking
 * is additive: callers who know the body's `error` value should pass it to get
 * precise per-code gap reporting.
 */
export class ErrorCoverageCollector {
	/**
	 * Each route's error map, keyed `METHOD path` (`AppSurfaceSpec.route_errors`),
	 * which the declared paths and the response checks read; without one, a
	 * route's own map without middleware.
	 */
	readonly route_errors: ReadonlyMap<string, RouteErrors> | null;

	/**
	 * @param route_errors - each route's error map, keyed `METHOD path` (`AppSurfaceSpec.route_errors`)
	 */
	constructor(route_errors?: ReadonlyMap<string, RouteErrors> | null) {
		this.route_errors = route_errors ?? null;
	}

	/**
	 * Observed keys: `"METHOD /spec-path:STATUS"` or `"METHOD /spec-path:STATUS:CODE"`.
	 *
	 * Both shapes coexist — the code-less key marks the status as covered at any
	 * code; a code-bearing key adds per-code precision.
	 */
	readonly observed: Set<string> = new Set();

	/**
	 * Record an observed error status (optionally with the body's `error` code) for a route.
	 *
	 * Resolves the concrete request path back to the spec template path
	 * (e.g., `/api/accounts/abc` → `/api/accounts/:id`). When `code` is provided,
	 * it is stored alongside the status for per-code coverage tracking.
	 *
	 * @param path - request path (may be concrete)
	 * @param code - observed body `error` code, for per-code coverage
	 * @mutates `this.observed` - adds the resolved `"METHOD /spec-path:STATUS"`
	 *   key (and the `:CODE` variant when `code` is provided).
	 */
	record(
		route_specs: Array<RouteSpec>,
		method: string,
		path: string,
		status: number,
		code?: string
	): void {
		const spec = find_route_spec(route_specs, method, path);
		const spec_path = spec ? spec.path : path;
		const base_key = `${method} ${spec_path}:${status}`;
		this.observed.add(base_key);
		if (code !== undefined) {
			this.observed.add(`${base_key}:${code}`);
		}
	}

	/**
	 * Validate a response against its route spec and record the status.
	 *
	 * Wraps `assert_response_matches_spec` and records the status code. For
	 * error responses, auto-extracts `body.error` from the JSON body (via a
	 * cloned response, so the original stream stays usable) and records it
	 * for per-code coverage. Pass an explicit `code` to override the
	 * auto-extracted value or when the body was already consumed.
	 *
	 * @param code - observed body `error` code (override; if omitted and the
	 *   response body is a JSON object with a string `error` field, that value
	 *   is auto-extracted)
	 * @mutates `this.observed` - via `record` after `assert_response_matches_spec`
	 *   succeeds.
	 * @throws Error if the response body fails the route spec's declared
	 *   schemas (propagated from `assert_response_matches_spec`).
	 */
	async assert_and_record(
		route_specs: Array<RouteSpec>,
		method: string,
		path: string,
		response: Response,
		code?: string
	): Promise<void> {
		await assert_response_matches_spec(route_specs, method, path, response, this.route_errors);
		let resolved_code = code;
		if (resolved_code === undefined && !response.ok && !response.bodyUsed) {
			try {
				const body = await response.clone().json();
				if (body && typeof (body as { error?: unknown }).error === 'string') {
					resolved_code = (body as { error: string }).error;
				}
			} catch {
				// non-JSON body — no code to extract
			}
		}
		this.record(route_specs, method, path, response.status, resolved_code);
	}

	/**
	 * Find declared error paths that were never observed.
	 *
	 * Computes the declared set from each route's error map
	 * (`resolve_route_errors`, `this.route_errors`): one row per declared code
	 * at each status. A status-only observation (no code) satisfies all
	 * declared codes for that status — the "any-code" rule.
	 */
	uncovered(route_specs: Array<RouteSpec>, options?: CoverageFilterOptions): Array<UncoveredEntry> {
		return walk_coverage(this, route_specs, options)
			.filter((entry) => !entry.covered)
			.map(({ method, path, status, code }) => ({ method, path, status, code }));
	}
}

/**
 * Default minimum error coverage threshold for the standard integration
 * and admin test suites. Conservative — not all error paths are exercisable
 * in the composable suites. Consumers should increase as their test suites mature.
 */
export const DEFAULT_INTEGRATION_ERROR_COVERAGE = 0.2;

/** Options for `assert_error_coverage`. */
export interface ErrorCoverageOptions extends CoverageFilterOptions {
	/** Minimum coverage ratio (0–1). Default `0` (informational only). */
	min_coverage?: number;
}

/**
 * Format an uncovered entry for human-readable log output.
 *
 * Uses `status (code)` — spaces around the code make `:` unambiguous as
 * the route_key / status separator.
 */
const format_uncovered = (
	entry: Pick<CoverageEntry, 'method' | 'path' | 'status' | 'code'>
): string => `${entry.method} ${entry.path} → ${entry.status} (${entry.code})`;

/**
 * Assert error coverage meets a minimum threshold.
 *
 * Computes the ratio of exercised error paths to total declared error paths,
 * each declared code at each status of a route's error map
 * (`collector.route_errors`) one path. A status-only observation covers all
 * declared codes for that status (the "any-code" rule).
 *
 * When `min_coverage` is 0 (default), logs coverage info without failing.
 * When > 0, fails if coverage is below the threshold.
 *
 * @throws AssertionError if `min_coverage > 0` and the covered/total ratio
 *   falls below the threshold — the failure message lists every uncovered
 *   route + status (+ code).
 */
export const assert_error_coverage = (
	collector: ErrorCoverageCollector,
	route_specs: Array<RouteSpec>,
	options?: ErrorCoverageOptions
): void => {
	const min_coverage = options?.min_coverage ?? 0;
	const entries = walk_coverage(collector, route_specs, options);
	const total = entries.length;
	const uncovered_entries = entries.filter((e) => !e.covered);
	const covered = total - uncovered_entries.length;
	const uncovered_lines = uncovered_entries.map(format_uncovered);

	const ratio = total > 0 ? covered / total : 1;
	console.log(
		`[error coverage] ${covered}/${total} (${(ratio * 100).toFixed(1)}%)` +
			(uncovered_lines.length > 0 ? `\n  uncovered:\n    ${uncovered_lines.join('\n    ')}` : '')
	);

	if (min_coverage > 0) {
		assert.ok(
			ratio >= min_coverage,
			`Error coverage ${(ratio * 100).toFixed(1)}% below threshold ${(min_coverage * 100).toFixed(
				1
			)}%` + `\n  uncovered:\n    ${uncovered_lines.join('\n    ')}`
		);
	}
};
