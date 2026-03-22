import './assert_dev_env.js';

/**
 * Error reachability coverage tracking.
 *
 * Tracks which declared error statuses are actually exercised in tests.
 * `ErrorCoverageCollector` records status codes observed during test runs,
 * then `assert_error_coverage` compares against declared error schemas
 * to find uncovered error paths.
 *
 * @module
 */

import {assert} from 'vitest';

import type {RouteSpec} from '../http/route_spec.js';
import {merge_error_schemas} from '../http/schema_helpers.js';
import {find_route_spec, assert_response_matches_spec} from './integration_helpers.js';

/**
 * Tracks which route × status combinations have been exercised in tests.
 *
 * Use `record()` to log an observed status, or `assert_and_record()` to
 * combine response validation with tracking. After all tests, call
 * `uncovered()` to find declared error statuses never exercised.
 */
export class ErrorCoverageCollector {
	/** Observed route × status keys: `"METHOD /spec-path:STATUS"`. */
	readonly observed: Set<string> = new Set();

	/**
	 * Record an observed error status for a route.
	 *
	 * Resolves the concrete request path back to the spec template path
	 * (e.g., `/api/accounts/abc` → `/api/accounts/:id`).
	 *
	 * @param route_specs - route specs for path resolution
	 * @param method - HTTP method
	 * @param path - request path (may be concrete)
	 * @param status - observed HTTP status code
	 */
	record(route_specs: Array<RouteSpec>, method: string, path: string, status: number): void {
		const spec = find_route_spec(route_specs, method, path);
		const spec_path = spec ? spec.path : path;
		this.observed.add(`${method} ${spec_path}:${status}`);
	}

	/**
	 * Validate a response against its route spec and record the status.
	 *
	 * Wraps `assert_response_matches_spec` and records the status code.
	 *
	 * @param route_specs - route specs for schema lookup and path resolution
	 * @param method - HTTP method
	 * @param path - request path
	 * @param response - the Response to validate and record
	 */
	async assert_and_record(
		route_specs: Array<RouteSpec>,
		method: string,
		path: string,
		response: Response,
	): Promise<void> {
		await assert_response_matches_spec(route_specs, method, path, response);
		this.record(route_specs, method, path, response.status);
	}

	/**
	 * Find declared error statuses that were never observed.
	 *
	 * Computes the declared set from `merge_error_schemas` for each route spec,
	 * then subtracts observed keys.
	 *
	 * @param route_specs - route specs to check coverage against
	 * @returns uncovered entries with method, path, and status
	 */
	uncovered(route_specs: Array<RouteSpec>): Array<{method: string; path: string; status: number}> {
		const missing: Array<{method: string; path: string; status: number}> = [];
		for (const spec of route_specs) {
			const merged = merge_error_schemas(spec);
			if (!merged) continue;
			for (const status_str of Object.keys(merged)) {
				const status = Number(status_str);
				const key = `${spec.method} ${spec.path}:${status}`;
				if (!this.observed.has(key)) {
					missing.push({method: spec.method, path: spec.path, status});
				}
			}
		}
		return missing;
	}
}

/**
 * Default minimum error coverage threshold for the standard integration
 * and admin test suites. Conservative — not all error paths are exercisable
 * in the composable suites. Consumers should increase as their test suites mature.
 */
export const DEFAULT_INTEGRATION_ERROR_COVERAGE = 0.2;

/** Options for `assert_error_coverage`. */
export interface ErrorCoverageOptions {
	/** Minimum coverage ratio (0–1). Default `0` (informational only). */
	min_coverage?: number;
	/** Routes to skip, in `'METHOD /path'` format. */
	ignore_routes?: Array<string>;
	/** HTTP status codes to skip. */
	ignore_statuses?: Array<number>;
}

/**
 * Assert error coverage meets a minimum threshold.
 *
 * Computes the ratio of exercised error statuses to total declared error
 * statuses. When `min_coverage` is 0 (default), logs coverage info without
 * failing. When > 0, fails if coverage is below the threshold.
 *
 * @param collector - the coverage collector with recorded observations
 * @param route_specs - route specs to check coverage against
 * @param options - threshold and exclusion configuration
 */
export const assert_error_coverage = (
	collector: ErrorCoverageCollector,
	route_specs: Array<RouteSpec>,
	options?: ErrorCoverageOptions,
): void => {
	const min_coverage = options?.min_coverage ?? 0;
	const ignore_routes = new Set(options?.ignore_routes);
	const ignore_statuses = new Set(options?.ignore_statuses);

	let total = 0;
	let covered = 0;
	const uncovered_entries: Array<string> = [];

	for (const spec of route_specs) {
		const route_key = `${spec.method} ${spec.path}`;
		if (ignore_routes.has(route_key)) continue;

		const merged = merge_error_schemas(spec);
		if (!merged) continue;

		for (const status_str of Object.keys(merged)) {
			const status = Number(status_str);
			if (ignore_statuses.has(status)) continue;

			total++;
			const key = `${spec.method} ${spec.path}:${status}`;
			if (collector.observed.has(key)) {
				covered++;
			} else {
				uncovered_entries.push(`${route_key} → ${status}`);
			}
		}
	}

	const ratio = total > 0 ? covered / total : 1;
	console.log(
		`[error coverage] ${covered}/${total} (${(ratio * 100).toFixed(1)}%)` +
			(uncovered_entries.length > 0
				? `\n  uncovered:\n    ${uncovered_entries.join('\n    ')}`
				: ''),
	);

	if (min_coverage > 0) {
		assert.ok(
			ratio >= min_coverage,
			`Error coverage ${(ratio * 100).toFixed(1)}% below threshold ${(min_coverage * 100).toFixed(1)}%` +
				`\n  uncovered:\n    ${uncovered_entries.join('\n    ')}`,
		);
	}
};
