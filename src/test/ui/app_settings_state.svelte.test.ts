// @vitest-environment jsdom

/**
 * Tests for `AppSettingsState` — the settings fetch and the `open_signup`
 * write, through the injected `AppSettingsRpc` adapter.
 *
 * @module
 */

import { describe, test, assert, vi } from 'vitest';

import { AppSettingsState, type AppSettingsRpc } from '#lib/ui/app_settings_state.svelte.ts';
import type { AppSettingsWithUsernameJson } from '#lib/auth/app_settings_schema.ts';

const settings = (open_signup: boolean): AppSettingsWithUsernameJson => ({
	open_signup,
	updated_at: null,
	updated_by: null,
	updated_by_username: null
});

const make_rpc = (overrides: Partial<AppSettingsRpc> = {}): AppSettingsRpc => ({
	get: vi.fn().mockResolvedValue({ settings: settings(false) }),
	update: vi.fn(async ({ open_signup }) => ({
		ok: true as const,
		settings: settings(open_signup)
	})),
	...overrides
});

describe('AppSettingsState.fetch', () => {
	test('starts with no settings, then holds the fetched ones', async () => {
		const state = new AppSettingsState({ get_rpc: () => make_rpc() });
		assert.strictEqual(state.settings, null);

		await state.fetch();
		assert.isFalse(state.settings?.open_signup);
		assert.isTrue(state.list.succeeded);
	});

	test('a failed fetch leaves settings null and surfaces the error', async () => {
		const rpc = make_rpc({ get: vi.fn().mockRejectedValue(new Error('forbidden')) });
		const state = new AppSettingsState({ get_rpc: () => rpc });
		await state.fetch();

		assert.isNull(state.settings);
		assert.strictEqual(state.list.error, 'forbidden');
	});
});

describe('AppSettingsState.update_open_signup', () => {
	test('sends the value and takes the server answer', async () => {
		const rpc = make_rpc();
		const state = new AppSettingsState({ get_rpc: () => rpc });
		await state.fetch();

		await state.update_open_signup(true);

		assert.deepStrictEqual(vi.mocked(rpc.update).mock.calls[0]?.[0], { open_signup: true });
		assert.isTrue(state.settings?.open_signup);
		assert.isTrue(state.update.succeeded);
	});

	test('the server answer wins over the requested value', async () => {
		const rpc = make_rpc({
			update: vi.fn().mockResolvedValue({ ok: true, settings: settings(false) })
		});
		const state = new AppSettingsState({ get_rpc: () => rpc });
		await state.fetch();

		await state.update_open_signup(true);
		assert.isFalse(state.settings?.open_signup);
	});

	test('a refused write keeps the last known settings and surfaces the error', async () => {
		const rpc = make_rpc({ update: vi.fn().mockRejectedValue(new Error('refused')) });
		const state = new AppSettingsState({ get_rpc: () => rpc });
		await state.fetch();

		await state.update_open_signup(true);

		assert.isFalse(state.settings?.open_signup, 'still the fetched value');
		assert.strictEqual(state.update.error, 'refused');
	});
});
