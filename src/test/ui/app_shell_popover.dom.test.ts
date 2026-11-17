// @vitest-environment jsdom

/**
 * fuz_app's `Popover` inside fuz_ui's `AppShell`: one Escape closes a popover
 * open in the narrow overlay's sidebar, and the next closes the overlay. The
 * shell's own behavior is tested in fuz_ui; this case pins the composition of
 * the two packages, which neither suite covers alone.
 *
 * @module
 */

import { test, assert, vi, beforeEach, afterEach } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import AppShell from '@fuzdev/fuz_ui/AppShell.svelte';
import { SidebarState } from '@fuzdev/fuz_ui/sidebar_state.svelte.ts';

import { Popover } from '#lib/ui/popover.svelte.ts';
import { stub_match_media, type MatchMediaStub } from './svelte_client_test_helpers.ts';

// vitest resolves the server builds, which can't mount — load the client builds
vi.mock('svelte', async () =>
	(await import('./svelte_client_test_helpers.ts')).import_svelte_client('.')
);
vi.mock('svelte/reactivity', async () =>
	(await import('./svelte_client_test_helpers.ts')).import_svelte_client('./reactivity')
);
vi.mock('$app/navigation', () => ({ afterNavigate: vi.fn() }));

const children = createRawSnippet(() => ({
	render: () => '<div><button type="button" class="opener">open</button></div>'
}));
const sidebar = createRawSnippet(() => ({
	render: () => '<nav><a href="#here" class="link">here</a></nav>'
}));

let media: MatchMediaStub;
let cleanups: Array<() => void> = [];

beforeEach(() => {
	media = stub_match_media();
	media.set_matches(true);
});

afterEach(() => {
	for (const cleanup of cleanups) cleanup();
	cleanups = [];
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** Dispatches a bubbling, cancelable `keydown` from the focused element. */
const press = (key: string): void => {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	(document.activeElement ?? document.body).dispatchEvent(event);
};

test('closes a popover open in the sidebar first, then the overlay', () => {
	const target = document.createElement('div');
	document.body.append(target);
	// created after the `matchMedia` stub, so it sees `media`
	const sidebar_state = new SidebarState();
	const component = mount(AppShell, { target, props: { children, sidebar, sidebar_state } });
	flushSync();
	cleanups.push(() => {
		void unmount(component);
		target.remove();
	});
	const opener = target.querySelector<HTMLButtonElement>('.opener');
	const link = target.querySelector<HTMLAnchorElement>('.link');
	assert.ok(opener && link);

	opener.focus();
	sidebar_state.show = true;
	flushSync();
	assert.isTrue(sidebar_state.show_narrow, 'the overlay opens');

	// a popover opened from the sidebar after the overlay, its content beside the link
	const popover = new Popover();
	const content = document.createElement('div');
	link.after(content);
	const detach_trigger = popover.trigger()(link);
	const detach_content = popover.content()(content);
	cleanups.push(() => {
		detach_content?.();
		detach_trigger?.();
		popover.hide();
		content.remove();
	});
	popover.show();

	press('Escape');
	assert.isFalse(popover.visible, 'the popover closes');
	assert.isTrue(sidebar_state.show_narrow, 'the overlay stays open');

	press('Escape');
	assert.isFalse(sidebar_state.show_narrow);
});
