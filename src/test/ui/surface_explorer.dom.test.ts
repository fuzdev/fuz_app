// @vitest-environment jsdom

/**
 * Client-mount tests for `SurfaceExplorer` — expandable rows open from a
 * disclosure button in their first cell, so they work from the keyboard.
 *
 * @module
 */

import { describe, test, assert, vi, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import SurfaceExplorer from '#lib/ui/SurfaceExplorer.svelte';
import type { AppSurface } from '#lib/http/surface.ts';

// vitest resolves the server builds, which can't mount — load the client builds
vi.mock('svelte', async () =>
	(await import('./svelte_client_test_helpers.ts')).import_svelte_client('.')
);

const surface: AppSurface = {
	middleware: [],
	routes: [
		{
			method: 'GET',
			path: '/health',
			auth: { account: 'none', actor: 'none' },
			applicable_middleware: [],
			description: 'Health check',
			is_mutation: false,
			transaction: false,
			raw_body: false,
			rate_limit_key: null,
			params_schema: null,
			query_schema: null,
			input_schema: null,
			output_schema: { type: 'object', properties: { status_marker: { type: 'string' } } },
			error_schemas: null
		}
	],
	env: [],
	rpc_endpoints: [],
	ws_endpoints: [],
	events: [],
	diagnostics: []
};

let cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups) cleanup();
	cleanups = [];
});

const mount_explorer = (): HTMLElement => {
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(SurfaceExplorer, { target, props: { surface } });
	cleanups.push(() => {
		void unmount(component);
		target.remove();
	});
	flushSync();
	return target;
};

describe('SurfaceExplorer route expander', () => {
	test('is a disclosure button in the first cell that toggles the details row', () => {
		const target = mount_explorer();
		const button = target.querySelector<HTMLButtonElement>(
			'td:first-child > button[aria-expanded]'
		);
		assert.ok(button, 'the first cell holds the expander');
		assert.strictEqual(button.type, 'button');
		assert.strictEqual(button.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(button.getAttribute('aria-label'), 'GET /health details');
		assert.notInclude(target.textContent, 'status_marker');

		button.click();
		flushSync();
		assert.strictEqual(button.getAttribute('aria-expanded'), 'true');
		assert.include(target.textContent, 'status_marker');

		button.click();
		flushSync();
		assert.strictEqual(button.getAttribute('aria-expanded'), 'false');
		assert.notInclude(target.textContent, 'status_marker');
	});

	test('the row itself is not a click target', () => {
		const target = mount_explorer();
		const cell = target.querySelector<HTMLElement>('tbody td:nth-child(2)');
		assert.ok(cell);
		cell.click();
		flushSync();
		assert.notInclude(target.textContent, 'status_marker');
	});
});
