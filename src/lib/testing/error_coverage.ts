import './assert_dev_env.ts';

/**
 * Error reachability coverage tracking.
 *
 * Tracks which declared error codes are actually exercised in tests.
 * `ErrorCoverageCollector` records the error responses observed during test
 * runs, each by its body's `error` code where it is known, then
 * `assert_error_coverage` compares against each route's error map
 * (`resolve_route_error_map`) to find uncovered error paths — one per declared
 * code at each status, read from the map's definitions. An observation with a
 * code covers that one path; one recorded with a `null` code covers every code
 * declared at its status.
 *
 * @module
 */

import { assert } from 'vitest';

import type { RouteSpec } from '../http/route_spec.ts';
import { format_route_key } from '../http/surface_query.ts';
import { get_route_error_map, type RouteErrorMap } from '../http/route_errors.ts';
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
 * definitions, with a `covered` flag: covered when that code was observed
 * at that status, or when the status was observed with a `null` code (the
 * "any-code" rule, for a response that carries none). Every definition
 * carries a code, so a declared status always has at least one.
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
		const route_key = format_route_key(spec);
		if (ignore_routes.has(route_key)) continue;
		// a code with two shapes at one status is one path
		const seen: Set<string> = new Set();
		for (const { status, code } of get_route_error_map(collector.route_error_maps, spec).defs) {
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
 * Use `record()` to log an observed status with the body's `error` code (`null`
 * for none), or `assert_and_record()` to combine response validation with
 * tracking (reads `body.error` from the response).
 * After all tests, call `uncovered()` to find declared error paths never
 * exercised.
 *
 * An observation with a code covers exactly that (route, status, code): a
 * `forbidden_origin` 403 leaves a declared `credential_type_required` 403
 * uncovered. An observation recorded with a `null` code — a response that
 * carries none — satisfies the "any-code" rule for its status: every code
 * declared there counts as covered.
 */
export class ErrorCoverageCollector {
	/**
	 * Each route's error map, keyed `METHOD path` (`AppSurfaceSpec.route_error_maps`),
	 * which the declared paths and the response checks read; without one, a
	 * route's own map without middleware.
	 */
	readonly route_error_maps: ReadonlyMap<string, RouteErrorMap> | null;

	/**
	 * @param route_error_maps - each route's error map, keyed `METHOD path` (`AppSurfaceSpec.route_error_maps`)
	 */
	constructor(route_error_maps?: ReadonlyMap<string, RouteErrorMap> | null) {
		this.route_error_maps = route_error_maps ?? null;
	}

	/**
	 * Observed keys: `"METHOD /spec-path:STATUS:CODE"` for an observation with a
	 * code, `"METHOD /spec-path:STATUS"` for one without, which covers every
	 * code declared at the status.
	 */
	readonly observed: Set<string> = new Set();

	/**
	 * Record an observed error status and its body's `error` code for a route.
	 *
	 * Resolves the concrete request path back to the spec template path
	 * (e.g., `/api/accounts/abc` → `/api/accounts/:id`). A `code` covers that
	 * code alone; `null`, for a response that truly carries no code, covers
	 * every code declared at the status — so any-code coverage is asked for,
	 * never had by leaving the code out.
	 *
	 * @param path - request path (may be concrete)
	 * @param code - the body's `error` code, or `null` when the response has none
	 * @mutates `this.observed` - adds `"METHOD /spec-path:STATUS:CODE"` for a
	 *   code, `"METHOD /spec-path:STATUS"` for `null`.
	 */
	record(
		route_specs: Array<RouteSpec>,
		method: string,
		path: string,
		status: number,
		code: string | null
	): void {
		const spec = find_route_spec(route_specs, method, path);
		const spec_path = spec ? spec.path : path;
		const base_key = `${method} ${spec_path}:${status}`;
		// a known code covers that code alone, so a refusal at a shared status
		// is no evidence for the others there
		this.observed.add(code === null ? base_key : `${base_key}:${code}`);
	}

	/**
	 * Validate a response against its route spec and record the status.
	 *
	 * Wraps `assert_response_matches_spec` and records the status with the
	 * body's `error` code, read from a clone so the original stream stays
	 * usable; a body with no string `error` records `null`. Pass `code` when
	 * the body was already consumed.
	 *
	 * @param code - the body's `error` code, or `null` when it has none; read
	 *   from the body when omitted
	 * @mutates `this.observed` - via `record` after `assert_response_matches_spec`
	 *   succeeds.
	 * @throws Error if the response body fails the route spec's declared
	 *   schemas (propagated from `assert_response_matches_spec`), or if the
	 *   body was consumed and no `code` was given.
	 */
	async assert_and_record(
		route_specs: Array<RouteSpec>,
		method: string,
		path: string,
		response: Response,
		code?: string | null
	): Promise<void> {
		if (code === undefined && response.bodyUsed) {
			throw new Error(
				`assert_and_record: the body of ${method} ${path} was consumed; pass its code ` +
					'(or `null` for none)'
			);
		}
		await assert_response_matches_spec(route_specs, method, path, response, this.route_error_maps);
		let resolved_code = code;
		if (resolved_code === undefined) {
			resolved_code = null;
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
	 * (`resolve_route_error_map`, `this.route_error_maps`): one row per declared code
	 * at each status. An observation with a code covers that row alone; a
	 * status-only observation (a `null` code) covers every row at its status — the
	 * "any-code" rule.
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
 * (`collector.route_error_maps`) one path. An observation with a code covers
 * that path alone; a status-only observation (a `null` code) covers every declared code at
 * its status (the "any-code" rule).
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
