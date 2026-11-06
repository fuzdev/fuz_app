/**
 * Tests for `describe_standard_cross_process_tests` — what it forwards to the
 * suites it bundles, each mocked to record its options.
 *
 * @module
 */

import { describe, test, assert, vi } from 'vitest';

const calls = vi.hoisted(() => ({
	round_trip: [] as Array<Record<string, unknown>>,
	data_exposure: [] as Array<Record<string, unknown>>
}));

vi.mock('#lib/testing/integration.ts', () => ({ describe_standard_integration_tests: () => {} }));
vi.mock('#lib/testing/admin_integration.ts', () => ({
	describe_standard_admin_integration_tests: () => {}
}));
vi.mock('#lib/testing/rpc_round_trip.ts', () => ({ describe_rpc_round_trip_tests: () => {} }));
vi.mock('#lib/testing/round_trip.ts', () => ({
	describe_round_trip_validation: (options: Record<string, unknown>) => {
		calls.round_trip.push(options);
	}
}));
vi.mock('#lib/testing/data_exposure.ts', () => ({
	describe_data_exposure_tests: (options: Record<string, unknown>) => {
		calls.data_exposure.push(options);
	}
}));

import {
	describe_standard_cross_process_tests,
	type StandardCrossProcessTestOptions
} from '#lib/testing/cross_backend/standard.ts';
import type { RouteParamValues } from '#lib/testing/schema_generators.ts';

describe('describe_standard_cross_process_tests', () => {
	test('forwards `param_values` to the round trip and data exposure', () => {
		const param_values: RouteParamValues = {
			'GET /:slug{.+\\.git}/info/refs': { slug: 'org/repo.git' }
		};
		describe_standard_cross_process_tests({
			param_values
		} as unknown as StandardCrossProcessTestOptions);
		assert.strictEqual(calls.round_trip.length, 1);
		assert.strictEqual(calls.data_exposure.length, 1);
		assert.strictEqual(calls.round_trip[0]!.param_values, param_values);
		assert.strictEqual(calls.data_exposure[0]!.param_values, param_values);
	});
});
