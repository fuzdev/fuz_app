/**
 * Server-render tests for `AppShell` — the head narrow style, the scoped
 * base layer and unlayered offset rule (from the compiler's CSS output,
 * which `render` omits), the state classes, and the toggle's and the
 * sidebar's ARIA wiring.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, assert } from 'vitest';
import { createRawSnippet } from 'svelte';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

import AppShell from '$lib/ui/AppShell.svelte';
import { SIDEBAR_NARROW_QUERY_DEFAULT, SidebarState } from '$lib/ui/sidebar_state.svelte.ts';

const app_shell_path = fileURLToPath(new URL('../../lib/ui/AppShell.svelte', import.meta.url));

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

/** Extracts every `<style ...>...</style>` element from rendered HTML. */
const get_styles = (html: string): Array<{ open_tag: string; content: string }> =>
	Array.from(html.matchAll(/(<style[^>]*>)([\s\S]*?)<\/style>/g), (m) => ({
		open_tag: m[1]!,
		content: m[2]!
	}));

const LAYER_ORDER = '@layer fuz_app.app_shell_base, fuz_app.app_shell_narrow;';

interface CssDeclaration {
	/** The innermost enclosing rule's selector. */
	selector: string;
	property: string;
	value: string;
	/** The names of the enclosing `@layer` blocks, outermost first. */
	layers: Array<string>;
}

/**
 * Walks CSS text into its declarations with their selector and enclosing
 * layer blocks. Enough for the shell's own CSS — no strings or escapes
 * containing braces or semicolons.
 */
const parse_declarations = (css: string): Array<CssDeclaration> => {
	const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const stack: Array<string> = [];
	const declarations: Array<CssDeclaration> = [];
	let buffer = '';
	for (const char of code) {
		if (char === '{') {
			stack.push(buffer.trim());
			buffer = '';
		} else if (char === ';' || char === '}') {
			const text = buffer.trim();
			buffer = '';
			const colon = text.indexOf(':');
			const selector = stack.at(-1);
			if (selector !== undefined && !selector.startsWith('@') && colon > 0) {
				declarations.push({
					selector,
					property: text.slice(0, colon).trim(),
					value: text.slice(colon + 1).trim(),
					layers: stack
						.filter((prelude) => prelude.startsWith('@layer '))
						.map((prelude) => prelude.slice('@layer '.length).trim())
				});
			}
			if (char === '}') stack.pop();
		} else {
			buffer += char;
		}
	}
	return declarations;
};

/**
 * Properties the fuz_css reset sets (`box-sizing`, `border`, `margin`,
 * `padding`), longhands included. The reset is unlayered, so a layered
 * declaration of one of these always loses to it.
 */
const RESET_PROPERTY_PATTERN = /^(padding|margin|border|box-sizing)(-|$)/;

/** Asserts no layered declaration sets a property the reset owns. */
const assert_no_layered_reset_properties = (declarations: Array<CssDeclaration>): void => {
	const layered = declarations.filter((d) => d.layers.length > 0);
	assert.isNotEmpty(layered);
	const offending = layered.filter((d) => RESET_PROPERTY_PATTERN.test(d.property));
	assert.deepEqual(
		offending.map((d) => `${d.selector} { ${d.property} }`),
		[],
		'a layered declaration of a reset-owned property computes to the reset value'
	);
};

/** Asserts every glyph selector goes through the root's own toggle. */
const assert_glyph_selectors_scoped_to_own_toggle = (declarations: Array<CssDeclaration>): void => {
	const glyph_selectors = declarations
		.map((d) => d.selector)
		.filter((selector) => selector.includes('.app-shell-toggle-glyph'));
	assert.isNotEmpty(glyph_selectors);
	for (const selector of glyph_selectors) {
		assert.match(selector, /^\.app-shell[^ ]* > \.app-shell-toggle \.app-shell-toggle-glyph$/);
	}
};

describe('AppShell head styles', () => {
	test('default query emits exactly one style, the media one', () => {
		const styles = get_styles(render_shell().head);
		assert.strictEqual(styles.length, 1);
		assert.strictEqual(styles[0]!.open_tag, `<style media="${SIDEBAR_NARROW_QUERY_DEFAULT}">`);
	});

	test('the media style opens with the layer order and holds only the narrow layer', () => {
		const [style] = get_styles(render_shell().head);
		assert.ok(style);
		const content = style.content.trim();
		assert.isTrue(content.startsWith(LAYER_ORDER));
		const rest = content.slice(LAYER_ORDER.length).trim();
		assert.isTrue(rest.startsWith('@layer fuz_app.app_shell_narrow {'));
		assert.isTrue(rest.endsWith('}'));
		assert.strictEqual(rest.match(/@layer/g)?.length, 1);
		assert.isTrue(parse_declarations(style.content).every((d) => d.layers.length > 0));
	});

	test('no narrow declaration sets a property the reset owns', () => {
		const [style] = get_styles(render_shell().head);
		assert.ok(style);
		assert_no_layered_reset_properties(parse_declarations(style.content));
	});

	test("the narrow glyph rules go through the root's own toggle", () => {
		const [style] = get_styles(render_shell().head);
		assert.ok(style);
		assert_glyph_selectors_scoped_to_own_toggle(parse_declarations(style.content));
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

	test('null query emits no style', () => {
		const { head } = render_shell(new SidebarState({ narrow_query: null }));
		assert.deepEqual(get_styles(head), []);
	});
});

describe('AppShell scoped style', () => {
	const { css } = compile(readFileSync(app_shell_path, 'utf-8'), {
		filename: app_shell_path,
		generate: 'server'
	});

	test('declares the layer order and holds every layered rule in the base layer', () => {
		assert.ok(css);
		const code = css.code.replace(/\/\*[\s\S]*?\*\//g, '').trim();
		assert.isTrue(code.startsWith(LAYER_ORDER));
		const layer_blocks = Array.from(code.matchAll(/@layer ([^{;]+)\{/g), (m) => m[1]!.trim());
		assert.deepEqual(layer_blocks, ['fuz_app.app_shell_base']);
	});

	test('no layered declaration sets a property the reset owns', () => {
		assert.ok(css);
		assert_no_layered_reset_properties(parse_declarations(css.code));
	});

	test('the only unlayered declaration reads the content offset into padding-left', () => {
		assert.ok(css);
		const unlayered = parse_declarations(css.code).filter((d) => d.layers.length === 0);
		assert.deepEqual(unlayered, [
			{
				selector: 'div:where(.app-shell > .app-shell-content)',
				property: 'padding-left',
				value: 'var(--sidebar_offset, 0px)',
				layers: []
			}
		]);
	});

	test('the layers set the offset custom property in both modes', () => {
		assert.ok(css);
		const [style] = get_styles(render_shell().head);
		assert.ok(style);
		const offsets = [...parse_declarations(css.code), ...parse_declarations(style.content)]
			.filter((d) => d.property === '--sidebar_offset')
			.map((d) => [d.layers.join(' '), d.value]);
		assert.deepEqual(offsets, [
			['fuz_app.app_shell_base', '0px'],
			['fuz_app.app_shell_base', 'var(--sidebar_width)'],
			['fuz_app.app_shell_narrow', '0px']
		]);
	});

	test('rules reaching consumer markup are unscoped under the scoped root', () => {
		assert.ok(css);
		assert.match(css.code, /\.app-shell\.svelte-[a-z0-9]+ > \.app-shell-toggle \{/);
		assert.match(
			css.code,
			/\.app-shell\.svelte-[a-z0-9]+ > \.app-shell-toggle \.app-shell-toggle-glyph \{/
		);
		assert.match(css.code, /\.app-shell-sidebar\.svelte-[a-z0-9]+ :modal \{/);
	});

	test('the content floor is the small viewport height', () => {
		assert.ok(css);
		const floors = parse_declarations(css.code).filter((d) => d.property === 'min-height');
		assert.lengthOf(floors, 1);
		const [floor] = floors;
		assert.match(floor!.selector, /^\.app-shell-content\.svelte-[a-z0-9]+$/);
		assert.strictEqual(floor!.value, '100svh');
	});

	test("the base glyph rules go through the root's own toggle", () => {
		assert.ok(css);
		assert_glyph_selectors_scoped_to_own_toggle(parse_declarations(css.code));
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

	test("the state's sidebar_id names the sidebar and the toggle's aria-controls", () => {
		const { body } = render_shell(new SidebarState({ sidebar_id: 'site-menu' }));
		assert.include(get_tag(body, 'app-shell-sidebar'), 'id="site-menu"');
		assert.include(get_tag(body, 'app-shell-toggle'), 'aria-controls="site-menu"');
	});

	test('the closed sidebar is a plain element, no dialog and not focusable', () => {
		const sidebar_tag = get_tag(render_shell().body, 'app-shell-sidebar');
		assert.notInclude(sidebar_tag, 'role=');
		assert.notInclude(sidebar_tag, 'aria-modal');
		assert.notInclude(sidebar_tag, 'aria-label');
		assert.notInclude(sidebar_tag, 'tabindex');
	});

	test('an open narrow state still renders no dialog, which keys on the viewport', () => {
		const sidebar_state = new SidebarState();
		sidebar_state.show_sidebar_narrow = true;
		const { body } = render(AppShell, {
			props: { children, sidebar, sidebar_state, sidebar_label: 'menu' }
		});
		assert.isTrue(has_class(get_tag(body, 'app-shell'), 'narrow-open'));
		const sidebar_tag = get_tag(body, 'app-shell-sidebar');
		assert.notInclude(sidebar_tag, 'role=');
		assert.notInclude(sidebar_tag, 'aria-modal');
		assert.notInclude(sidebar_tag, 'aria-label');
		assert.notInclude(sidebar_tag, 'tabindex');
	});

	test("a custom toggle receives the state's sidebar_id", () => {
		const toggle_button = createRawSnippet<[{ sidebar_id: string }]>((args) => ({
			render: () => `<button class="custom-toggle" aria-controls="${args().sidebar_id}">t</button>`
		}));
		const { body } = render(AppShell, {
			props: {
				children,
				sidebar,
				sidebar_state: new SidebarState({ sidebar_id: 'site-menu' }),
				toggle_button
			}
		});
		assert.include(get_tag(body, 'custom-toggle'), 'aria-controls="site-menu"');
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
