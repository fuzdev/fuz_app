// @vitest-environment jsdom

/**
 * Client-mount tests for `AccountSessions` — the current session reads
 * `current` and logs out in place of a revoke, `revoke all` waits for a
 * confirm, and only a revoke-all that succeeded logs out.
 *
 * @module
 */

import { describe, test, assert, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import type { AccountSessionsRpc } from '#lib/ui/account_sessions_state.svelte.ts';
import type { AuthState } from '#lib/ui/auth_state.svelte.ts';
import AccountSessionsHarness from './AccountSessionsHarness.svelte';
import { make_auth_session } from './session_fixtures.ts';

// vitest resolves the server builds, which can't mount — load the client builds
vi.mock('svelte', async () =>
	(await import('./svelte_client_test_helpers.ts')).import_svelte_client('.')
);

/** Resolve pending microtasks and macrotasks, then flush Svelte's effects. */
const settle = async (): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
};

// jsdom has no Web Animations, and the popover's transition calls `animate`:
// a stub that finishes at once
const original_animate = Element.prototype.animate as typeof Element.prototype.animate | undefined;
beforeAll(() => {
	Element.prototype.animate = function (): Animation {
		const animation = {
			cancel: () => {},
			finish: () => {},
			currentTime: 0,
			onfinish: null as (() => void) | null
		};
		queueMicrotask(() => animation.onfinish?.());
		return animation as unknown as Animation;
	};
});
afterAll(() => {
	if (original_animate) Element.prototype.animate = original_animate;
	else delete (Element.prototype as { animate?: unknown }).animate;
});

let cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.reverse()) cleanup();
	cleanups = [];
});

const sessions = [
	make_auth_session({ id: 'sess-current', is_current: true }),
	make_auth_session({ id: 'sess-other' })
];

const make_rpc = (overrides: Partial<AccountSessionsRpc> = {}): AccountSessionsRpc => ({
	list: vi.fn(async () => ({ sessions })),
	revoke: vi.fn(async () => ({ ok: true as const, revoked: true })),
	revoke_all: vi.fn(async () => ({ ok: true as const, count: 2 })),
	...overrides
});

const mount_sessions = async (
	rpc: AccountSessionsRpc
): Promise<{ target: HTMLElement; logout: ReturnType<typeof vi.fn> }> => {
	const logout = vi.fn(async () => {});
	const auth_state = { logout } as unknown as AuthState;
	const target = document.createElement('div');
	document.body.append(target);
	cleanups.push(() => target.remove());
	const component = mount(AccountSessionsHarness, { target, props: { rpc, auth_state } });
	cleanups.push(() => void unmount(component));
	await settle();
	return { target, logout };
};

const button_by_text = (root: ParentNode, text: string): HTMLButtonElement => {
	const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
		(b) => b.textContent?.trim() === text
	);
	assert.ok(button, `no "${text}" button`);
	return button;
};

const rows = (target: HTMLElement): Array<HTMLElement> =>
	Array.from(target.querySelectorAll<HTMLElement>('.datatable-row'));

/** Open `revoke all`'s popover and press its confirm. */
const confirm_revoke_all = async (target: HTMLElement): Promise<void> => {
	button_by_text(target, 'revoke all').click();
	await settle();
	const confirm = document.querySelector<HTMLButtonElement>(
		'button[title="confirm revoke all sessions"]'
	);
	assert.ok(confirm, 'the revoke-all confirm opens');
	confirm.click();
	await settle();
};

describe('AccountSessions', () => {
	test('the current session reads current and logs out instead of revoking', async () => {
		const rpc = make_rpc();
		const { target, logout } = await mount_sessions(rpc);
		const [current_row, other_row] = rows(target);
		assert.ok(current_row && other_row);
		assert.include(current_row.textContent, 'current');
		assert.notInclude(other_row.textContent, 'current');

		button_by_text(current_row, 'log out').click();
		await settle();
		assert.strictEqual(logout.mock.calls.length, 1);
		assert.strictEqual(vi.mocked(rpc.revoke).mock.calls.length, 0);

		button_by_text(other_row, 'revoke').click();
		await settle();
		assert.deepStrictEqual(vi.mocked(rpc.revoke).mock.calls[0]?.[0], { session_id: 'sess-other' });
		assert.strictEqual(logout.mock.calls.length, 1, 'revoking another session stays logged in');
	});

	test('revoke all waits for its confirm, then logs out', async () => {
		const rpc = make_rpc();
		const { target, logout } = await mount_sessions(rpc);

		button_by_text(target, 'revoke all').click();
		await settle();
		assert.strictEqual(vi.mocked(rpc.revoke_all).mock.calls.length, 0, 'the trigger only asks');
		// close it again so the next open starts from a closed popover
		button_by_text(target, 'revoke all').click();
		await settle();

		await confirm_revoke_all(target);
		assert.strictEqual(vi.mocked(rpc.revoke_all).mock.calls.length, 1);
		assert.strictEqual(logout.mock.calls.length, 1);
	});

	test('a failed revoke all stays logged in and shows the error', async () => {
		const rpc = make_rpc({
			revoke_all: vi.fn(async () => {
				throw new Error('revoke all failed');
			})
		});
		const { target, logout } = await mount_sessions(rpc);

		await confirm_revoke_all(target);
		assert.strictEqual(logout.mock.calls.length, 0);
		assert.include(target.textContent, 'revoke all failed');
	});
});
