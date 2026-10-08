// @vitest-environment jsdom

/**
 * Client-mount tests for `ColumnLayout` - the stacked toggle flipping the
 * aside open and closed, and navigation closing it. jsdom evaluates no
 * container queries, so these check the state and its ARIA reflection, not
 * the aside's visibility - that takes a real browser. jsdom lays nothing
 * out and has no `scrollIntoView`, so each mount stubs it on the aside, and
 * the scroll tests place the aside with a stubbed `getBoundingClientRect`.
 *
 * @module
 */

import { describe, test, assert, vi, afterEach } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { afterNavigate } from '$app/navigation';

import ColumnLayout from '$lib/ui/ColumnLayout.svelte';

// vitest resolves the server builds, which can't mount - load the client builds
vi.mock('svelte', async () =>
	(await import('./svelte_client_test_helpers.ts')).import_svelte_client('.')
);
vi.mock('$app/navigation', () => ({ afterNavigate: vi.fn() }));

const children = createRawSnippet(() => ({ render: () => '<p>content</p>' }));
const aside = createRawSnippet(() => ({ render: () => '<nav>links</nav>' }));

interface MountedLayout {
	body: HTMLElement;
	scroll_into_view: ReturnType<typeof vi.fn>;
	toggle: HTMLButtonElement;
	aside: HTMLElement;
}

let cleanups: Array<() => void> = [];

const mount_layout = (): MountedLayout => {
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(ColumnLayout, { target, props: { children, aside } });
	flushSync();
	cleanups.push(() => {
		void unmount(component);
		target.remove();
	});
	const query = <T extends Element>(selector: string): T => {
		const el = target.querySelector<T>(selector);
		assert.ok(el, `expected ${selector}`);
		return el;
	};
	const aside_el = query<HTMLElement>('aside');
	const scroll_into_view = vi.fn();
	aside_el.scrollIntoView = scroll_into_view;
	return {
		body: query('.column-layout-body'),
		scroll_into_view,
		toggle: query('.column-toggle'),
		aside: aside_el
	};
};

/** Places an element's box at `top` with `height` in the viewport. */
const place = (el: Element, top: number, height: number): void => {
	el.getBoundingClientRect = () => new DOMRect(0, top, 300, height);
};

/** Lets the toggle's async handler run past its `tick()`. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

const assert_open = (layout: MountedLayout, open: boolean): void => {
	assert.strictEqual(layout.toggle.getAttribute('aria-expanded'), String(open));
	assert.strictEqual(layout.body.classList.contains('aside-open'), open);
};

afterEach(() => {
	for (const cleanup of cleanups) cleanup();
	cleanups = [];
	vi.clearAllMocks();
});

describe('ColumnLayout toggle', () => {
	test('controls the aside by id', () => {
		const layout = mount_layout();
		assert.ok(layout.aside.id);
		assert.strictEqual(layout.toggle.getAttribute('aria-controls'), layout.aside.id);
		assert_open(layout, false);
	});

	test('a click opens the aside and another closes it', () => {
		const layout = mount_layout();
		layout.toggle.click();
		flushSync();
		assert_open(layout, true);
		layout.toggle.click();
		flushSync();
		assert_open(layout, false);
	});

	test('each instance toggles only its own aside', () => {
		const a = mount_layout();
		const b = mount_layout();
		assert.notStrictEqual(a.aside.id, b.aside.id);
		a.toggle.click();
		flushSync();
		assert_open(a, true);
		assert_open(b, false);
	});

	test('opening scrolls an aside left above the view under the toggle', async () => {
		const layout = mount_layout();
		place(layout.toggle.parentElement!, 0, 33);
		place(layout.aside, -900, 400);
		layout.toggle.click();
		await settle();
		assert.deepEqual(layout.scroll_into_view.mock.calls, [[{ block: 'start' }]]);
		assert.strictEqual(layout.aside.style.scrollMarginTop, '33px');
		layout.toggle.click();
		await settle();
		assert.strictEqual(layout.scroll_into_view.mock.calls.length, 1, 'closing never scrolls');
	});

	test('opening leaves an aside already in view under the toggle', async () => {
		const layout = mount_layout();
		place(layout.toggle.parentElement!, 0, 33);
		place(layout.aside, 33, 400);
		layout.toggle.click();
		await settle();
		assert_open(layout, true);
		assert.strictEqual(layout.scroll_into_view.mock.calls.length, 0);
	});

	test('opening scrolls an aside above the page top under a toggle scrolled away', async () => {
		const layout = mount_layout();
		place(layout.toggle.parentElement!, -433, 33);
		place(layout.aside, -400, 400);
		layout.toggle.click();
		await settle();
		assert.strictEqual(layout.scroll_into_view.mock.calls.length, 1);
	});

	test('a close before the open settles skips the scroll', async () => {
		const layout = mount_layout();
		place(layout.toggle.parentElement!, 0, 33);
		place(layout.aside, -900, 400);
		layout.toggle.click();
		layout.toggle.click();
		await settle();
		assert_open(layout, false);
		assert.strictEqual(layout.scroll_into_view.mock.calls.length, 0);
	});

	test('navigation closes the open aside', () => {
		const layout = mount_layout();
		layout.toggle.click();
		flushSync();
		assert_open(layout, true);
		const on_navigate = vi.mocked(afterNavigate).mock.lastCall?.[0];
		assert.ok(on_navigate);
		on_navigate({} as Parameters<typeof on_navigate>[0]);
		flushSync();
		assert_open(layout, false);
	});
});
