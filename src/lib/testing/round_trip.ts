import './assert_dev_env.js';

/**
 * Schema-driven round-trip validation test suite.
 *
 * For every route spec in the supplied `surface_source`, generates a
 * valid request (auth, params, body) and validates the response against
 * declared output or error schemas. DB-backed via the suite's
 * `setup_test` fixture-producing callback.
 *
 * Cadence: per-describe `setup_test()` call. Each test in the suite
 * fires one HTTP request against a shared fixture — no test mutates
 * state in a way that contaminates the next, so the per-test cost of
 * re-bootstrapping isn't justified here. Suites with state-isolation
 * requirements (integration, admin_integration, audit_completeness)
 * call `setup_test()` per test.
 *
 * @module
 */

import {describe, test, beforeAll} from 'vitest';

import {ROLE_ADMIN} from '../auth/role_schema.js';
import type {TestAccount} from './app_server.js';
import {assert_response_matches_spec, pick_auth_headers} from './integration_helpers.js';
import {resolve_valid_path, generate_valid_body} from './schema_generators.js';
import type {BackendCapabilities} from './cross_backend/capabilities.js';
import type {SetupTest, TestFixture} from './cross_backend/setup.js';
import type {AppSurfaceSpec} from '../http/surface.js';

/** Options for `describe_round_trip_validation`. */
export interface RoundTripTestOptions {
	/**
	 * Per-test fixture-producing function. `describe_round_trip_validation`
	 * invokes this once in `beforeAll` (per-describe cadence — see module
	 * docstring) to share a single bootstrapped keeper + accounts across
	 * every route case.
	 */
	setup_test: SetupTest;
	/**
	 * App surface (with route specs) for route iteration. Constructed in
	 * TS by the consumer; same shape for in-process and cross-process tests.
	 */
	surface_source: AppSurfaceSpec;
	/** Backend capability declarations — see `cross_backend/capabilities.ts`. */
	capabilities: BackendCapabilities;
	/** Routes to skip, in `'METHOD /path'` format. */
	skip_routes?: Array<string>;
	/** Override generated bodies for specific routes (`'METHOD /path'` → body). */
	input_overrides?: Map<string, Record<string, unknown>>;
}

/**
 * Run schema-driven round-trip validation tests.
 *
 * For each route:
 * 1. Resolve URL with valid params
 * 2. Generate a valid request body (or use override)
 * 3. Pick auth headers matching the route's auth requirement
 * 4. Fire the request through `fixture.transport` and validate the response
 *
 * SSE routes are skipped by Content-Type sniff. Routes returning non-2xx
 * with valid input are still validated against their declared error schemas.
 */
export const describe_round_trip_validation = (options: RoundTripTestOptions): void => {
	const describe_time_specs = options.surface_source.route_specs;
	const skip_set = new Set(options.skip_routes);
	// `capabilities` is currently unused by this suite (no in-process-only
	// reads, no transport-gated cases) but stays on the options for
	// uniformity with the other Tier 1 suites.
	void options.capabilities;

	describe('round-trip validation', () => {
		let fixture: TestFixture;
		let authed_account: TestAccount;
		let admin_account: TestAccount;

		beforeAll(async () => {
			fixture = await options.setup_test();
			authed_account = await fixture.create_account({
				username: 'round_trip_authed',
				roles: [],
			});
			admin_account = await fixture.create_account({
				username: 'round_trip_admin',
				roles: [ROLE_ADMIN],
			});
		});

		test.each(describe_time_specs)('$method $path produces schema-valid response', async (spec) => {
			const route_key = `${spec.method} ${spec.path}`;
			if (skip_set.has(route_key)) return;

			const url = resolve_valid_path(spec.path, spec.params);

			const override = options.input_overrides?.get(route_key);
			const body = override ?? generate_valid_body(spec.input);

			const headers = pick_auth_headers(spec, fixture, authed_account, admin_account);

			const request_init: RequestInit = {
				method: spec.method,
				headers: {
					...headers,
					...(body ? {'content-type': 'application/json'} : {}),
				},
				...(body ? {body: JSON.stringify(body)} : {}),
			};

			const res = await fixture.transport(url, request_init);

			if (res.headers.get('Content-Type')?.includes('text/event-stream')) {
				await res.body?.cancel();
				return;
			}

			try {
				await assert_response_matches_spec(describe_time_specs, spec.method, url, res);
			} catch (e) {
				throw new Error(
					`Round-trip validation failed for ${route_key} (status ${res.status}): ${(e as Error).message}`,
				);
			}
		});
	});
};
