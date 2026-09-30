// @vitest-environment jsdom

/**
 * Client-mount tests for `AppShell` — the narrow-mode overlay's Escape
 * handling, dialog semantics, focus move and return, and keyboard shortcut.
 * jsdom has no `showModal`, never matches `:modal`, and ignores `inert` for
 * focus, so the modal bail stubs the `:modal` query and the inert ordering is
 * asserted at the moment focus returns rather than through a refused
 * `focus()`. jsdom also focuses elements CSS hides, so the focus move on open
 * is checked here for its target, not for the sidebar being visible by then —
 * that takes a real browser.
 *
 * @module
 */

import { describe, test, assert, vi, beforeEach, afterEach } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount, type ComponentProps } from 'svelte';
import { afterNavigate } from '$app/navigation';

import AppShell from '$lib/ui/AppShell.svelte';
import { SidebarState } from '$lib/ui/sidebar_state.svelte.ts';
import { stub_match_media, type MatchMediaStub } from './svelte_client_test_helpers.ts';

// vitest resolves the server builds, which can't mount — load the client builds
vi.mock('svelte', async () =>
	(await import('./svelte_client_test_helpers.ts')).import_svelte_client('.')
);
vi.mock('svelte/reactivity', async () =>
	(await import('./svelte_client_test_helpers.ts')).import_svelte_client('./reactivity')
);
vi.mock('$app/navigation', () => ({ afterNavigate: vi.fn() }));

// --- test helpers ---

const children = createRawSnippet(() => ({
	render: () => '<div><button type="button" class="opener">open</button></div>'
}));
const sidebar = createRawSnippet(() => ({
	render: () => '<nav><a href="#here" class="link">here</a></nav>'
}));

interface MountedShell {
	root: HTMLElement;
	sidebar_state: SidebarState;
	opener: HTMLButtonElement;
	link: HTMLAnchorElement;
	content: HTMLElement;
}

let media: MatchMediaStub;
let cleanups: Array<() => void> = [];

/** Mounts a shell whose state is created after the `matchMedia` stub, so it sees `media`. */
const mount_shell = (props?: Partial<ComponentProps<typeof AppShell>>): MountedShell => {
	const target = document.createElement('div');
	document.body.append(target);
	const sidebar_state = props?.sidebar_state ?? new SidebarState();
	const component = mount(AppShell, {
		target,
		props: { children, sidebar, ...props, sidebar_state }
	});
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
	return {
		root: query('.app-shell'),
		sidebar_state,
		opener: query('.opener'),
		link: query('.link'),
		content: query('.app-shell-content')
	};
};

/** Dispatches a bubbling, cancelable `keydown` from the focused element and returns it. */
const press = (key: string): KeyboardEvent => {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	(document.activeElement ?? document.body).dispatchEvent(event);
	return event;
};

/** Opens the overlay with focus on `opener` (or nothing), which moves focus to the sidebar's link. */
const open_overlay = (shell: MountedShell, opener: HTMLElement | null): void => {
	if (opener) opener.focus();
	else (document.activeElement as HTMLElement | null)?.blur();
	shell.sidebar_state.toggle_sidebar(true);
	flushSync();
	assert.isTrue(shell.content.inert, 'overlay should be open');
	assert.strictEqual(document.activeElement, shell.link, 'opening should focus the link');
};

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

describe('AppShell Escape', () => {
	test('closes the open overlay without preventing the default', () => {
		const shell = mount_shell();
		open_overlay(shell, shell.opener);
		const event = press('Escape');
		assert.isFalse(shell.sidebar_state.show_sidebar_narrow);
		assert.isFalse(shell.content.inert);
		assert.isFalse(event.defaultPrevented, 'the browser close request must stay intact');
	});

	test('is left to an open modal dialog', () => {
		const shell = mount_shell();
		open_overlay(shell, shell.opener);
		const dialog = document.createElement('dialog');
		// jsdom never matches `:modal`; other selectors resolve as usual
		vi.spyOn(document, 'querySelector').mockImplementation((selector: string) =>
			selector === ':modal' ? dialog : (document.querySelectorAll(selector)[0] ?? null)
		);
		press('Escape');
		assert.isTrue(shell.sidebar_state.show_sidebar_narrow);
	});

	test('is left to a window listener registered before the overlay opened', () => {
		const shell = mount_shell();
		// like a contextmenu mounted with the page, which swallows Escape
		const swallow_escape = (e: KeyboardEvent): void => {
			if (e.key !== 'Escape') return;
			e.preventDefault();
			e.stopImmediatePropagation();
		};
		window.addEventListener('keydown', swallow_escape);
		cleanups.push(() => window.removeEventListener('keydown', swallow_escape));
		open_overlay(shell, shell.opener);
		press('Escape');
		assert.isTrue(shell.sidebar_state.show_sidebar_narrow);
		window.removeEventListener('keydown', swallow_escape);
		press('Escape');
		assert.isFalse(shell.sidebar_state.show_sidebar_narrow);
	});

	test('the keydown listener exists only while the overlay is open', () => {
		const shell = mount_shell();
		const add = vi.spyOn(window, 'addEventListener');
		const remove = vi.spyOn(window, 'removeEventListener');
		const keydown_calls = (spy: typeof add | typeof remove): Array<unknown> =>
			spy.mock.calls.filter(([type]) => type === 'keydown').map(([, listener]) => listener);
		shell.sidebar_state.toggle_sidebar(true);
		flushSync();
		const added = keydown_calls(add);
		assert.strictEqual(added.length, 1);
		assert.deepEqual(keydown_calls(remove), []);
		shell.sidebar_state.close_narrow();
		flushSync();
		assert.deepEqual(keydown_calls(remove), added);
	});

	test('does nothing at wide widths', () => {
		media.set_matches(false);
		const shell = mount_shell();
		const add = vi.spyOn(window, 'addEventListener');
		shell.sidebar_state.show_sidebar_narrow = true;
		flushSync();
		assert.deepEqual(
			add.mock.calls.filter(([type]) => type === 'keydown'),
			[],
			'no Escape listener outside narrow mode'
		);
		press('Escape');
		assert.isTrue(shell.sidebar_state.show_sidebar_narrow);
		assert.isTrue(shell.sidebar_state.show_sidebar_wide);
	});
});

describe('AppShell focus return', () => {
	test('returns to an opener in the content once it is no longer inert', () => {
		const shell = mount_shell();
		open_overlay(shell, shell.opener);
		let inert_at_focus: boolean | undefined;
		const focus = shell.opener.focus.bind(shell.opener);
		vi.spyOn(shell.opener, 'focus').mockImplementation((options) => {
			inert_at_focus = shell.content.inert;
			focus(options);
		});
		press('Escape');
		assert.strictEqual(document.activeElement, shell.opener);
		assert.isFalse(inert_at_focus);
	});

	test('returns when focus fell to the body after opening from the content', () => {
		const shell = mount_shell();
		shell.opener.focus();
		shell.sidebar_state.toggle_sidebar(true);
		flushSync();
		// as when the control focus moved to is removed from the sidebar
		(document.activeElement as HTMLElement).blur();
		assert.strictEqual(document.activeElement, document.body);
		press('Escape');
		assert.isFalse(shell.sidebar_state.show_sidebar_narrow);
		assert.strictEqual(document.activeElement, shell.opener);
	});

	test('falls back to the built-in toggle without an opener', () => {
		const shell = mount_shell();
		open_overlay(shell, null);
		press('Escape');
		const toggle = shell.root.querySelector('.app-shell-toggle');
		assert.ok(toggle);
		assert.strictEqual(document.activeElement, toggle);
	});

	test('falls back to the toggle when the opener is gone', () => {
		const shell = mount_shell();
		open_overlay(shell, shell.opener);
		shell.opener.remove();
		press('Escape');
		assert.strictEqual(document.activeElement, shell.root.querySelector('.app-shell-toggle'));
	});

	test('skips a toggle that does not take focus', () => {
		const toggle_button = createRawSnippet<[{ sidebar_id: string }]>((args) => ({
			render: () =>
				`<span><button type="button" class="dead-toggle" aria-controls="${args().sidebar_id}" disabled>x</button><button type="button" class="live-toggle" aria-controls="${args().sidebar_id}">t</button></span>`
		}));
		const shell = mount_shell({ toggle_button });
		open_overlay(shell, null);
		press('Escape');
		assert.strictEqual(document.activeElement, shell.root.querySelector('.live-toggle'));
	});

	test('falls back to a custom toggle wired with sidebar_id', () => {
		const toggle_button = createRawSnippet<[{ sidebar_id: string }]>((args) => ({
			render: () =>
				`<button type="button" class="app-shell-toggle custom-toggle" aria-controls="${args().sidebar_id}">t</button>`
		}));
		const shell = mount_shell({ toggle_button });
		open_overlay(shell, null);
		press('Escape');
		assert.strictEqual(document.activeElement, shell.root.querySelector('.custom-toggle'));
	});

	test("falls back to a toggle outside the shell wired to the state's sidebar_id", () => {
		const sidebar_state = new SidebarState({ sidebar_id: 'site-menu' });
		const shell = mount_shell({ sidebar_state, show_toggle: false });
		const outside = document.createElement('button');
		// `aria-controls` is an id list
		outside.setAttribute('aria-controls', 'other site-menu');
		document.body.append(outside);
		cleanups.push(() => outside.remove());
		open_overlay(shell, null);
		press('Escape');
		assert.strictEqual(document.activeElement, outside);
	});

	test('an aria-controls id that only contains the sidebar id is no match', () => {
		const sidebar_state = new SidebarState({ sidebar_id: 'site-menu' });
		const shell = mount_shell({ sidebar_state, show_toggle: false });
		const decoy = document.createElement('button');
		decoy.setAttribute('aria-controls', 'site-menu-extra');
		const outside = document.createElement('button');
		outside.setAttribute('aria-controls', 'site-menu');
		document.body.append(decoy, outside);
		cleanups.push(() => {
			decoy.remove();
			outside.remove();
		});
		open_overlay(shell, null);
		press('Escape');
		assert.strictEqual(document.activeElement, outside);
	});

	test('an element in the sidebar is never the opener', () => {
		const shell = mount_shell();
		// jsdom ignores the closed sidebar's `visibility: hidden`, so its link takes focus
		shell.link.focus();
		shell.sidebar_state.toggle_sidebar(true);
		flushSync();
		press('Escape');
		assert.strictEqual(document.activeElement, shell.root.querySelector('.app-shell-toggle'));
	});

	test('a scrim click returns focus to the opener', () => {
		const shell = mount_shell();
		open_overlay(shell, shell.opener);
		shell.root.querySelector<HTMLElement>('.app-shell-scrim')?.click();
		assert.isFalse(shell.sidebar_state.show_sidebar_narrow);
		assert.strictEqual(document.activeElement, shell.opener);
	});

	test('a scrim click falls back to the toggle without an opener', () => {
		const shell = mount_shell();
		open_overlay(shell, null);
		shell.root.querySelector<HTMLElement>('.app-shell-scrim')?.click();
		assert.isFalse(shell.sidebar_state.show_sidebar_narrow);
		assert.strictEqual(document.activeElement, shell.root.querySelector('.app-shell-toggle'));
	});

	test('leaves focus alone when it was outside the sidebar', () => {
		const shell = mount_shell();
		open_overlay(shell, shell.opener);
		const outside = document.createElement('button');
		document.body.append(outside);
		cleanups.push(() => outside.remove());
		outside.focus();
		press('Escape');
		assert.isFalse(shell.sidebar_state.show_sidebar_narrow);
		assert.strictEqual(document.activeElement, outside);
	});
});

describe('AppShell overlay dialog', () => {
	/** Mounts a shell whose sidebar renders `html`, and opens the overlay from the content. */
	const open_with_sidebar = (
		html: string,
		props?: Partial<ComponentProps<typeof AppShell>>
	): MountedShell & { sidebar_el: HTMLElement } => {
		const shell = mount_shell({
			sidebar: createRawSnippet(() => ({
				render: () => `<nav>${html}<a href="#here" class="link">here</a></nav>`
			})),
			...props
		});
		shell.opener.focus();
		shell.sidebar_state.toggle_sidebar(true);
		flushSync();
		const sidebar_el = shell.root.querySelector<HTMLElement>('.app-shell-sidebar');
		assert.ok(sidebar_el);
		return { ...shell, sidebar_el };
	};

	test('opening moves focus to the first control in the sidebar', () => {
		const shell = open_with_sidebar('');
		assert.strictEqual(document.activeElement, shell.link);
	});

	test('skips a control that refuses focus and one only script can focus', () => {
		const shell = open_with_sidebar(
			'<button type="button" disabled>off</button><span tabindex="-1">script only</span>'
		);
		assert.strictEqual(document.activeElement, shell.link);
	});

	test('falls back to the sidebar itself when nothing in it takes focus', () => {
		// an anchor without `href` takes no focus
		const shell = mount_shell({
			sidebar: createRawSnippet(() => ({ render: () => '<p><a class="link">no href</a></p>' }))
		});
		shell.opener.focus();
		shell.sidebar_state.toggle_sidebar(true);
		flushSync();
		assert.strictEqual(document.activeElement, shell.root.querySelector('.app-shell-sidebar'));
	});

	test('Escape from the sidebar itself returns focus to the opener', () => {
		const shell = mount_shell({
			sidebar: createRawSnippet(() => ({ render: () => '<p><a class="link">no href</a></p>' }))
		});
		shell.opener.focus();
		shell.sidebar_state.toggle_sidebar(true);
		flushSync();
		press('Escape');
		assert.strictEqual(document.activeElement, shell.opener);
	});

	test('the open overlay is a named modal dialog, and only while open', () => {
		const shell = open_with_sidebar('', { sidebar_label: 'menu' });
		assert.strictEqual(shell.sidebar_el.getAttribute('role'), 'dialog');
		assert.strictEqual(shell.sidebar_el.getAttribute('aria-modal'), 'true');
		assert.strictEqual(shell.sidebar_el.getAttribute('aria-label'), 'menu');
		assert.strictEqual(shell.sidebar_el.getAttribute('tabindex'), '-1');
		press('Escape');
		flushSync();
		assert.isNull(shell.sidebar_el.getAttribute('role'));
		assert.isNull(shell.sidebar_el.getAttribute('aria-modal'));
		assert.isNull(shell.sidebar_el.getAttribute('aria-label'));
		assert.isNull(shell.sidebar_el.getAttribute('tabindex'));
	});

	test('the label defaults to the toggle name', () => {
		const shell = open_with_sidebar('');
		assert.strictEqual(shell.sidebar_el.getAttribute('aria-label'), 'sidebar');
	});

	test('the wide sidebar is a plain element and opening it leaves focus alone', () => {
		media.set_matches(false);
		const shell = mount_shell();
		shell.sidebar_state.show_sidebar_wide = false;
		flushSync();
		shell.opener.focus();
		shell.sidebar_state.toggle_sidebar(true);
		flushSync();
		assert.strictEqual(document.activeElement, shell.opener);
		const sidebar_el = shell.root.querySelector('.app-shell-sidebar');
		assert.isNull(sidebar_el?.getAttribute('role'));
		assert.isNull(sidebar_el?.getAttribute('tabindex'));
	});
});

describe('AppShell overlay dismissal', () => {
	test('widening out of narrow mode closes the overlay and keeps the wide preference', () => {
		const shell = mount_shell();
		shell.sidebar_state.show_sidebar_wide = false;
		shell.sidebar_state.toggle_sidebar(true);
		flushSync();
		media.set_matches(false);
		flushSync();
		assert.isFalse(shell.sidebar_state.show_sidebar_narrow);
		assert.isFalse(shell.sidebar_state.show_sidebar_wide);
		assert.isFalse(shell.content.inert);
		const sidebar_el = shell.root.querySelector('.app-shell-sidebar');
		assert.isNull(sidebar_el?.getAttribute('role'));
		assert.isNull(sidebar_el?.getAttribute('tabindex'));
	});

	test('navigation closes the overlay and leaves focus to the router', () => {
		const shell = mount_shell();
		open_overlay(shell, shell.opener);
		const on_navigate = vi.mocked(afterNavigate).mock.lastCall?.[0];
		assert.ok(on_navigate);
		on_navigate({} as Parameters<typeof on_navigate>[0]);
		flushSync();
		assert.isFalse(shell.sidebar_state.show_sidebar_narrow);
		// SvelteKit resets focus after navigation, so the shell doesn't return it
		assert.strictEqual(document.activeElement, shell.link);
	});

	test('a scrim click closes the overlay', () => {
		const shell = mount_shell();
		shell.sidebar_state.toggle_sidebar(true);
		flushSync();
		shell.root.querySelector<HTMLElement>('.app-shell-scrim')?.click();
		assert.isFalse(shell.sidebar_state.show_sidebar_narrow);
	});
});

describe('AppShell keyboard shortcut', () => {
	test('drives the overlay at narrow widths', () => {
		const shell = mount_shell({ keyboard_shortcut: 'b' });
		const event = press('b');
		assert.isTrue(shell.sidebar_state.show_sidebar_narrow);
		assert.isTrue(shell.sidebar_state.show_sidebar_wide);
		assert.isTrue(event.defaultPrevented);
	});

	test('opening the overlay moves focus into the sidebar, and closing returns it', () => {
		const shell = mount_shell({ keyboard_shortcut: 'b' });
		shell.opener.focus();
		press('b');
		flushSync();
		assert.strictEqual(document.activeElement, shell.link);
		press('b');
		assert.strictEqual(document.activeElement, shell.opener);
	});

	test('closing the overlay from inside the sidebar returns focus', () => {
		const shell = mount_shell({ keyboard_shortcut: 'b' });
		open_overlay(shell, shell.opener);
		assert.strictEqual(document.activeElement, shell.link);
		const event = press('b');
		assert.isFalse(shell.sidebar_state.show_sidebar_narrow);
		assert.isFalse(shell.content.inert);
		assert.strictEqual(document.activeElement, shell.opener);
		assert.isTrue(event.defaultPrevented);
	});

	test('toggles the persistent sidebar at wide widths without moving focus', () => {
		media.set_matches(false);
		const shell = mount_shell({ keyboard_shortcut: 'b' });
		shell.link.focus();
		press('b');
		assert.isFalse(shell.sidebar_state.show_sidebar_wide);
		assert.isFalse(shell.sidebar_state.show_sidebar_narrow);
		assert.strictEqual(document.activeElement, shell.link);
	});

	test('does nothing while a modal is open', () => {
		const shell = mount_shell({ keyboard_shortcut: 'b' });
		open_overlay(shell, shell.opener);
		const dialog = document.createElement('dialog');
		// jsdom never matches `:modal`; other selectors resolve as usual
		vi.spyOn(document, 'querySelector').mockImplementation((selector: string) =>
			selector === ':modal' ? dialog : (document.querySelectorAll(selector)[0] ?? null)
		);
		const event = press('b');
		assert.isTrue(shell.sidebar_state.show_sidebar_narrow);
		assert.isTrue(shell.content.inert);
		assert.isFalse(event.defaultPrevented);
	});

	test('does nothing at wide widths while a modal is open', () => {
		media.set_matches(false);
		const shell = mount_shell({ keyboard_shortcut: 'b' });
		const dialog = document.createElement('dialog');
		// jsdom never matches `:modal`; other selectors resolve as usual
		vi.spyOn(document, 'querySelector').mockImplementation((selector: string) =>
			selector === ':modal' ? dialog : (document.querySelectorAll(selector)[0] ?? null)
		);
		const event = press('b');
		assert.isTrue(shell.sidebar_state.show_sidebar_wide);
		assert.isFalse(shell.sidebar_state.show_sidebar_narrow);
		assert.isFalse(event.defaultPrevented);
	});

	test('does nothing while the sidebar is disabled', () => {
		const sidebar_state = new SidebarState();
		sidebar_state.enabled = false;
		const shell = mount_shell({ keyboard_shortcut: 'b', sidebar_state });
		const event = press('b');
		assert.isFalse(shell.sidebar_state.show_sidebar_narrow);
		assert.isTrue(shell.sidebar_state.show_sidebar_wide);
		assert.isFalse(event.defaultPrevented);
	});
});
