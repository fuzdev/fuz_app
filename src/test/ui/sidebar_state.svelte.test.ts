// @vitest-environment jsdom

/**
 * Tests for `SidebarState` — the wide and narrow visibility fields, mode
 * routing through a flippable `matchMedia` stub, the reactive `narrow`
 * subscription, `activate`, and the narrow-query guard.
 *
 * @module
 */

import { describe, test, assert, vi, beforeEach, afterEach } from 'vitest';

import { flushSync } from 'svelte';

import { SIDEBAR_NARROW_QUERY_DEFAULT, SidebarState } from '$lib/ui/sidebar_state.svelte.ts';
import { stub_match_media, type MatchMediaStub } from './svelte_client_test_helpers.ts';

// vitest resolves the server builds, whose `MediaQuery` never calls
// `matchMedia` and whose `flushSync` is a no-op — load the client builds
vi.mock('svelte', async () =>
	(await import('./svelte_client_test_helpers.ts')).import_svelte_client('.')
);
vi.mock('svelte/reactivity', async () =>
	(await import('./svelte_client_test_helpers.ts')).import_svelte_client('./reactivity')
);

let media: MatchMediaStub;

beforeEach(() => {
	media = stub_match_media();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('SidebarState defaults', () => {
	test('wide open, narrow closed, default query', () => {
		const state = new SidebarState();
		assert.strictEqual(state.narrow_query, SIDEBAR_NARROW_QUERY_DEFAULT);
		assert.deepEqual(media.queries, [SIDEBAR_NARROW_QUERY_DEFAULT]);
		assert.isTrue(state.show_sidebar_wide);
		assert.isFalse(state.show_sidebar_narrow);
		assert.isFalse(state.narrow);
		assert.isTrue(state.show_sidebar);
	});

	test('narrow viewport starts closed', () => {
		media.set_matches(true);
		const state = new SidebarState();
		assert.isTrue(state.narrow);
		assert.isFalse(state.show_sidebar);
	});

	test('custom query is passed through', () => {
		const state = new SidebarState({ narrow_query: '(max-width: 900px)' });
		assert.strictEqual(state.narrow_query, '(max-width: 900px)');
		assert.deepEqual(media.queries, ['(max-width: 900px)']);
	});
});

describe('SidebarState mode routing', () => {
	test('wide toggle flips only the wide field', () => {
		const state = new SidebarState();
		state.toggle_sidebar();
		assert.isFalse(state.show_sidebar_wide);
		assert.isFalse(state.show_sidebar_narrow);
		assert.isFalse(state.show_sidebar);
		state.toggle_sidebar();
		assert.isTrue(state.show_sidebar_wide);
		assert.isFalse(state.show_sidebar_narrow);
	});

	test('narrow toggle flips only the narrow field', () => {
		media.set_matches(true);
		const state = new SidebarState();
		state.toggle_sidebar();
		assert.isTrue(state.show_sidebar_narrow);
		assert.isTrue(state.show_sidebar_wide);
		assert.isTrue(state.show_sidebar);
		state.toggle_sidebar();
		assert.isFalse(state.show_sidebar_narrow);
		assert.isTrue(state.show_sidebar_wide);
	});

	test('explicit toggle value writes the current mode', () => {
		const state = new SidebarState();
		state.toggle_sidebar(false);
		assert.isFalse(state.show_sidebar_wide);
		media.set_matches(true);
		state.toggle_sidebar(true);
		assert.isTrue(state.show_sidebar_narrow);
		assert.isFalse(state.show_sidebar_wide);
	});

	test('show_sidebar setter writes the current mode', () => {
		const state = new SidebarState();
		state.show_sidebar = false;
		assert.isFalse(state.show_sidebar_wide);
		media.set_matches(true);
		state.show_sidebar = true;
		assert.isTrue(state.show_sidebar_narrow);
		assert.isFalse(state.show_sidebar_wide);
	});

	test('wide closed survives narrow open, close, and crossings', () => {
		const state = new SidebarState();
		state.toggle_sidebar(false);
		media.set_matches(true);
		assert.isFalse(state.show_sidebar);
		state.toggle_sidebar();
		assert.isTrue(state.show_sidebar);
		state.close_narrow();
		assert.isFalse(state.show_sidebar);
		state.toggle_sidebar();
		media.set_matches(false);
		assert.isFalse(state.show_sidebar_wide);
		assert.isFalse(state.show_sidebar);
		media.set_matches(true);
		assert.isTrue(state.show_sidebar, 'narrow field is untouched by crossing on its own');
	});

	test('close_narrow clears only the narrow field', () => {
		media.set_matches(true);
		const state = new SidebarState();
		state.toggle_sidebar(true);
		state.close_narrow();
		assert.isFalse(state.show_sidebar_narrow);
		assert.isTrue(state.show_sidebar_wide);
	});
});

describe('SidebarState narrow reactivity', () => {
	test('an effect reading narrow reruns when the query flips', () => {
		const state = new SidebarState();
		const seen: Array<boolean> = [];
		const cleanup = $effect.root(() => {
			$effect(() => {
				seen.push(state.narrow);
			});
		});
		try {
			flushSync();
			media.set_matches(true);
			flushSync();
			media.set_matches(false);
			flushSync();
		} finally {
			cleanup();
		}
		assert.deepEqual(seen, [false, true, false]);
	});

	test('show_sidebar follows the flip reactively', () => {
		const state = new SidebarState();
		const seen: Array<boolean> = [];
		const cleanup = $effect.root(() => {
			$effect(() => {
				seen.push(state.show_sidebar);
			});
		});
		try {
			flushSync();
			media.set_matches(true);
			flushSync();
		} finally {
			cleanup();
		}
		assert.deepEqual(seen, [true, false]);
	});
});

describe('SidebarState enabled', () => {
	test('show_sidebar is false while disabled, in both modes', () => {
		const state = new SidebarState();
		state.enabled = false;
		assert.isFalse(state.show_sidebar);
		assert.isTrue(state.show_sidebar_wide);
		media.set_matches(true);
		state.show_sidebar_narrow = true;
		assert.isFalse(state.show_sidebar);
	});

	test('enabled getter option overrides the internal field', () => {
		let enabled = false;
		const state = new SidebarState({ enabled: () => enabled });
		assert.isFalse(state.enabled);
		assert.isFalse(state.show_sidebar);
		enabled = true;
		assert.isTrue(state.show_sidebar);
	});
});

describe('SidebarState activate', () => {
	test('activate enables and shows wide; disposer clears both fields', () => {
		const state = new SidebarState();
		state.enabled = false;
		state.show_sidebar_wide = false;
		const dispose = state.activate();
		assert.isTrue(state.enabled);
		assert.isTrue(state.show_sidebar_wide);
		assert.isTrue(state.show_sidebar);
		media.set_matches(true);
		state.toggle_sidebar(true);
		dispose();
		assert.isFalse(state.enabled);
		assert.isFalse(state.show_sidebar_wide);
		assert.isFalse(state.show_sidebar_narrow);
		assert.isFalse(state.show_sidebar);
	});
});

describe('SidebarState narrow_query', () => {
	test('null disables narrow mode without calling matchMedia', () => {
		media.set_matches(true);
		const state = new SidebarState({ narrow_query: null });
		assert.isNull(state.narrow_query);
		assert.isFalse(state.narrow);
		assert.deepEqual(media.queries, []);
		state.toggle_sidebar();
		assert.isFalse(state.show_sidebar_wide);
		assert.isFalse(state.show_sidebar_narrow);
	});

	test('a query without parentheses throws in DEV', () => {
		assert.throws(() => new SidebarState({ narrow_query: 'max-width: 900px' }), /parentheses/);
		assert.deepEqual(media.queries, []);
	});
});
