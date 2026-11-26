/**
 * `describe_rpc_adversarial_cross_tests` refuses, at collection, a
 * `skip_methods` entry naming no method at its RPC path, declared or
 * live-mounted, and accepts one naming a live-only method — each endpoint's
 * envelope cases then get only the entries it carries. Each registration runs
 * inside `describe.skip`, so nothing is sent.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { describe_rpc_adversarial_cross_tests } from '#lib/testing/cross_backend/rpc_adversarial.ts';
import type { SetupTest } from '#lib/testing/cross_backend/setup.ts';

import { probe_registration } from '../collection_test_helpers.ts';
import { SKIP_RPC_PATH, skip_live_endpoints, skip_surface_source } from '../rpc_skip_fixtures.ts';

const setup_test: SetupTest = () => {
	throw new Error('a skipped describe runs no setup');
};

const register = (skip_methods: Array<string>) => () =>
	describe_rpc_adversarial_cross_tests({
		setup_test,
		surface_source: skip_surface_source,
		live_rpc_endpoints: skip_live_endpoints,
		rpc_path: SKIP_RPC_PATH,
		skip_methods
	});

const unknown = probe_registration('unknown method', register(['widget_gone']));
const declared = probe_registration('declared method', register(['widget_burn']));
const live_only = probe_registration('live-only method', register(['widget_secret']));

describe('describe_rpc_adversarial_cross_tests skip_methods', () => {
	test('an entry naming no method throws at collection', () => {
		assert.strictEqual(
			unknown.error,
			"describe_rpc_adversarial_cross_tests: skip_methods names 'widget_gone', which is not a method at '/api/rpc', declared or live-mounted"
		);
	});

	test('a declared or live-only method collects', () => {
		assert.isNull(declared.error);
		assert.isNull(live_only.error);
	});
});
