// @vitest-environment jsdom

/**
 * Client-mount tests for `OpenSignupToggle` — the checkbox shows the server's
 * `open_signup` after a write settles, including after a refused write, when
 * the browser has already flipped the box.
 *
 * @module
 */

import { describe, test, assert, vi, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import type { AppSettingsRpc } from '#lib/ui/app_settings_state.svelte.ts';
import type { AppSettingsWithUsernameJson } from '#lib/auth/app_settings_schema.ts';
import OpenSignupToggleHarness from './OpenSignupToggleHarness.svelte';

// vitest resolves the server builds, which can't mount — load the client builds
vi.mock('svelte', async () =>
	(await import('./svelte_client_test_helpers.ts')).import_svelte_client('.')
);

const settings = (open_signup: boolean): AppSettingsWithUsernameJson => ({
	open_signup,
	updated_at: null,
	updated_by: null,
	updated_by_username: null
});

/** Resolve pending microtasks and macrotasks, then flush Svelte's effects. */
const settle = async (): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
};

let cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups) cleanup();
	cleanups = [];
});

const mount_toggle = async (rpc: AppSettingsRpc): Promise<HTMLInputElement> => {
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(OpenSignupToggleHarness, { target, props: { rpc } });
	cleanups.push(() => {
		void unmount(component);
		target.remove();
	});
	await settle();
	const input = target.querySelector<HTMLInputElement>('input[type="checkbox"]');
	assert.ok(input, 'the checkbox renders once settings load');
	return input;
};

/** Click the box the way a user does: the browser flips it, then `change` fires. */
const click = async (input: HTMLInputElement): Promise<void> => {
	input.click();
	await settle();
};

describe('OpenSignupToggle', () => {
	test('a refused write re-syncs the box to the server state', async () => {
		const rpc: AppSettingsRpc = {
			get: async () => ({ settings: settings(false) }),
			update: async () => {
				throw new Error('refused');
			}
		};
		const input = await mount_toggle(rpc);
		assert.isFalse(input.checked);

		await click(input);
		assert.isFalse(input.checked, 'the refused write leaves open signup off');
		assert.isFalse(input.disabled);
	});

	test('an accepted write shows the server answer', async () => {
		const updates: Array<boolean> = [];
		const rpc: AppSettingsRpc = {
			get: async () => ({ settings: settings(false) }),
			update: async ({ open_signup }) => {
				updates.push(open_signup);
				return { ok: true, settings: settings(open_signup) };
			}
		};
		const input = await mount_toggle(rpc);

		await click(input);
		assert.deepStrictEqual(updates, [true]);
		assert.isTrue(input.checked);

		await click(input);
		assert.deepStrictEqual(updates, [true, false]);
		assert.isFalse(input.checked);
	});
});
