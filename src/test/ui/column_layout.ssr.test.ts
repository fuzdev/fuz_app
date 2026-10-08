/**
 * Server-render tests for `ColumnLayout` - the stacked toggle's ARIA wiring,
 * the aside's id and accessible name, and the container query in the
 * compiler's CSS output, which `render` omits.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, assert } from 'vitest';
import { createRawSnippet } from 'svelte';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

import ColumnLayout from '$lib/ui/ColumnLayout.svelte';

const column_layout_path = fileURLToPath(
	new URL('../../lib/ui/ColumnLayout.svelte', import.meta.url)
);

const children = createRawSnippet(() => ({ render: () => '<p>content</p>' }));
const aside = createRawSnippet(() => ({ render: () => '<nav>links</nav>' }));

/** Extracts the opening tag of the first element carrying `class_name` as a whole token. */
const get_tag = (html: string, class_name: string): string => {
	const match = new RegExp(
		`<[a-z]+[^>]*\\sclass="(?:[^"]*\\s)?${class_name}(?:\\s[^"]*)?"[^>]*>`
	).exec(html);
	assert.ok(match, `expected an element with class ${class_name}`);
	return match[0];
};

const get_attribute = (tag: string, name: string): string | undefined =>
	new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

describe('ColumnLayout markup', () => {
	test('the toggle starts collapsed and controls the aside', () => {
		const { body } = render(ColumnLayout, { props: { children, aside } });
		const toggle = get_tag(body, 'column-toggle');
		const aside_tag = get_tag(body, 'column-fixed');
		assert.include(toggle, 'type="button"');
		assert.strictEqual(get_attribute(toggle, 'aria-expanded'), 'false');
		const controls = get_attribute(toggle, 'aria-controls');
		assert.ok(controls);
		assert.strictEqual(controls, get_attribute(aside_tag, 'id'));
		assert.isTrue(aside_tag.startsWith('<aside'));
		assert.notInclude(get_tag(body, 'column-layout-body'), 'aside-open');
	});

	test('the toggle precedes the aside in DOM order', () => {
		const { body } = render(ColumnLayout, { props: { children, aside } });
		assert.isBelow(body.indexOf('column-toggle'), body.indexOf('<aside'));
	});

	test('the default aside_label names the toggle and the aside', () => {
		const { body } = render(ColumnLayout, { props: { children, aside } });
		assert.strictEqual(get_attribute(get_tag(body, 'column-fixed'), 'aria-label'), 'menu');
		assert.match(body, /<button[^>]*>\s*menu\s*<span/);
	});

	test('aside_label reaches the toggle text and the aside name', () => {
		const { body } = render(ColumnLayout, {
			props: { children, aside, aside_label: 'tables' }
		});
		assert.strictEqual(get_attribute(get_tag(body, 'column-fixed'), 'aria-label'), 'tables');
		assert.match(body, /<button[^>]*>\s*tables\s*<span/);
	});
});

describe('ColumnLayout scoped style', () => {
	const { css } = compile(readFileSync(column_layout_path, 'utf-8'), {
		filename: column_layout_path,
		generate: 'server'
	});

	test('the root is a named inline-size container', () => {
		assert.ok(css);
		assert.match(
			css.code,
			/\.column-layout\.svelte-[a-z0-9]+ \{[^}]*container: column_layout \/ inline-size;/
		);
	});

	test('the container query stacks and reveals the toggle below the threshold', () => {
		assert.ok(css);
		const start = css.code.indexOf('@container column_layout (width < 64rem) {');
		assert.isAtLeast(start, 0);
		const rule = css.code.slice(start);
		assert.match(rule, /\.column-layout-body\.svelte-[a-z0-9]+ \{[^}]*flex-direction: column;/);
		assert.match(rule, /\.column-toggle-bar\.svelte-[a-z0-9]+ \{[^}]*display: block;/);
		assert.match(
			rule,
			/:not\(\.aside-open\) > \.column-fixed:where\(\.svelte-[a-z0-9]+\) \{[^}]*display: none;/
		);
	});

	test('the toggle is hidden outside the container query', () => {
		assert.ok(css);
		const outside = css.code.slice(0, css.code.indexOf('@container'));
		assert.match(outside, /\.column-toggle-bar\.svelte-[a-z0-9]+ \{\s*display: none;/);
	});
});
