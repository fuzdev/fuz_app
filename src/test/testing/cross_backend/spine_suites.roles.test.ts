/**
 * Tests for the role options `describe_spine_cross_suites` derives —
 * `suite_roles` reaching the role-shaped suites, with `cell_grant_role`'s
 * holder seeded on its role. Each suite's derived options are read through a
 * function override that then clears a required option, so the call throws
 * before anything registers; `default_cross_process_setup` is stubbed to
 * return the setup options it was given.
 *
 * @module
 */

import { assert, describe, test, vi } from 'vitest';

import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import {
	describe_spine_cross_suites,
	SUITE_NAMES,
	type SpineCrossSuitesOptions,
	type SuiteName
} from '#lib/testing/cross_backend/spine_suites.ts';
import type { BackendCapabilities } from '#lib/testing/cross_backend/capabilities.ts';
import {
	CELL_EDITOR_ROLE,
	CELL_ROLE_HOLDER_USERNAME
} from '#lib/testing/cross_backend/cell_grant_role.ts';
import type {
	CrossProcessSetupOptions,
	ReconstructedBootstrappedBackendHandle
} from '#lib/testing/cross_backend/setup.ts';

vi.mock('#lib/testing/cross_backend/setup.ts', async (import_original) => ({
	...(await import_original<typeof import('#lib/testing/cross_backend/setup.ts')>()),
	// a setup carrying the options it was built from, for the test to read
	default_cross_process_setup: (_handle: unknown, options?: CrossProcessSetupOptions) =>
		Object.assign(() => Promise.reject(new Error('stub setup')), { options })
}));

const handle = {
	config: { capabilities: { ws: true } as unknown as BackendCapabilities, env: {} }
} as unknown as ReconstructedBootstrappedBackendHandle;

/** The derived option fields these tests read. */
interface DerivedRoleOptions {
	readonly role?: string;
	readonly setup_test: { readonly options?: CrossProcessSetupOptions };
}

/** The options `describe_spine_cross_suites` derives for `name`. */
const derive = (
	name: SuiteName,
	options: Partial<SpineCrossSuitesOptions> = {}
): DerivedRoleOptions => {
	let derived: unknown;
	assert.throws(
		() =>
			describe_spine_cross_suites(handle, {
				...options,
				exclude: Object.fromEntries(
					SUITE_NAMES.filter((n) => n !== name).map((n) => [n, 'not under test'])
				),
				overrides: {
					[name]: (d: unknown) => {
						derived = d;
						return { setup_test: undefined };
					}
				}
			} as SpineCrossSuitesOptions),
		/needs `setup_test`/
	);
	return derived as DerivedRoleOptions;
};

const seeded_holder_roles = (derived: DerivedRoleOptions): unknown =>
	derived.setup_test.options?.extra_accounts?.find((a) => a.username === CELL_ROLE_HOLDER_USERNAME)
		?.roles;

describe('describe_spine_cross_suites suite_roles', () => {
	test("cell_grant_role's holder is seeded with suite_roles.cell_grant, which is its role", () => {
		const derived = derive('cell_grant_role', { suite_roles: { cell_grant: ROLE_KEEPER } });
		assert.strictEqual(derived.role, ROLE_KEEPER);
		assert.deepStrictEqual(seeded_holder_roles(derived), [ROLE_KEEPER]);
	});

	test('cell_grant_role defaults to the spine cell editor role', () => {
		const derived = derive('cell_grant_role');
		assert.strictEqual(derived.role, CELL_EDITOR_ROLE);
		assert.deepStrictEqual(seeded_holder_roles(derived), [CELL_EDITOR_ROLE]);
	});

	test('suite_roles.conferral reaches both conferral suites', () => {
		for (const name of ['role_grant_offer_lifecycle', 'role_grant_participation'] as const) {
			assert.strictEqual(
				derive(name, { suite_roles: { conferral: ROLE_ADMIN } }).role,
				ROLE_ADMIN,
				name
			);
			assert.strictEqual(derive(name).role, undefined, `${name} keeps its own default`);
		}
	});
});
