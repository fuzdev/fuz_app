import { assert, beforeAll, describe, test, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
	check_unexcludable_override,
	describe_spine_cross_suites,
	get_spine_suite_backdoors,
	get_spine_suite_transcript,
	register_spine_suites,
	SPINE_SUITES_REQUIRED_BACKDOORS,
	STANDALONE_CROSS_SUITES,
	SUITE_NAMES,
	UNEXCLUDABLE_SPINE_SUITES,
	type SpineCrossSuitesOptions,
	type SuiteName
} from '#lib/testing/cross_backend/spine_suites.ts';
import type { BackendCapabilities } from '#lib/testing/cross_backend/capabilities.ts';
import type { CapabilityMountsCrossTestOptions } from '#lib/testing/cross_backend/capability_mounts.ts';
import type { RpcAdversarialCrossTestOptions } from '#lib/testing/cross_backend/rpc_adversarial.ts';
import type {
	ReconstructedBootstrappedBackendHandle,
	SetupTest
} from '#lib/testing/cross_backend/setup.ts';
import {
	TESTING_BACKDOOR_METHODS,
	type TestingBackdoorMethod
} from '#lib/testing/cross_backend/spine_surface_constants.ts';

// the `UNEXCLUDABLE_SPINE_SUITES` can't be excluded, so the calls below that
// run one suite alone also reach them — registering nothing keeps them
// collection-free; the mount suite's options are recorded for the sibling-path test
const mount_suite_options: Array<CapabilityMountsCrossTestOptions> = vi.hoisted(() => []);
vi.mock('#lib/testing/cross_backend/capability_mounts.ts', async (import_original) => ({
	...(await import_original<typeof import('#lib/testing/cross_backend/capability_mounts.ts')>()),
	describe_capability_mounts_cross_tests: (options: CapabilityMountsCrossTestOptions) => {
		mount_suite_options.push(options);
	}
}));

// the options `rpc_adversarial` registers with, for the setup-wrapper tests
const adversarial_suite_options: Array<RpcAdversarialCrossTestOptions> = vi.hoisted(() => []);
vi.mock('#lib/testing/cross_backend/rpc_adversarial.ts', async (import_original) => ({
	...(await import_original<typeof import('#lib/testing/cross_backend/rpc_adversarial.ts')>()),
	describe_rpc_adversarial_cross_tests: (options: RpcAdversarialCrossTestOptions) => {
		adversarial_suite_options.push(options);
	}
}));

vi.mock('#lib/testing/cross_backend/testing_backdoor.ts', async (import_original) => ({
	...(await import_original<typeof import('#lib/testing/cross_backend/testing_backdoor.ts')>()),
	describe_testing_backdoor_cross_tests: () => {}
}));

const CROSS_BACKEND_DIR = fileURLToPath(
	new URL('../../../lib/testing/cross_backend/', import.meta.url)
);

/**
 * The adapters that load only on their own runtime (they read `Bun` at module
 * scope), so the guard can't import them under Node. Their source must
 * not name a `describe_` identifier at all, whatever the export form.
 */
const RUNTIME_BOUND_MODULES: ReadonlySet<string> = new Set(['testing_server_bun.ts']);

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

	test("testing/CLAUDE.md's suite table has one row per suite, in SUITE_NAMES order", () => {
		const doc = readFileSync(
			fileURLToPath(new URL('../../../lib/testing/CLAUDE.md', import.meta.url)),
			'utf8'
		);
		const header = '| suite | pins | gate |';
		const start = doc.indexOf(`\n${header}\n`);
		assert.ok(start !== -1, `no table headed '${header}'`);
		const rows: Array<string> = [];
		for (const line of doc
			.slice(start + header.length + 2)
			.split('\n')
			.slice(1)) {
			if (!line.startsWith('|')) break;
			const name = /^\| `(\w+)` \|/.exec(line)?.[1];
			assert.ok(name, `a suite table row names no suite: ${line}`);
			rows.push(name);
		}
		assert.deepEqual(rows, [...SUITE_NAMES], 'order the rows as SUITE_NAMES, one per suite');
	});
});

describe('the spine suite transcript classification', () => {
	test('every suite the transcript leaves out states why', () => {
		for (const name of SUITE_NAMES) {
			const transcript = get_spine_suite_transcript(name);
			if (transcript === 'http') continue;
			assert.ok(transcript.excluded.reason.trim().length > 0, name);
		}
	});

	test('the transcript runs at least one suite', () => {
		assert.ok(SUITE_NAMES.some((name) => get_spine_suite_transcript(name) === 'http'));
	});
});

describe('register_spine_suites names', () => {
	// validation runs before any suite registers, so a stub handle and surface do
	const handle = {
		config: { capabilities: { testing_backdoors: [] }, env: {} }
	} as unknown as ReconstructedBootstrappedBackendHandle;
	const register =
		(names: ReadonlyArray<SuiteName>, options: Partial<SpineCrossSuitesOptions> = {}) =>
		() =>
			register_spine_suites(handle, options as SpineCrossSuitesOptions, { names });

	test('an empty, unknown or repeated name is refused', () => {
		assert.throws(register([]), /names is empty/);
		assert.throws(
			register(['not_a_suite' as SuiteName]),
			/names lists unknown suite 'not_a_suite'/
		);
		assert.throws(register(['ready', 'ready']), /names lists 'ready' twice/);
	});

	test('an exclude, override or exclude_cases entry for a suite outside names is refused', () => {
		assert.throws(
			register(['ready'], { exclude: { origin: 'no origin' } }),
			/exclude names 'origin', which the registration doesn't run/
		);
		assert.throws(
			register(['ready'], { overrides: { origin: {} } }),
			/overrides names 'origin', which the registration doesn't run/
		);
		assert.throws(
			register(['ready'], { exclude_cases: { origin: { a: 'b' } } }),
			/exclude_cases names 'origin', which the registration doesn't run/
		);
	});

	test('a suite outside names that skips itself for a backdoor is not reported', () => {
		// `credential_conformance` skips itself on this backend, so an exclude of
		// it is refused as redundant when it runs — and as dead when it doesn't
		assert.throws(
			register(['credential_conformance'], { exclude: { credential_conformance: 'x' } }),
			/is redundant — the suite skips itself/
		);
		assert.throws(
			register(['ready'], { exclude: { credential_conformance: 'x' } }),
			/which the registration doesn't run/
		);
	});
});

describe('register_spine_suites setup wrapper', () => {
	// each registration throws at its suite's required check, after the
	// override merge and the wrapping
	const capabilities = {
		ws: false,
		testing_backdoors: TESTING_BACKDOOR_METHODS
	} as unknown as BackendCapabilities;
	const handle = {
		config: { capabilities, env: {}, cookie_name: 'fuz_session', rpc_path: '/api/rpc' }
	} as unknown as ReconstructedBootstrappedBackendHandle;
	const wrapped_with = (
		name: SuiteName,
		overrides: SpineCrossSuitesOptions['overrides'],
		thrown: RegExp
	): Array<unknown> => {
		const wrapped: Array<unknown> = [];
		assert.throws(
			() =>
				register_spine_suites(handle, { overrides } as SpineCrossSuitesOptions, {
					names: [name],
					wrap_setup_test: (setup_test) => {
						wrapped.push(setup_test);
						return setup_test;
					}
				}),
			thrown
		);
		return wrapped;
	};

	test('a derived setup is wrapped once', () => {
		const wrapped = wrapped_with('session_cookie_codec', undefined, /needs `cookie_keys`/);
		assert.strictEqual(wrapped.length, 1);
		assert.strictEqual(typeof wrapped[0], 'function');
	});

	test('a setup an override supplies is wrapped, by value and by function', () => {
		const supplied = (() => {}) as unknown as SetupTest;
		for (const override of [{ setup_test: supplied }, () => ({ setup_test: supplied })]) {
			const wrapped = wrapped_with(
				'session_cookie_codec',
				{ session_cookie_codec: override },
				/needs `cookie_keys`/
			);
			assert.deepStrictEqual(wrapped, [supplied]);
		}
	});

	test('an option holding no derived setup passes through the wrapping untouched', () => {
		const rpc_input_overrides = new Map([['gizmo_get', { id: 'seeded' }]]);
		const surface_source = {
			surface: { rpc_endpoints: [{ path: '/api/rpc', methods: [{ name: 'gizmo_get' }] }] }
		} as unknown as SpineCrossSuitesOptions['surface_source'];
		adversarial_suite_options.length = 0;
		register_spine_suites(
			handle,
			{ surface_source, rpc_input_overrides } as unknown as SpineCrossSuitesOptions,
			{ names: ['rpc_adversarial'], wrap_setup_test: (setup_test) => setup_test }
		);
		const [options] = adversarial_suite_options;
		assert.ok(options, 'rpc_adversarial registered');
		// the same instances — a rebuilt Map is an empty object, a rebuilt
		// object loses its identity and prototype
		assert.strictEqual(options.input_overrides, rpc_input_overrides);
		assert.strictEqual(options.surface_source, surface_source);
	});

	test('the multi-actor setups a suite derives are wrapped, a nested one too', () => {
		// a cleared capabilities, and no base_url on the config, throw at the
		// required check
		assert.strictEqual(
			wrapped_with(
				'fact_serving',
				{ fact_serving: { capabilities: undefined } },
				/needs `capabilities`/
			).length,
			2
		);
		const supplied = (() => {}) as unknown as SetupTest;
		const wrapped = wrapped_with(
			'transport_composition',
			{
				transport_composition: (d) => ({ multi_actor: { ...d.multi_actor, setup_test: supplied } })
			},
			/needs `base_url`/
		);
		assert.strictEqual(wrapped.length, 2);
		assert.ok(wrapped.includes(supplied));
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
			// and declaring `rooms` requires `_testing_room_evict`
			if (source.includes('capabilities.rooms')) allowed.add('_testing_room_evict');
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
	const base = { expected_skips: {} } as unknown as SpineCrossSuitesOptions;
	const call = (options: Partial<SpineCrossSuitesOptions>) => () =>
		describe_spine_cross_suites(handle, { ...base, ...options });

	test('an exclude needs a reason', () => {
		assert.throws(call({ exclude: { ready: '' } }), /exclude 'ready' needs a reason/);
		assert.throws(call({ exclude: { ready: '  ' } }), /exclude 'ready' needs a reason/);
	});

	test('an expected skip needs a reason', () => {
		assert.throws(
			call({ expected_skips: { 'a > b': '' } }),
			/expected_skips: every declared skip needs a reason — a > b/
		);
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

	test('capability_mounts cannot be excluded, nor one of its cases', () => {
		assert.throws(
			call({ exclude: { capability_mounts: 'declares cells off while mounting them' } }),
			/'capability_mounts' can't be excluded — it checks the capability flags/
		);
		assert.throws(
			call({
				exclude_cases: {
					capability_mounts: { 'capability mounts > x': 'mounted under its own auth' }
				}
			}),
			/exclude_cases can't name 'capability_mounts'/
		);
	});
});

/** A stub handle whose backend declares `testing_backdoors`, plus `extra` capabilities. */
const handle_declaring = (
	testing_backdoors: ReadonlyArray<TestingBackdoorMethod>,
	extra: Partial<BackendCapabilities> = {}
): ReconstructedBootstrappedBackendHandle =>
	({
		config: {
			capabilities: { ws: false, ...extra, testing_backdoors },
			env: {},
			base_url: 'http://localhost:1'
		}
	}) as unknown as ReconstructedBootstrappedBackendHandle;

/** The backdoors every one-call backend must declare, and nothing else. */
const HARNESS_ONLY: ReadonlyArray<TestingBackdoorMethod> = [
	'_testing_reset',
	'_testing_drain_effects',
	'_testing_db_invariants'
];

describe('describe_spine_cross_suites backdoor declaration', () => {
	const base = { expected_skips: {} } as unknown as SpineCrossSuitesOptions;
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

	test('a backend not declaring the invariants backdoor throws unless the setup turns the check off', () => {
		const harness = HARNESS_ONLY.filter((m) => m !== '_testing_db_invariants');
		assert.throws(
			call(handle_declaring(harness), {}),
			/must declare _testing_db_invariants.*setup: \{exclude_db_invariants: \{all: '<reason>'\}\}/
		);
		let refusal = '';
		try {
			call(handle_declaring(harness), {
				setup: { exclude_db_invariants: { all: 'not under test' } }
			})();
		} catch (error) {
			// past the check, registration refuses a call made inside a test
			refusal = String(error);
		}
		assert.notMatch(refusal, /_testing_db_invariants/);
	});

	test('fact_serving needs the fact seeder declared', () => {
		assert.throws(
			call(handle_declaring(HARNESS_ONLY, { fact_serving: true }), {}),
			/fact_serving needs _testing_put_fact/
		);
	});

	test('rooms needs the room evict backdoor declared', () => {
		assert.throws(
			call(handle_declaring(HARNESS_ONLY, { rooms: true }), {}),
			/rooms needs _testing_room_evict/
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
					!(n in UNEXCLUDABLE_SPINE_SUITES) &&
					![
						'credential_conformance',
						'credential_deadline',
						'origin_conformance',
						'ws_outbound_overflow'
					].includes(n)
			).map((n) => [n, 'not under test'])
		);
		// out of sorted order, so a comparison that sorts one side only fails
		const declared: ReadonlyArray<TestingBackdoorMethod> = [
			'_testing_reset',
			'_testing_drain_effects',
			'_testing_mint_session',
			'_testing_db_invariants'
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
				/overrides can't change 'testing_backdoor' capabilities \(testing_backdoors\)/,
				undefined,
				testing_backdoors.join(', ')
			);
		}
		// the same list in another order passes the check
		let refusal = '';
		try {
			with_backdoors([
				'_testing_db_invariants',
				'_testing_mint_session',
				'_testing_reset',
				'_testing_drain_effects'
			])();
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
		describe_spine_cross_suites(handle, {
			expected_skips: {},
			...options
		} as SpineCrossSuitesOptions);

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
		config: { capabilities, env: {}, cookie_name: 'fuz_session', base_url: 'http://localhost:1' }
	} as unknown as ReconstructedBootstrappedBackendHandle;
	const only = (
		name: SuiteName,
		overrides?: SpineCrossSuitesOptions['overrides']
	): SpineCrossSuitesOptions =>
		({
			exclude: Object.fromEntries(
				SUITE_NAMES.filter((n) => n !== name && !(n in UNEXCLUDABLE_SPINE_SUITES)).map((n) => [
					n,
					'not under test'
				])
			),
			overrides,
			expected_skips: {}
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

describe('describe_spine_cross_suites unexcludable overrides', () => {
	const capabilities = {
		ws: true,
		cell_crud: true,
		testing_backdoors: HARNESS_ONLY
	} as unknown as BackendCapabilities;
	const handle_with = (config: Record<string, unknown>) =>
		({
			config: { capabilities, env: {}, ...config }
		}) as unknown as ReconstructedBootstrappedBackendHandle;
	const handle = handle_with({ base_url: 'http://localhost:1' });
	// every other suite excluded but the siblings the mount suite reads, so an
	// override reaches the unexcludable suites alone
	const exclude = (keep: ReadonlyArray<SuiteName> = []) =>
		Object.fromEntries(
			SUITE_NAMES.filter(
				(n) =>
					!(n in UNEXCLUDABLE_SPINE_SUITES) &&
					!keep.includes(n) &&
					!get_spine_suite_backdoors(n).some((m) => !HARNESS_ONLY.includes(m))
			).map((n) => [n, 'not under test'])
		);
	const call =
		(
			overrides: SpineCrossSuitesOptions['overrides'],
			keep?: ReadonlyArray<SuiteName>,
			h = handle
		) =>
		() =>
			describe_spine_cross_suites(h, {
				exclude: exclude(keep),
				overrides,
				expected_skips: {}
			} as SpineCrossSuitesOptions);

	test('an override changing a probed flag is refused', () => {
		assert.throws(
			call({
				capability_mounts: (d) => ({ capabilities: { ...d.capabilities, cell_crud: false } })
			}),
			/overrides can't change 'capability_mounts' capabilities \(cell_crud\)/
		);
	});

	test('an override moving a backend path the probes hit is refused', () => {
		for (const [key, value] of [
			['base_url', 'http://localhost:2'],
			['rpc_path', '/api/elsewhere/rpc'],
			['ws_path', '/api/nope'],
			['sse_path', '/api/nope/stream']
		] as const) {
			assert.throws(
				call({ capability_mounts: { [key]: value } }),
				new RegExp(`overrides can't change 'capability_mounts' ${key} — `),
				undefined,
				key
			);
		}
	});

	test('setup_test and every option off the allowlist are refused on both suites', () => {
		const setup_test = () => Promise.reject(new Error('elsewhere'));
		assert.throws(
			call({ capability_mounts: { setup_test } }),
			/overrides can't set 'capability_mounts' setup_test — .*; it admits capabilities \(unchanged\)/
		);
		assert.throws(
			call({ testing_backdoor: { setup_test } }),
			/overrides can't set 'testing_backdoor' setup_test — .*; it admits extra_methods, ws \(unchanged or undefined\), capabilities \(unchanged\), rpc_path \(unchanged\)/
		);
		for (const key of ['gated_ws_path', 'ready_path'] as const) {
			assert.throws(
				call({ capability_mounts: { [key]: '/elsewhere' } }),
				new RegExp(`overrides can't set 'capability_mounts' ${key} — `),
				undefined,
				key
			);
		}
		assert.throws(
			call({ testing_backdoor: { rpc_path: '/api/elsewhere/rpc' } }),
			/overrides can't change 'testing_backdoor' rpc_path — /
		);
	});

	test('the mount suite probes the paths ws_role_gated and ready run with', () => {
		const probed_paths = (
			overrides: SpineCrossSuitesOptions['overrides'],
			keep: ReadonlyArray<SuiteName>
		): { gated_ws_path?: string; ready_path?: string } => {
			mount_suite_options.length = 0;
			try {
				call(overrides, keep)();
			} catch {
				// the siblings, run inside a test, refuse to register — after the mount suite did
			}
			const [options] = mount_suite_options;
			assert.ok(options, 'the mount suite registered');
			return { gated_ws_path: options.gated_ws_path, ready_path: options.ready_path };
		};
		assert.deepStrictEqual(
			probed_paths(
				{ ws_role_gated: { gated_ws_path: '/api/admin/ws' }, ready: { ready_path: '/readyz' } },
				['ws_role_gated', 'ready']
			),
			{ gated_ws_path: '/api/admin/ws', ready_path: '/readyz' }
		);
		// excluded, a sibling runs nothing, and the mount suite takes the spine defaults
		assert.deepStrictEqual(probed_paths(undefined, []), {
			gated_ws_path: '/api/gated/ws',
			ready_path: '/ready'
		});
	});

	test("a registration running the mount suite alone reads its siblings' entries", () => {
		const register = (options: Partial<SpineCrossSuitesOptions>) => () =>
			register_spine_suites(handle, options as SpineCrossSuitesOptions, {
				names: ['capability_mounts']
			});
		// the sibling overrides reach the probes, not refused as dead
		mount_suite_options.length = 0;
		register({
			overrides: {
				ws_role_gated: { gated_ws_path: '/api/admin/ws' },
				ready: { ready_path: '/readyz' }
			}
		})();
		assert.strictEqual(mount_suite_options[0]?.gated_ws_path, '/api/admin/ws');
		assert.strictEqual(mount_suite_options[0]?.ready_path, '/readyz');
		// a sibling's exclude reaches the probe's note, and shows no skip of its
		// own (registering one inside this test would throw)
		mount_suite_options.length = 0;
		register({ exclude: { ready: 'no /ready' } })();
		assert.deepStrictEqual(Object.keys(mount_suite_options[0]?.path_notes ?? {}), ['ready']);
		// a suite nothing run reads, and a sibling's case exclusions, are dead
		assert.throws(
			register({ overrides: { origin: {} } }),
			/overrides names 'origin', which the registration doesn't run/
		);
		assert.throws(
			register({ exclude: { origin: 'no origin' } }),
			/exclude names 'origin', which the registration doesn't run/
		);
		assert.throws(
			register({ exclude_cases: { ready: { a: 'b' } } }),
			/exclude_cases names 'ready', which the registration doesn't run/
		);
	});

	test("an excluded sibling's probe failure names the remedy", () => {
		mount_suite_options.length = 0;
		try {
			call(undefined, ['ws_role_gated'])();
		} catch {
			// the sibling, run inside a test, refuses to register — after the mount suite did
		}
		const [options] = mount_suite_options;
		assert.ok(options);
		assert.deepStrictEqual(Object.keys(options.path_notes ?? {}), ['ready']);
		assert.match(
			options.path_notes?.ready ?? '',
			/'ready' is excluded, .* un-exclude 'ready' and set it there with `overrides\.ready\.ready_path`/
		);
	});

	test('an unexcludable suite missing a required option names only the override remedy', () => {
		let message = '';
		try {
			// no base_url on the config, so the mount suite derives none
			call(undefined, [], handle_with({}))();
		} catch (error) {
			message = String(error);
		}
		assert.match(
			message,
			/'capability_mounts' needs `base_url`, which neither the handle nor the override gives — pass `overrides\.capability_mounts` with it$/
		);
		assert.notMatch(message, /exclude 'capability_mounts'/);
	});
});

describe('check_unexcludable_override', () => {
	const derived = {
		capabilities: { ws: true, testing_backdoors: ['_testing_reset', '_testing_drain_effects'] },
		rpc_path: '/api/rpc',
		base_url: 'http://localhost:1'
	};

	test('a suite that can be excluded is not checked', () => {
		check_unexcludable_override('ready', { setup_test: undefined, ready_path: '/x' }, derived);
	});

	test('free keys take any value, fixed keys their derived value', () => {
		check_unexcludable_override(
			'testing_backdoor',
			{
				extra_methods: [{ method: '_testing_seam' }],
				ws: undefined,
				rpc_path: '/api/rpc',
				// the same list in another order is the same declaration
				capabilities: {
					ws: true,
					testing_backdoors: ['_testing_drain_effects', '_testing_reset']
				}
			},
			derived
		);
		check_unexcludable_override(
			'capability_mounts',
			{ base_url: 'http://localhost:1', rpc_path: '/api/rpc' },
			derived
		);
	});

	test('ws on testing_backdoor drops (undefined) or stays, never moves', () => {
		const with_ws = { ...derived, ws: { base_url: 'http://localhost:1', ws_path: '/api/ws' } };
		check_unexcludable_override('testing_backdoor', { ws: undefined }, with_ws);
		check_unexcludable_override(
			'testing_backdoor',
			{ ws: { base_url: 'http://localhost:1', ws_path: '/api/ws' } },
			with_ws
		);
		assert.throws(
			() =>
				check_unexcludable_override(
					'testing_backdoor',
					{ ws: { base_url: 'http://localhost:1', ws_path: '/api/elsewhere/ws' } },
					with_ws
				),
			/overrides can't change 'testing_backdoor' ws \(ws_path\)/
		);
	});

	test('any key with its derived value passes, an unlisted one included', () => {
		check_unexcludable_override(
			'capability_mounts',
			{ setup_test: undefined, rpc_path: '/api/rpc' },
			{ ...derived, setup_test: undefined }
		);
	});

	test('a fixed key moved throws, naming what differs', () => {
		assert.throws(
			() =>
				check_unexcludable_override(
					'testing_backdoor',
					{ capabilities: { ws: false, testing_backdoors: ['_testing_reset'] } },
					derived
				),
			/overrides can't change 'testing_backdoor' capabilities \(ws, testing_backdoors\)/
		);
		assert.throws(
			() => check_unexcludable_override('capability_mounts', { base_url: undefined }, derived),
			/overrides can't change 'capability_mounts' base_url — /
		);
	});

	test('a key off the allowlist throws on any value but its derived one', () => {
		assert.throws(
			() =>
				check_unexcludable_override('capability_mounts', { gated_ws_path: '/elsewhere' }, derived),
			/overrides can't set 'capability_mounts' gated_ws_path/
		);
	});
});
