/**
 * Shared helpers for tests that drive Svelte's client runtime in jsdom:
 * loading the client builds that vitest doesn't resolve on its own, and a
 * `window.matchMedia` stub the test can flip.
 *
 * Not itself a test file — no `.test.` infix means vitest does not pick it up.
 *
 * @module
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';

type SvelteExportEntry = string | Record<string, string | undefined>;

/**
 * Imports the browser build of a `svelte` package export. vitest resolves
 * `svelte` and `svelte/reactivity` without the `browser` condition, so it gets
 * the server builds — no-op `flushSync`, no `mount`, and a `MediaQuery` that
 * never calls `matchMedia`. Use it from a `vi.mock` factory to swap them.
 *
 * @param subpath - the key in svelte's `exports` map, e.g. `'.'` or `'./reactivity'`
 * @returns the client module
 * @throws Error if the export has no `browser` condition
 */
export const import_svelte_client = async (subpath: string): Promise<Record<string, unknown>> => {
	const require = createRequire(import.meta.url);
	const pkg_json_path = require.resolve('svelte/package.json');
	const pkg_json = require(pkg_json_path) as { exports: Record<string, SvelteExportEntry> };
	const entry = pkg_json.exports[subpath];
	const browser_path = typeof entry === 'object' ? entry.browser : undefined;
	if (!browser_path) throw Error(`svelte export '${subpath}' has no browser condition`);
	return import(/* @vite-ignore */ join(dirname(pkg_json_path), browser_path));
};

export interface MatchMediaStub {
	/** Flips whether every stubbed query matches, notifying `change` listeners. */
	set_matches: (matches: boolean) => void;
	/** The queries passed to `window.matchMedia`, in call order. */
	queries: Array<string>;
}

/**
 * Installs a `window.matchMedia` stub whose single `matches` flag the test
 * controls. Each returned list is a real `EventTarget`, so `change` reaches
 * listeners the way a browser dispatches it. Pair with `vi.unstubAllGlobals()` in `afterEach`.
 */
export const stub_match_media = (): MatchMediaStub => {
	let matches = false;
	const lists: Array<EventTarget> = [];
	const queries: Array<string> = [];
	vi.stubGlobal('matchMedia', (query: string) => {
		queries.push(query);
		const list = Object.defineProperties(new EventTarget(), {
			media: { value: query },
			matches: { get: () => matches }
		});
		lists.push(list);
		return list;
	});
	return {
		set_matches: (value) => {
			matches = value;
			for (const list of lists) list.dispatchEvent(new Event('change'));
		},
		queries
	};
};
