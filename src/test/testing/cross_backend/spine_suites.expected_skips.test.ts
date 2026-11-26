/**
 * `describe_spine_cross_suites`' `expected_skips`: the suites skipped for an
 * undeclared backdoor are gated skips the backend owes a declaration, while an
 * `exclude` declares its own. Every other suite is excluded and the
 * unexcludable ones stubbed, so nothing here needs a backend; the closing
 * check of an undeclared backdoor skip is flagged `fails`, as `test.fails`
 * would, so that run passes only when it throws.
 *
 * @module
 */

import { assert, describe, test, TestRunner, vi } from 'vitest';

import type { BackendCapabilities } from '#lib/testing/cross_backend/capabilities.ts';
import {
	DECLARED_SKIPS_CHECK_NAME,
	is_gated_skip
} from '#lib/testing/cross_backend/declared_skips.ts';
import type { ReconstructedBootstrappedBackendHandle } from '#lib/testing/cross_backend/setup.ts';
import {
	describe_spine_cross_suites,
	SPINE_SUITES_SKIPPED_TITLE,
	SUITE_NAMES,
	UNEXCLUDABLE_SPINE_SUITES,
	type SpineCrossSuitesOptions
} from '#lib/testing/cross_backend/spine_suites.ts';

vi.mock('#lib/testing/cross_backend/capability_mounts.ts', async (import_original) => ({
	...(await import_original<typeof import('#lib/testing/cross_backend/capability_mounts.ts')>()),
	describe_capability_mounts_cross_tests: () => {}
}));

vi.mock('#lib/testing/cross_backend/testing_backdoor.ts', async (import_original) => ({
	...(await import_original<typeof import('#lib/testing/cross_backend/testing_backdoor.ts')>()),
	describe_testing_backdoor_cross_tests: () => {}
}));

/** The suites that skip themselves on a backend declaring only the shared backdoors, with the backdoor each needs. */
const SELF_SKIPPING: Record<string, string> = {
	credential_conformance: '_testing_credential_read',
	credential_deadline: '_testing_shorten_credential_expiry',
	origin_conformance: '_testing_origin_check',
	ws_outbound_overflow: '_testing_flood_notifications'
};

const handle = {
	config: {
		capabilities: {
			ws: false,
			testing_backdoors: ['_testing_reset', '_testing_drain_effects', '_testing_db_invariants']
		} as unknown as BackendCapabilities,
		env: {},
		base_url: 'http://localhost:1',
		rpc_path: '/api/rpc'
	}
} as unknown as ReconstructedBootstrappedBackendHandle;

const exclude = Object.fromEntries(
	SUITE_NAMES.filter((n) => !(n in SELF_SKIPPING) && !(n in UNEXCLUDABLE_SPINE_SUITES)).map((n) => [
		n,
		'not under test'
	])
);

/** The skip line's path for the suite `name` skipped for `backdoor`. */
const backdoor_skip_path = (name: string, backdoor: string): string =>
	`${SPINE_SUITES_SKIPPED_TITLE} > ${name}: needs \`${backdoor}\`, which capabilities.testing_backdoors doesn't declare`;

const all_backdoor_skips = Object.fromEntries(
	Object.entries(SELF_SKIPPING).map(([name, backdoor]) => [
		backdoor_skip_path(name, backdoor),
		'the backend mounts no such backdoor'
	])
);

describe('every backdoor skip declared, the excludes declaring themselves', () => {
	describe_spine_cross_suites(handle, {
		exclude,
		expected_skips: all_backdoor_skips
	} as unknown as SpineCrossSuitesOptions);

	test('the skipped suites are gated skips, excludes and backdoor skips alike', (ctx) => {
		const skipped = ctx.task.suite!.tasks.find((t) => t.name === SPINE_SUITES_SKIPPED_TITLE);
		assert.ok(skipped?.type === 'suite');
		assert.ok(skipped.tasks.length > Object.keys(SELF_SKIPPING).length);
		for (const task of skipped.tasks) assert.ok(is_gated_skip(task), task.name);
	});
});

describe('a backdoor skip left undeclared', () => {
	const { [backdoor_skip_path('origin_conformance', '_testing_origin_check')]: _, ...rest } =
		all_backdoor_skips;
	describe_spine_cross_suites(handle, {
		exclude,
		expected_skips: rest
	} as unknown as SpineCrossSuitesOptions);
	const check = TestRunner.getCurrentSuite().tasks.at(-1);
	assert.ok(check?.type === 'test' && check.name === DECLARED_SKIPS_CHECK_NAME);
	check.fails = true;
});

describe('expected_skips is required', () => {
	test('a call without it throws, so no gated skip goes unchecked', () => {
		assert.throws(
			() => describe_spine_cross_suites(handle, { exclude } as unknown as SpineCrossSuitesOptions),
			/expected_skips is required/
		);
	});
});

describe('an empty expected_skips still checks', () => {
	describe_spine_cross_suites(handle, {
		exclude,
		expected_skips: {}
	} as unknown as SpineCrossSuitesOptions);
	const check = TestRunner.getCurrentSuite().tasks.at(-1);
	assert.ok(check?.type === 'test' && check.name === DECLARED_SKIPS_CHECK_NAME);
	// every backdoor skip is undeclared
	check.fails = true;
});
