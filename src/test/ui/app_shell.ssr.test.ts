/**
 * Server-render tests for `AppShell` — the head mode styles, the state
 * classes, and the toggle's ARIA wiring.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';

import AppShell from '$lib/ui/AppShell.svelte';
import { SIDEBAR_NARROW_QUERY_DEFAULT, SidebarState } from '$lib/ui/sidebar_state.svelte.ts';

const children = createRawSnippet(() => ({ render: () => '<p>content</p>' }));
const sidebar = createRawSnippet(() => ({ render: () => '<nav>links</nav>' }));

const render_shell = (sidebar_state?: SidebarState): { head: string; body: string } =>
	render(AppShell, { props: { children, sidebar, sidebar_state } });

/**
 * Pattern for an opening tag whose class attribute carries `class_name` as a
 * whole token — `app-shell` must not match `app-shell-toggle`, which `\b`
 * would. Class names here are plain literals, so no escaping.
 */
const class_tag_pattern = (class_name: string): RegExp =>
	new RegExp(`<[a-z]+[^>]*\\sclass="(?:[^"]*\\s)?${class_name}(?:\\s[^"]*)?"[^>]*>`);

/** Extracts the opening tag of the first element carrying `class_name`. */
const get_tag = (html: string, class_name: string): string => {
	const match = class_tag_pattern(class_name).exec(html);
	assert.ok(match, `expected an element with class ${class_name}`);
	return match[0];
};

/** Whether an opening tag's class attribute carries `class_name` as a whole token. */
const has_class = (tag: string, class_name: string): boolean =>
	class_tag_pattern(class_name).test(tag);

describe('AppShell head styles', () => {
	test('default query emits a media style after the unconditional one', () => {
		const { head } = render_shell();
		const media_index = head.indexOf(`<style media="${SIDEBAR_NARROW_QUERY_DEFAULT}">`);
		const plain_index = head.indexOf('<style>');
		assert.isAtLeast(plain_index, 0);
		assert.isAbove(media_index, plain_index);
	});

	test('custom query appears in the media attribute', () => {
		const { head } = render_shell(new SidebarState({ narrow_query: '(max-width: 900px)' }));
		assert.include(head, '<style media="(max-width: 900px)">');
		assert.notInclude(head, SIDEBAR_NARROW_QUERY_DEFAULT);
	});

	test('a query with a quote is attribute-escaped', () => {
		const { head } = render_shell(new SidebarState({ narrow_query: '(max-width: 900px)"><x' }));
		assert.include(head, '<style media="(max-width: 900px)&quot;>&lt;x">');
		assert.notInclude(head, '"><x');
	});

	test('the toggle z-index and top-layer visibility rules are unconditional', () => {
		const { head } = render_shell(new SidebarState({ narrow_query: null }));
		assert.include(head, '.app-shell > .app-shell-toggle {');
		assert.include(head, '.app-shell-sidebar :modal {');
	});

	test('null query emits no media style', () => {
		const { head } = render_shell(new SidebarState({ narrow_query: null }));
		assert.include(head, '<style>');
		assert.notInclude(head, '<style media');
	});
});

describe('AppShell markup', () => {
	test('root is wide-open, not narrow-open', () => {
		const { body } = render_shell();
		const root = get_tag(body, 'app-shell');
		assert.isTrue(has_class(root, 'wide-open'));
		assert.isFalse(has_class(root, 'narrow-open'));
	});

	test('disabled renders neither state class and no toggle', () => {
		const state = new SidebarState();
		state.enabled = false;
		const { body } = render_shell(state);
		const root = get_tag(body, 'app-shell');
		assert.isFalse(has_class(root, 'wide-open'));
		assert.isFalse(has_class(root, 'narrow-open'));
		assert.notInclude(body, 'app-shell-toggle');
	});

	test('toggle aria-controls matches the sidebar id', () => {
		const { body } = render_shell();
		const toggle = get_tag(body, 'app-shell-toggle');
		const sidebar_tag = get_tag(body, 'app-shell-sidebar');
		const controls = /aria-controls="([^"]+)"/.exec(toggle)?.[1];
		const id = /\bid="([^"]+)"/.exec(sidebar_tag)?.[1];
		assert.ok(controls);
		assert.strictEqual(controls, id);
		assert.include(toggle, 'aria-expanded="true"');
	});

	test('toggle has a static accessible name and a dynamic title', () => {
		const toggle = get_tag(render_shell().body, 'app-shell-toggle');
		assert.include(toggle, 'aria-label="sidebar"');
		assert.include(toggle, 'title="hide sidebar"');
		assert.notInclude(toggle, 'aria-keyshortcuts');
	});

	test('toggle exposes the keyboard shortcut', () => {
		const { body } = render(AppShell, { props: { children, sidebar, keyboard_shortcut: 'b' } });
		const toggle = get_tag(body, 'app-shell-toggle');
		assert.include(toggle, 'aria-keyshortcuts="b"');
		assert.include(toggle, 'title="hide sidebar [b]"');
		assert.include(toggle, 'aria-label="sidebar"');
	});

	test('content is not inert and the scrim is hidden from assistive tech', () => {
		const { body } = render_shell();
		assert.notInclude(get_tag(body, 'app-shell-content'), 'inert');
		assert.include(get_tag(body, 'app-shell-scrim'), 'aria-hidden="true"');
	});

	test('consumer class merges onto the root', () => {
		const { body } = render(AppShell, { props: { children, sidebar, class: 'mine' } });
		assert.isTrue(has_class(get_tag(body, 'app-shell'), 'mine'));
	});
});
