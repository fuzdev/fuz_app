import { assert, beforeAll, describe, test, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
	describe_spine_cross_suites,
	get_spine_suite_backdoors,
	SPINE_SUITES_REQUIRED_BACKDOORS,
	STANDALONE_CROSS_SUITES,
	SUITE_NAMES,
	type SpineCrossSuitesOptions,
	type SuiteName
} from '#lib/testing/cross_backend/spine_suites.ts';
import type { BackendCapabilities } from '#lib/testing/cross_backend/capabilities.ts';
import type { ReconstructedBootstrappedBackendHandle } from '#lib/testing/cross_backend/setup.ts';
import {
	TESTING_BACKDOOR_METHODS,
	type TestingBackdoorMethod
} from '#lib/testing/cross_backend/spine_surface_constants.ts';

// `testing_backdoor` can't be excluded, so the calls below that run one suite
// alone also reach it — registering nothing keeps them collection-free
vi.mock('#lib/testing/cross_backend/testing_backdoor.ts', async (import_original) => ({
	...(await import_original<typeof import('#lib/testing/cross_backend/testing_backdoor.ts')>()),
	describe_testing_backdoor_cross_tests: () => {}
}));

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

describe('the spine suite backdoor declarations', () => {
	// the backdoor suite fires whatever the backend declares, so it names none itself
	const exempt: ReadonlySet<SuiteName> = new Set(['testing_backdoor']);
	const known: ReadonlySet<string> = new Set(TESTING_BACKDOOR_METHODS);

	test('every backdoor a suite module names is one its entry declares', () => {
		const undeclared: Array<string> = [];
		for (const name of SUITE_NAMES) {
			if (exempt.has(name)) continue;
			const source = readFileSync(`${CROSS_BACKEND_DIR}${name}.ts`, 'utf8');
			const allowed: Set<string> = new Set([
				...SPINE_SUITES_REQUIRED_BACKDOORS,
				...get_spine_suite_backdoors(name)
			]);
			// declaring `fact_serving` requires `_testing_put_fact`, so a suite
			// reading that flag may seed through it
			if (source.includes('capabilities.fact_serving')) allowed.add('_testing_put_fact');
			const named: ReadonlySet<string> = new Set([
				...[...source.matchAll(/['"`](_testing_\w+)['"`]/g)].map(([, m]) => m!),
				// a call through the action spec or a shared seeder quotes no name
				...[...source.matchAll(/\btesting_(\w+?)_action_spec\b/g)].map(([, m]) => `_testing_${m}`),
				...[...source.matchAll(/\bcross_(put_fact|drain_effects)\b/g)].map(
					([, m]) => `_testing_${m}`
				)
			]);
			for (const method of named) {
				if (known.has(method) && !allowed.has(method)) undeclared.push(`${name}: ${method}`);
			}
		}
		assert.deepEqual(
			undeclared,
			[],
			"add each to its SUITE_ENTRIES entry's backdoors, so a backend lacking it skips the suite"
		);
	});
});

describe('describe_spine_cross_suites option validation', () => {
	// validation runs before any suite registers, so a stub handle and surface do
	const handle = {
		config: { capabilities: { testing_backdoors: [] }, env: {} }
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

	test('an rpc_input_overrides key naming no mounted method throws', () => {
		const surface_source = {
			surface: { rpc_endpoints: [{ path: '/api/rpc', methods: [{ name: 'gizmo_get' }] }] }
		} as unknown as SpineCrossSuitesOptions['surface_source'];
		const live_rpc_endpoints = [
			{ path: '/api/rpc', actions: [{ spec: { method: 'gizmo_live' } }] }
		] as unknown as SpineCrossSuitesOptions['live_rpc_endpoints'];
		assert.throws(
			call({
				surface_source,
				live_rpc_endpoints,
				rpc_input_overrides: new Map([['gizmo_gte', {}]])
			}),
			/rpc_input_overrides names 'gizmo_gte', a method on neither/
		);
		// a method on only the declared surface or only the live mount passes the check
		for (const method of ['gizmo_get', 'gizmo_live']) {
			assert.throws(
				call({
					surface_source,
					live_rpc_endpoints,
					rpc_input_overrides: new Map([[method, {}]]),
					exclude: { ready: '' }
				}),
				/exclude 'ready' needs a reason/,
				method
			);
		}
	});

	test('a suite cannot be both excluded and overridden', () => {
		assert.throws(
			call({ exclude: { ready: 'no /ready' }, overrides: { ready: {} } }),
			/'ready' is both excluded and overridden/
		);
	});

	test('testing_backdoor cannot be excluded', () => {
		assert.throws(
			call({ exclude: { testing_backdoor: 'mounts few backdoors' } }),
			/'testing_backdoor' can't be excluded/
		);
	});
});

/** A stub handle whose backend declares `testing_backdoors`, plus `extra` capabilities. */
const handle_declaring = (
	testing_backdoors: ReadonlyArray<TestingBackdoorMethod>,
	extra: Partial<BackendCapabilities> = {}
): ReconstructedBootstrappedBackendHandle =>
	({
		config: { capabilities: { ws: false, ...extra, testing_backdoors }, env: {} }
	}) as unknown as ReconstructedBootstrappedBackendHandle;

/** The backdoors every one-call backend must declare, and nothing else. */
const HARNESS_ONLY: ReadonlyArray<TestingBackdoorMethod> = [
	'_testing_reset',
	'_testing_drain_effects'
];

describe('describe_spine_cross_suites backdoor declaration', () => {
	const base = {} as SpineCrossSuitesOptions;
	const call =
		(handle: ReconstructedBootstrappedBackendHandle, options: Partial<SpineCrossSuitesOptions>) =>
		() =>
			describe_spine_cross_suites(handle, { ...base, ...options });

	test('a backend missing a shared backdoor throws, naming it', () => {
		assert.throws(
			call(handle_declaring(['_testing_reset']), {}),
			/must declare _testing_drain_effects/
		);
		assert.throws(
			call(handle_declaring([]), {}),
			/must declare _testing_reset, _testing_drain_effects/
		);
	});

	test('fact_serving needs the fact seeder declared', () => {
		assert.throws(
			call(handle_declaring(HARNESS_ONLY, { fact_serving: true }), {}),
			/fact_serving needs _testing_put_fact/
		);
	});

	test('an exclude of a suite that skips itself for a backdoor is refused as redundant', () => {
		assert.throws(
			call(handle_declaring(HARNESS_ONLY), { exclude: { credential_deadline: 'no seam' } }),
			/exclude 'credential_deadline' is redundant — the suite skips itself \(needs `_testing_shorten_credential_expiry`/
		);
		// declared, the same exclude is an ordinary one: validation passes it, and
		// the next refusal is the next check's
		assert.throws(
			call(handle_declaring(TESTING_BACKDOOR_METHODS), {
				exclude: { credential_deadline: 'no seam', ready: '' }
			}),
			/exclude 'ready' needs a reason/
		);
	});

	test('an override of a suite that skips itself is refused', () => {
		assert.throws(
			call(handle_declaring(HARNESS_ONLY), { overrides: { ws_outbound_overflow: {} } }),
			/overrides names 'ws_outbound_overflow', which skips itself \(needs `_testing_flood_notifications`/
		);
	});

	test('testing_backdoor takes no exclude_cases and keeps the declaration', () => {
		assert.throws(
			call(handle_declaring(HARNESS_ONLY), {
				exclude_cases: {
					testing_backdoor: {
						'testing backdoor declaration > _testing_origin_check is undeclared → method_not_found':
							'mounted under its own auth'
					}
				}
			}),
			/exclude_cases can't name 'testing_backdoor'/
		);
		// every other suite excluded, so the override reaches the backdoor suite first
		const exclude = Object.fromEntries(
			SUITE_NAMES.filter(
				(n) =>
					n !== 'testing_backdoor' &&
					!['credential_deadline', 'origin_conformance', 'ws_outbound_overflow'].includes(n)
			).map((n) => [n, 'not under test'])
		);
		// out of sorted order, so a comparison that sorts one side only fails
		const declared: ReadonlyArray<TestingBackdoorMethod> = [
			'_testing_reset',
			'_testing_drain_effects',
			'_testing_mint_session'
		];
		const with_backdoors = (testing_backdoors: ReadonlyArray<TestingBackdoorMethod>) =>
			call(handle_declaring(declared), {
				exclude,
				overrides: {
					testing_backdoor: (d) => ({ capabilities: { ...d.capabilities, testing_backdoors } })
				}
			});
		// more, fewer, one swapped, one repeated in place of another, one repeated on top
		for (const testing_backdoors of [
			TESTING_BACKDOOR_METHODS,
			['_testing_reset', '_testing_drain_effects'],
			['_testing_reset', '_testing_drain_effects', '_testing_put_fact'],
			['_testing_reset', '_testing_reset', '_testing_drain_effects'],
			[...declared, '_testing_reset']
		] satisfies Array<ReadonlyArray<TestingBackdoorMethod>>) {
			assert.throws(
				with_backdoors(testing_backdoors),
				/overrides can't change 'testing_backdoor' capabilities.testing_backdoors/,
				undefined,
				testing_backdoors.join(', ')
			);
		}
		// the same list in another order passes the check
		let refusal = '';
		try {
			with_backdoors(['_testing_mint_session', '_testing_reset', '_testing_drain_effects'])();
		} catch (error) {
			// past the check, registration refuses a call made inside a test
			refusal = String(error);
		}
		assert.notMatch(refusal, /can't change/);
	});
});

describe('describe_spine_cross_suites exclude_cases validation', () => {
	const handle = handle_declaring(HARNESS_ONLY);
	const call = (options: Partial<SpineCrossSuitesOptions>) => () =>
		describe_spine_cross_suites(handle, options as SpineCrossSuitesOptions);

	test('an unknown suite is refused', () => {
		assert.throws(
			call({
				exclude_cases: { not_a_suite: { x: 'y' } } as SpineCrossSuitesOptions['exclude_cases']
			}),
			/exclude_cases names unknown suite 'not_a_suite'/
		);
	});

	test('an excluded suite is refused', () => {
		assert.throws(
			call({ exclude: { ready: 'no /ready' }, exclude_cases: { ready: { x: 'y' } } }),
			/'ready' is excluded, so its exclude_cases entries name nothing/
		);
	});

	test('a suite skipping itself for a backdoor is refused', () => {
		assert.throws(
			call({ exclude_cases: { origin_conformance: { x: 'y' } } }),
			/exclude_cases names 'origin_conformance', which skips itself \(needs `_testing_origin_check`/
		);
	});

	test('an entry needs a reason, and a suite at least one entry', () => {
		assert.throws(
			call({ exclude_cases: { ready: { 'ready > x': ' ' } } }),
			/exclude_cases 'ready' › 'ready > x' needs a reason/
		);
		assert.throws(call({ exclude_cases: { ready: {} } }), /exclude_cases 'ready' names no test/);
	});
});

describe('describe_spine_cross_suites required options', () => {
	// every suite but `only` excluded, so the one left fails its check before
	// anything registers
	const capabilities = {
		ws: false,
		testing_backdoors: TESTING_BACKDOOR_METHODS
	} as unknown as BackendCapabilities;
	const handle = {
		config: { capabilities, env: {}, cookie_name: 'fuz_session' }
	} as unknown as ReconstructedBootstrappedBackendHandle;
	const only = (
		name: SuiteName,
		overrides?: SpineCrossSuitesOptions['overrides']
	): SpineCrossSuitesOptions =>
		({
			exclude: Object.fromEntries(
				SUITE_NAMES.filter((n) => n !== name && n !== 'testing_backdoor').map((n) => [
					n,
					'not under test'
				])
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

	test('rpc_input_overrides reaches rpc_adversarial as input_overrides', () => {
		const rpc_input_overrides = new Map([['gizmo_get', { id: 'seeded' }]]);
		const surface_source = {
			surface: { rpc_endpoints: [{ path: '/api/rpc', methods: [{ name: 'gizmo_get' }] }] }
		} as unknown as SpineCrossSuitesOptions['surface_source'];
		let received: unknown;
		assert.throws(
			() =>
				describe_spine_cross_suites(handle, {
					...only('rpc_adversarial', {
						rpc_adversarial: (derived) => {
							received = derived;
							return { setup_test: undefined };
						}
					}),
					surface_source,
					rpc_input_overrides
				}),
			/'rpc_adversarial' needs `setup_test`/
		);
		assert.strictEqual(
			(received as { input_overrides?: unknown }).input_overrides,
			rpc_input_overrides
		);
	});
});
