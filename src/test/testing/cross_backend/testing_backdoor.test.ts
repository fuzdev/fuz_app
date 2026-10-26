/**
 * Tests for the testing-backdoor suite's rows — which known backdoors get the
 * declaration probe and which the credential-gate rows, by the backend's
 * `capabilities.testing_backdoors` — and its refusals of a bad declaration or
 * extra seam. The rows are registered under `describe.skip` and read back,
 * since running them needs a backend.
 *
 * @module
 */

import { assert, describe, test, type RunnerTask } from 'vitest';

import type { BackendCapabilities } from '#lib/testing/cross_backend/capabilities.ts';
import type { SetupTest } from '#lib/testing/cross_backend/setup.ts';
import {
	TESTING_BACKDOOR_METHODS,
	type TestingBackdoorMethod
} from '#lib/testing/cross_backend/spine_surface_constants.ts';
import {
	describe_testing_backdoor_cross_tests,
	type TestingBackdoorCrossTestOptions
} from '#lib/testing/cross_backend/testing_backdoor.ts';

const setup_test: SetupTest = () => Promise.reject(new Error('no backend'));

const options_declaring = (
	testing_backdoors: ReadonlyArray<string>,
	rest: Partial<TestingBackdoorCrossTestOptions> = {}
): TestingBackdoorCrossTestOptions => ({
	setup_test,
	capabilities: { testing_backdoors } as unknown as BackendCapabilities,
	...rest
});

const DECLARED: ReadonlyArray<TestingBackdoorMethod> = ['_testing_reset', '_testing_drain_effects'];
const EXTRA = '_testing_app_invite_expire';

/** Every test name below `task`, its describe titles dropped. */
const test_names = (task: RunnerTask): Array<string> =>
	task.type === 'suite' ? task.tasks.flatMap(test_names) : [task.name];

describe.skip('rows for a partial declaration', () => {
	describe_testing_backdoor_cross_tests(
		options_declaring(DECLARED, {
			ws: { base_url: 'http://localhost:1', ws_path: '/api/ws' },
			extra_methods: [{ method: EXTRA, params: {} }]
		})
	);
});

describe.skip('rows for a full declaration', () => {
	describe_testing_backdoor_cross_tests(options_declaring(TESTING_BACKDOOR_METHODS));
});

describe('describe_testing_backdoor_cross_tests rows', () => {
	const rows_of = (title: string, file: RunnerTask): Array<string> => {
		const root = file.type === 'suite' ? file.tasks.find((t) => t.name === title) : undefined;
		assert.ok(root, title);
		return test_names(root);
	};

	test('an undeclared backdoor gets the not-mounted probe, a declared one the gate rows', (ctx) => {
		const rows = rows_of('rows for a partial declaration', ctx.task.file);
		const undeclared = TESTING_BACKDOOR_METHODS.filter((m) => !DECLARED.includes(m));
		assert.deepStrictEqual(
			rows.filter((r) => r.endsWith('is undeclared → method_not_found')),
			undeclared.map((m) => `${m} is undeclared → method_not_found`)
		);
		for (const method of [...DECLARED, EXTRA]) {
			for (const row of [
				`${method} rejects anonymous → 401`,
				`${method} rejects session → 403`,
				`${method} rejects bearer → 403`,
				`${method} over a session socket → forbidden credential_type_required`
			]) {
				assert.include(rows, row);
			}
		}
		for (const method of undeclared) {
			assert.ok(
				!rows.some((r) => r.startsWith(`${method} rejects`) || r.startsWith(`${method} over`)),
				`${method} is undeclared, so it gets no gate rows`
			);
		}
	});

	test('a full declaration probes nothing as unmounted', (ctx) => {
		const root = ctx.task.file.tasks.find((t) => t.name === 'rows for a full declaration');
		assert.ok(root?.type === 'suite');
		// vitest fails a describe holding no test, so none is registered
		assert.deepStrictEqual(
			root.tasks.map((t) => t.name),
			['testing backdoor credential gate parity']
		);
		const rows = rows_of('rows for a full declaration', ctx.task.file);
		assert.ok(!rows.some((r) => r.includes('undeclared')));
		assert.strictEqual(
			rows.filter((r) => r.includes(' rejects ')).length,
			TESTING_BACKDOOR_METHODS.length * 3
		);
	});
});

describe('describe_testing_backdoor_cross_tests refusals', () => {
	test('a declared method outside the known list throws', () => {
		assert.throws(
			() => describe_testing_backdoor_cross_tests(options_declaring(['_testing_reset', EXTRA])),
			/declares '_testing_app_invite_expire', which is not in TESTING_BACKDOOR_METHODS/
		);
	});

	test('a method declared twice throws', () => {
		assert.throws(
			() =>
				describe_testing_backdoor_cross_tests(
					options_declaring(['_testing_reset', '_testing_reset'])
				),
			/declares '_testing_reset' twice/
		);
	});

	test('an extra method must be a `_testing_` seam off the known list, listed once', () => {
		for (const method of ['app_invite_expire', '_testing_reset']) {
			assert.throws(
				() =>
					describe_testing_backdoor_cross_tests(
						options_declaring(DECLARED, { extra_methods: [{ method }] })
					),
				/must start with '_testing_' and not be a known backdoor/,
				method
			);
		}
		assert.throws(
			() =>
				describe_testing_backdoor_cross_tests(
					options_declaring(DECLARED, { extra_methods: [{ method: EXTRA }, { method: EXTRA }] })
				),
			/extra method '_testing_app_invite_expire' is listed twice/
		);
	});
});
