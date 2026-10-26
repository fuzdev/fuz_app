import { assert, beforeAll, describe, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
	describe_spine_cross_suites,
	STANDALONE_CROSS_SUITES,
	SUITE_NAMES,
	type SpineCrossSuitesOptions,
	type SuiteName
} from '#lib/testing/cross_backend/spine_suites.ts';
import type { BackendCapabilities } from '#lib/testing/cross_backend/capabilities.ts';
import type { ReconstructedBootstrappedBackendHandle } from '#lib/testing/cross_backend/setup.ts';

const CROSS_BACKEND_DIR = fileURLToPath(
	new URL('../../../lib/testing/cross_backend/', import.meta.url)
);

/**
 * The adapters that load only on their own runtime (they read `Bun` / `Deno` at
 * module scope), so the guard can't import them under Node. Their source must
 * not name a `describe_` identifier at all, whatever the export form.
 */
const RUNTIME_BOUND_MODULES: ReadonlySet<string> = new Set([
	'testing_server_bun.ts',
	'testing_server_deno.ts'
]);

/**
 * Every module under `testing/cross_backend/` that exports a `describe_*`
 * function, by name, read from the loaded module's exports — so the export
 * form (`export const`, `export function`, an export list) doesn't matter.
 */
const load_suite_modules = async (dir: string): Promise<Map<string, Array<string>>> => {
	const modules: Map<string, Array<string>> = new Map();
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith('.ts') || file === 'spine_suites.ts') continue;
		if (RUNTIME_BOUND_MODULES.has(file)) {
			assert.notMatch(
				readFileSync(dir + file, 'utf8'),
				/\bdescribe_\w/,
				`${file} loads only on its own runtime, so it must not define a suite`
			);
			continue;
		}
		const mod = (await import(dir + file)) as Record<string, unknown>;
		const suites = Object.keys(mod).filter(
			(key) => key.startsWith('describe_') && typeof mod[key] === 'function'
		);
		if (suites.length > 0) modules.set(file.slice(0, -'.ts'.length), suites);
	}
	return modules;
};

describe('the spine suite registry', () => {
	let modules: Map<string, Array<string>> = new Map();
	beforeAll(async () => {
		modules = await load_suite_modules(CROSS_BACKEND_DIR);
	}, 60_000);

	test('every module exporting a describe_* suite is registered or standalone', () => {
		const known = new Set<string>([...SUITE_NAMES, ...Object.keys(STANDALONE_CROSS_SUITES)]);
		const unregistered = [...modules.keys()].filter((name) => !known.has(name));
		assert.deepEqual(
			unregistered,
			[],
			'add each to SUITE_NAMES (spine_suites.ts) or STANDALONE_CROSS_SUITES with why'
		);
	});

	test('every registered and standalone name is a module exporting a suite', () => {
		for (const name of [...SUITE_NAMES, ...Object.keys(STANDALONE_CROSS_SUITES)]) {
			assert.ok(modules.has(name), `'${name}' names no module exporting a describe_* suite`);
		}
	});

	test('each registered module exports exactly one suite', () => {
		for (const name of SUITE_NAMES) {
			assert.strictEqual(modules.get(name)?.length, 1, `${name}: ${modules.get(name)?.join(', ')}`);
		}
	});

	test('no suite is both registered and standalone', () => {
		for (const name of Object.keys(STANDALONE_CROSS_SUITES)) {
			assert.ok(!(SUITE_NAMES as ReadonlyArray<string>).includes(name), name);
		}
	});

	test('every standalone suite states why', () => {
		for (const [name, reason] of Object.entries(STANDALONE_CROSS_SUITES)) {
			assert.ok(reason.trim().length > 0, name);
		}
	});
});

describe('describe_spine_cross_suites option validation', () => {
	// validation runs before any suite registers, so a stub handle and surface do
	const handle = {
		config: { capabilities: {}, env: {} }
	} as unknown as ReconstructedBootstrappedBackendHandle;
	const base = {} as SpineCrossSuitesOptions;
	const call = (options: Partial<SpineCrossSuitesOptions>) => () =>
		describe_spine_cross_suites(handle, { ...base, ...options });

	test('an exclude needs a reason', () => {
		assert.throws(call({ exclude: { ready: '' } }), /exclude 'ready' needs a reason/);
		assert.throws(call({ exclude: { ready: '  ' } }), /exclude 'ready' needs a reason/);
	});

	test('an unknown suite name is refused', () => {
		assert.throws(
			call({ exclude: { not_a_suite: 'x' } as SpineCrossSuitesOptions['exclude'] }),
			/exclude names unknown suite 'not_a_suite'/
		);
		assert.throws(
			call({ overrides: { not_a_suite: {} } as SpineCrossSuitesOptions['overrides'] }),
			/overrides names unknown suite 'not_a_suite'/
		);
	});

	test('a suite cannot be both excluded and overridden', () => {
		assert.throws(
			call({ exclude: { ready: 'no /ready' }, overrides: { ready: {} } }),
			/'ready' is both excluded and overridden/
		);
	});
});

describe('describe_spine_cross_suites required options', () => {
	// every suite but `only` excluded, so the one left fails its check before
	// anything registers
	const capabilities = { ws: false } as unknown as BackendCapabilities;
	const handle = {
		config: { capabilities, env: {}, cookie_name: 'fuz_session' }
	} as unknown as ReconstructedBootstrappedBackendHandle;
	const only = (
		name: SuiteName,
		overrides?: SpineCrossSuitesOptions['overrides']
	): SpineCrossSuitesOptions =>
		({
			exclude: Object.fromEntries(
				SUITE_NAMES.filter((n) => n !== name).map((n) => [n, 'not under test'])
			),
			overrides
		}) as unknown as SpineCrossSuitesOptions;

	test('an override that clears a required option throws, naming suite and key', () => {
		assert.throws(
			() =>
				describe_spine_cross_suites(handle, only('ready', { ready: { setup_test: undefined } })),
			/'ready' needs `setup_test`/
		);
	});

	test('an input the handle lacks and no override gives throws', () => {
		assert.throws(
			() => describe_spine_cross_suites(handle, only('session_cookie_codec')),
			/'session_cookie_codec' needs `cookie_keys`/
		);
	});

	test('a function override receives the derived options', () => {
		let received: unknown;
		assert.throws(
			() =>
				describe_spine_cross_suites(
					handle,
					only('ready', {
						ready: (derived) => {
							received = derived;
							return { setup_test: undefined };
						}
					})
				),
			/'ready' needs `setup_test`/
		);
		const derived = received as { setup_test?: unknown; capabilities?: unknown };
		assert.strictEqual(typeof derived.setup_test, 'function');
		assert.strictEqual(derived.capabilities, capabilities);
	});
});
