/**
 * `describe_spine_cross_suites` skipping the suites whose backdoor the backend
 * doesn't declare — each shown as a skipped test with a reason naming the
 * backdoor, beside the excludes — and handing the testing-backdoor suite the
 * backend's capabilities. Every other suite is excluded and the backdoor suite
 * stubbed to record its options (an override keeping its capabilities passes
 * through), so nothing here needs a backend.
 *
 * @module
 */

import { assert, describe, test, vi } from 'vitest';

import {
	describe_spine_cross_suites,
	SUITE_NAMES,
	type SpineCrossSuitesOptions
} from '#lib/testing/cross_backend/spine_suites.ts';
import type { BackendCapabilities } from '#lib/testing/cross_backend/capabilities.ts';
import type { ReconstructedBootstrappedBackendHandle } from '#lib/testing/cross_backend/setup.ts';
import type { TestingBackdoorCrossTestOptions } from '#lib/testing/cross_backend/testing_backdoor.ts';

const recorded: Array<TestingBackdoorCrossTestOptions> = vi.hoisted(() => []);

vi.mock('#lib/testing/cross_backend/testing_backdoor.ts', async (import_original) => ({
	...(await import_original<typeof import('#lib/testing/cross_backend/testing_backdoor.ts')>()),
	describe_testing_backdoor_cross_tests: (options: TestingBackdoorCrossTestOptions) => {
		recorded.push(options);
	}
}));

/** The suites that skip themselves on a backend declaring only the shared backdoors. */
const SELF_SKIPPING = ['credential_deadline', 'origin_conformance', 'ws_outbound_overflow'];

const capabilities = {
	ws: false,
	testing_backdoors: ['_testing_reset', '_testing_drain_effects']
} as unknown as BackendCapabilities;

const handle = {
	config: { capabilities, env: {}, base_url: 'http://localhost:1', rpc_path: '/api/rpc' }
} as unknown as ReconstructedBootstrappedBackendHandle;

describe('a backend declaring only the shared backdoors', () => {
	describe_spine_cross_suites(handle, {
		exclude: Object.fromEntries(
			SUITE_NAMES.filter((n) => !SELF_SKIPPING.includes(n) && n !== 'testing_backdoor').map((n) => [
				n,
				'not under test'
			])
		),
		// an override keeping the derived capabilities passes through
		overrides: { testing_backdoor: { extra_methods: [{ method: '_testing_consumer_seam' }] } }
	} as unknown as SpineCrossSuitesOptions);

	test('skips each suite needing an undeclared backdoor, naming it', (ctx) => {
		const skipped = ctx.task.suite!.tasks.find(
			(t) => t.name === 'spine cross suites excluded on this backend'
		);
		assert.ok(skipped?.type === 'suite');
		const names = skipped.tasks.map((t) => t.name);
		for (const [name, backdoor] of [
			['credential_deadline', '_testing_shorten_credential_expiry'],
			['origin_conformance', '_testing_origin_check'],
			['ws_outbound_overflow', '_testing_flood_notifications']
		]) {
			assert.include(
				names,
				`${name}: needs \`${backdoor}\`, which capabilities.testing_backdoors doesn't declare`
			);
		}
		for (const task of skipped.tasks) assert.strictEqual(task.mode, 'skip', task.name);
		assert.include(names, 'ready: not under test', 'the excludes stay beside them');
	});

	test('runs the testing-backdoor suite with the backend capabilities', () => {
		assert.strictEqual(recorded.length, 1);
		assert.strictEqual(recorded[0]!.capabilities, capabilities);
		assert.deepEqual(recorded[0]!.extra_methods, [{ method: '_testing_consumer_seam' }]);
	});
});
