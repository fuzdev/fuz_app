/**
 * Tests for action_codegen.ts — codegen utilities extracted from zzz.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {z} from 'zod';

import {
	ImportBuilder,
	get_executor_phases,
	get_handler_return_type,
	generate_phase_handlers,
	create_banner,
	generate_actions_api_method_signature,
	generate_action_method_enums,
	generate_action_method_enum_block,
	generate_typed_action_event_alias,
	generate_action_specs_record,
	generate_action_inputs_outputs,
	generate_action_event_datas,
	generate_actions_api,
	generate_frontend_action_handlers,
	generate_backend_actions_api,
	COMPOSABLE_ACTION_METHODS,
	is_composable_action_method,
} from '$lib/actions/action_codegen.js';
import type {ActionSpecUnion} from '$lib/actions/action_spec.js';

// --- helpers ---

const create_rr = (initiator: 'frontend' | 'backend' | 'both'): ActionSpecUnion => ({
	method: 'thing_create',
	kind: 'request_response',
	initiator,
	auth: 'authenticated',
	side_effects: true,
	input: z.strictObject({name: z.string()}),
	output: z.strictObject({id: z.string()}),
	async: true,
	description: 'Create a thing',
});

const create_rn = (initiator: 'frontend' | 'backend' | 'both'): ActionSpecUnion => ({
	method: 'thing_created',
	kind: 'remote_notification',
	initiator,
	auth: null,
	side_effects: true,
	input: z.strictObject({id: z.string()}),
	output: z.void(),
	async: true,
	description: 'A thing was created',
});

const create_lc = (
	initiator: 'frontend' | 'backend' | 'both',
	async_: boolean = false,
): ActionSpecUnion => ({
	method: 'toggle_menu',
	kind: 'local_call',
	initiator,
	auth: null,
	side_effects: false,
	input: z.null(),
	output: z.null(),
	async: async_,
	description: 'Toggle the menu',
});

// --- ImportBuilder ---

describe('ImportBuilder', () => {
	test('value import', () => {
		const b = new ImportBuilder();
		b.add('zod', 'z');
		assert.strictEqual(b.build(), "import {z} from 'zod';");
	});

	test('type import uses import type syntax', () => {
		const b = new ImportBuilder();
		b.add_type('./foo.js', 'Foo');
		assert.strictEqual(b.build(), "import type {Foo} from './foo.js';");
	});

	test('mixed value + type in same module', () => {
		const b = new ImportBuilder();
		b.add('./foo.js', 'bar');
		b.add_type('./foo.js', 'Baz');
		assert.strictEqual(b.build(), "import {bar, type Baz} from './foo.js';");
	});

	test('multiple types sorted alphabetically', () => {
		const b = new ImportBuilder();
		b.add_types('./types.js', 'Zebra', 'Apple', 'Mango');
		assert.strictEqual(b.build(), "import type {Apple, Mango, Zebra} from './types.js';");
	});

	test('namespace import', () => {
		const b = new ImportBuilder();
		b.add('./specs.js', '* as specs');
		assert.strictEqual(b.build(), "import * as specs from './specs.js';");
	});

	test('value import does not downgrade to type', () => {
		const b = new ImportBuilder();
		b.add('./foo.js', 'Foo');
		b.add_type('./foo.js', 'Foo');
		assert.strictEqual(b.build(), "import {Foo} from './foo.js';");
	});

	test('build returns empty string with no imports', () => {
		const b = new ImportBuilder();
		assert.strictEqual(b.build(), '');
	});

	test('has_imports', () => {
		const b = new ImportBuilder();
		assert.ok(!b.has_imports());
		b.add('zod', 'z');
		assert.ok(b.has_imports());
	});

	test('import_count', () => {
		const b = new ImportBuilder();
		b.add('./a.js', 'a');
		b.add('./b.js', 'b');
		assert.strictEqual(b.import_count, 2);
	});

	test('clear removes all imports', () => {
		const b = new ImportBuilder();
		b.add('zod', 'z');
		b.clear();
		assert.ok(!b.has_imports());
	});

	test('preview returns same as build split by line', () => {
		const b = new ImportBuilder();
		b.add('zod', 'z');
		b.add_type('./foo.js', 'Foo');
		assert.deepStrictEqual(b.preview(), b.build().split('\n'));
	});
});

// --- get_executor_phases ---

describe('get_executor_phases', () => {
	describe('request_response', () => {
		test('frontend initiator — frontend executor gets send phases', () => {
			const phases = get_executor_phases(create_rr('frontend'), 'frontend');
			assert.ok(phases.includes('send_request'));
			assert.ok(phases.includes('receive_response'));
			assert.ok(phases.includes('send_error'));
			assert.ok(phases.includes('receive_error'));
			assert.ok(!phases.includes('receive_request'));
		});

		test('frontend initiator — backend executor gets receive phases', () => {
			const phases = get_executor_phases(create_rr('frontend'), 'backend');
			assert.ok(phases.includes('receive_request'));
			assert.ok(phases.includes('send_response'));
			assert.ok(!phases.includes('send_request'));
		});

		test('both initiator — both executors get all phases (deduplicated)', () => {
			const frontend_phases = get_executor_phases(create_rr('both'), 'frontend');
			const backend_phases = get_executor_phases(create_rr('both'), 'backend');
			// No duplicates
			assert.strictEqual(frontend_phases.length, new Set(frontend_phases).size);
			assert.strictEqual(backend_phases.length, new Set(backend_phases).size);
			// Both get the full set of 6 unique phases
			const all_rr_phases = new Set([
				'send_request',
				'receive_response',
				'send_error',
				'receive_error',
				'receive_request',
				'send_response',
			]);
			assert.deepStrictEqual(new Set(frontend_phases), all_rr_phases);
			assert.deepStrictEqual(new Set(backend_phases), all_rr_phases);
		});
	});

	describe('remote_notification', () => {
		test('backend initiator — backend gets send', () => {
			const phases = get_executor_phases(create_rn('backend'), 'backend');
			assert.ok(phases.includes('send'));
			assert.ok(!phases.includes('receive'));
		});

		test('backend initiator — frontend gets receive', () => {
			const phases = get_executor_phases(create_rn('backend'), 'frontend');
			assert.ok(phases.includes('receive'));
			assert.ok(!phases.includes('send'));
		});
	});

	describe('local_call', () => {
		test('frontend initiator — frontend gets execute', () => {
			const phases = get_executor_phases(create_lc('frontend'), 'frontend');
			assert.deepStrictEqual(phases, ['execute']);
		});

		test('frontend initiator — backend gets nothing (empty)', () => {
			const phases = get_executor_phases(create_lc('frontend'), 'backend');
			assert.deepStrictEqual(phases, []);
		});
	});
});

// --- generate_actions_api_method_signature ---

describe('generate_actions_api_method_signature', () => {
	test('request_response — Promise<Result<...>> with options arg', () => {
		const sig = generate_actions_api_method_signature(create_rr('frontend'));
		assert.ok(sig.startsWith('thing_create: ('));
		assert.ok(sig.includes("input: ActionInputs['thing_create']"));
		assert.ok(sig.includes('options?: RpcClientCallOptions'));
		assert.ok(
			sig.includes(
				"Promise<Result<{value: ActionOutputs['thing_create']}, {error: JsonrpcErrorObject}>>",
			),
		);
	});

	test('remote_notification — Promise<Result<{value: void}>> with options arg', () => {
		// Regression pin: notifications previously emitted `=> void`, which
		// (a) lied about the runtime (`create_remote_notification_method`
		// returns a Promise) and (b) tripped `create_throwing_rpc_call`'s
		// generic constraint at every consumer call site. Notifications
		// must emit the same Promise<Result<...>> shape as request_response.
		const sig = generate_actions_api_method_signature(create_rn('backend'));
		assert.ok(sig.startsWith('thing_created: ('));
		assert.ok(sig.includes("input: ActionInputs['thing_created']"));
		assert.ok(sig.includes('options?: RpcClientCallOptions'));
		assert.ok(
			sig.includes(
				"Promise<Result<{value: ActionOutputs['thing_created']}, {error: JsonrpcErrorObject}>>",
			),
		);
		// Must NOT regress to the old void shape.
		assert.ok(!/=>\s*void\s*;?$/.test(sig), `notification regressed to void: ${sig}`);
	});

	test('async local_call — Promise<Result<...>> with options arg', () => {
		const sig = generate_actions_api_method_signature(create_lc('frontend', true));
		assert.ok(sig.includes('options?: RpcClientCallOptions'));
		assert.ok(
			sig.includes(
				"Promise<Result<{value: ActionOutputs['toggle_menu']}, {error: JsonrpcErrorObject}>>",
			),
		);
	});

	test('sync local_call — direct value return, no options arg (default)', () => {
		const sig = generate_actions_api_method_signature(create_lc('frontend', false));
		assert.ok(!sig.includes('options?: RpcClientCallOptions'));
		assert.ok(!sig.includes('Promise<'));
		assert.ok(sig.includes("ActionOutputs['toggle_menu']"));
	});

	test('sync local_call — Result wrap when sync_returns_value: false', () => {
		const sig = generate_actions_api_method_signature(create_lc('frontend', false), {
			sync_returns_value: false,
		});
		assert.ok(!sig.includes('options?: RpcClientCallOptions'));
		assert.ok(!sig.includes('Promise<'));
		assert.ok(
			sig.includes("Result<{value: ActionOutputs['toggle_menu']}, {error: JsonrpcErrorObject}>"),
		);
	});
});

// --- create_banner ---

describe('create_banner', () => {
	test('contains the origin path', () => {
		const banner = create_banner('src/lib/foo.gen.ts');
		assert.ok(banner.includes('src/lib/foo.gen.ts'));
	});

	test('is a string', () => {
		assert.strictEqual(typeof create_banner('x'), 'string');
	});
});

// --- generate_phase_handlers ---

describe('generate_phase_handlers', () => {
	test('returns never for empty phases', () => {
		const imports = new ImportBuilder();
		// frontend local_call on backend executor → no phases
		const result = generate_phase_handlers(create_lc('frontend'), 'backend', imports);
		assert.strictEqual(result, 'toggle_menu?: never');
		assert.ok(!imports.has_imports());
	});

	test('generates handler definitions for frontend executor', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(create_rr('frontend'), 'frontend', imports);
		assert.ok(result.startsWith('thing_create?: {'));
		assert.ok(result.includes('send_request'));
		assert.ok(result.includes('receive_response'));
		assert.ok(result.includes('ActionEvent'));
		// No environment type in generated output
		assert.ok(!result.includes('Frontend'));
		// Verify imports were added
		const built = imports.build();
		assert.ok(built.includes('ActionEvent'));
		assert.ok(!built.includes('Frontend'));
		assert.ok(built.includes('@fuzdev/fuz_app/actions/action_event.js'));
	});

	test('generates handler definitions for backend executor', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(create_rr('frontend'), 'backend', imports);
		assert.ok(result.includes('receive_request'));
		assert.ok(result.includes('send_response'));
		// No environment type in generated output
		assert.ok(!result.includes('Backend'));
		// Verify imports were added
		const built = imports.build();
		assert.ok(built.includes('@fuzdev/fuz_app/actions/action_event.js'));
		assert.ok(!built.includes('Backend'));
	});

	test('local_call frontend executor generates execute handler', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(create_lc('frontend'), 'frontend', imports);
		assert.ok(result.includes('execute'));
		assert.ok(result.includes('toggle_menu'));
	});
});

// --- get_handler_return_type ---

describe('get_handler_return_type', () => {
	test('receive_request returns ActionOutputs union type', () => {
		const imports = new ImportBuilder();
		const result = get_handler_return_type(
			create_rr('frontend'),
			'receive_request',
			imports,
			'./action_collections.js',
		);
		assert.ok(result.includes("ActionOutputs['thing_create']"));
		assert.ok(result.includes('Promise'));
	});

	test('receive_request adds ActionOutputs import', () => {
		const imports = new ImportBuilder();
		get_handler_return_type(
			create_rr('frontend'),
			'receive_request',
			imports,
			'./action_collections.js',
		);
		assert.ok(imports.has_imports());
	});

	test('local_call execute with async returns union type', () => {
		const imports = new ImportBuilder();
		const result = get_handler_return_type(
			create_lc('frontend', true),
			'execute',
			imports,
			'./action_collections.js',
		);
		assert.ok(result.includes("ActionOutputs['toggle_menu']"));
		assert.ok(result.includes('Promise'));
	});

	test('local_call execute without async returns direct type', () => {
		const imports = new ImportBuilder();
		const result = get_handler_return_type(
			create_lc('frontend', false),
			'execute',
			imports,
			'./action_collections.js',
		);
		assert.ok(result.includes("ActionOutputs['toggle_menu']"));
		assert.ok(!result.includes('Promise'));
	});

	test('other phases return void', () => {
		const imports = new ImportBuilder();
		const result = get_handler_return_type(
			create_rr('frontend'),
			'send_request',
			imports,
			'./action_collections.js',
		);
		assert.strictEqual(result, 'void | Promise<void>');
	});
});

// --- High-level codegen helpers ---------------------------------------------

/**
 * Fixture spec set spanning every discriminator the high-level helpers branch
 * on: kind × initiator × (sync/async) — keeps the helper tests independent
 * of any one consumer's spec list while still exercising every code path.
 */
const fixture_specs: ReadonlyArray<ActionSpecUnion> = [
	{
		method: 'heartbeat',
		kind: 'request_response',
		initiator: 'both',
		auth: 'authenticated',
		side_effects: false,
		input: z.strictObject({}),
		output: z.strictObject({}),
		async: true,
		description: 'Liveness probe.',
	},
	{
		method: 'cancel',
		kind: 'remote_notification',
		initiator: 'frontend',
		auth: null,
		side_effects: true,
		input: z.strictObject({request_id: z.union([z.string(), z.number()])}),
		output: z.void(),
		async: true,
		description: 'Cancel a pending request.',
	},
	{
		method: 'thing_create',
		kind: 'request_response',
		initiator: 'frontend',
		auth: 'authenticated',
		side_effects: true,
		input: z.strictObject({name: z.string()}),
		output: z.strictObject({id: z.string()}),
		async: true,
		description: 'Create a thing.',
	},
	{
		method: 'thing_changed',
		kind: 'remote_notification',
		initiator: 'backend',
		auth: null,
		side_effects: true,
		input: z.strictObject({id: z.string()}),
		output: z.void(),
		async: true,
		description: 'A thing changed on the server.',
	},
	{
		method: 'menu_toggle',
		kind: 'local_call',
		initiator: 'frontend',
		auth: null,
		side_effects: false,
		input: z.null(),
		output: z.null(),
		async: false,
		description: 'Toggle the main menu.',
	},
];

describe('COMPOSABLE_ACTION_METHODS', () => {
	test('is the readonly tuple of fuz_app composables', () => {
		assert.deepStrictEqual([...COMPOSABLE_ACTION_METHODS], ['heartbeat', 'cancel']);
	});
});

describe('is_composable_action_method', () => {
	test('matches every member of COMPOSABLE_ACTION_METHODS', () => {
		for (const method of COMPOSABLE_ACTION_METHODS) {
			assert.ok(is_composable_action_method(method));
		}
	});

	test('rejects non-composable method names', () => {
		assert.ok(!is_composable_action_method('thing_create'));
		assert.ok(!is_composable_action_method(''));
		assert.ok(!is_composable_action_method('Heartbeat')); // case-sensitive
	});

	test('reads cleanly as a predicate without `as never` casts', () => {
		// Pin against regression to the `as never` workaround pattern. The
		// helpers default-exclude composables, so this predicate is now
		// primarily for consumer code paths that handle a spec list directly.
		const composable_specs = fixture_specs.filter((s) => is_composable_action_method(s.method));
		const consumer_specs = fixture_specs.filter((s) => !is_composable_action_method(s.method));
		assert.deepStrictEqual(composable_specs.map((s) => s.method).sort(), ['cancel', 'heartbeat']);
		assert.ok(consumer_specs.every((s) => !is_composable_action_method(s.method)));
	});
});

describe('generate_action_method_enums', () => {
	test('emits all six enums by default', () => {
		const imports = new ImportBuilder();
		const result = generate_action_method_enums(fixture_specs, imports);
		// Each enum const + matching `type` alias.
		for (const name of [
			'ActionMethod',
			'RequestResponseActionMethod',
			'RemoteNotificationActionMethod',
			'LocalCallActionMethod',
			'FrontendActionMethod',
			'BackendActionMethod',
		]) {
			assert.ok(result.includes(`export const ${name} = z.enum([`), `missing const ${name}`);
			assert.ok(
				result.includes(`export type ${name} = z.infer<typeof ${name}>;`),
				`missing type ${name}`,
			);
		}
		// Registers the zod import on the builder.
		assert.ok(imports.build().includes("import {z} from 'zod';"));
	});

	test('correctly partitions methods by kind (composables filtered by default)', () => {
		const imports = new ImportBuilder();
		const result = generate_action_method_enums(fixture_specs, imports);

		// `RequestResponseActionMethod` contains thing_create only — heartbeat
		// (composable) is filtered out by default.
		const rr_section = result.slice(
			result.indexOf('export const RequestResponseActionMethod'),
			result.indexOf('export type RequestResponseActionMethod'),
		);
		assert.ok(rr_section.includes("'thing_create'"));
		assert.ok(!rr_section.includes("'heartbeat'"));
		assert.ok(!rr_section.includes("'cancel'"));
		assert.ok(!rr_section.includes("'menu_toggle'"));

		// `RemoteNotificationActionMethod` contains thing_changed only —
		// cancel (composable) is filtered out by default.
		const rn_section = result.slice(
			result.indexOf('export const RemoteNotificationActionMethod'),
			result.indexOf('export type RemoteNotificationActionMethod'),
		);
		assert.ok(rn_section.includes("'thing_changed'"));
		assert.ok(!rn_section.includes("'cancel'"));
		assert.ok(!rn_section.includes("'thing_create'"));
	});

	test('include_composables: true retains heartbeat + cancel', () => {
		const imports = new ImportBuilder();
		const result = generate_action_method_enums(fixture_specs, imports, {
			include_composables: true,
		});
		const rr_section = result.slice(
			result.indexOf('export const RequestResponseActionMethod'),
			result.indexOf('export type RequestResponseActionMethod'),
		);
		assert.ok(rr_section.includes("'heartbeat'"));
		assert.ok(rr_section.includes("'thing_create'"));
		const rn_section = result.slice(
			result.indexOf('export const RemoteNotificationActionMethod'),
			result.indexOf('export type RemoteNotificationActionMethod'),
		);
		assert.ok(rn_section.includes("'cancel'"));
		assert.ok(rn_section.includes("'thing_changed'"));
	});

	test('emit option restricts to a subset', () => {
		const imports = new ImportBuilder();
		const result = generate_action_method_enums(fixture_specs, imports, {
			emit: new Set(['all', 'request_response']),
		});
		assert.ok(result.includes('export const ActionMethod'));
		assert.ok(result.includes('export const RequestResponseActionMethod'));
		assert.ok(!result.includes('export const RemoteNotificationActionMethod'));
		assert.ok(!result.includes('export const FrontendActionMethod'));
		assert.ok(!result.includes('export const BackendActionMethod'));
	});

	test('skips empty kinds rather than emitting `z.enum([])`', () => {
		// Spec set with no local_call + no remote_notification → those enums
		// would be `z.enum([])`, which throws at runtime in zod.
		const only_rr: ReadonlyArray<ActionSpecUnion> = [create_rr('frontend')];
		const imports = new ImportBuilder();
		const result = generate_action_method_enums(only_rr, imports);

		assert.ok(result.includes('export const ActionMethod'));
		assert.ok(result.includes('export const RequestResponseActionMethod'));
		assert.ok(!result.includes('export const RemoteNotificationActionMethod'));
		assert.ok(!result.includes('export const LocalCallActionMethod'));
		// No `z.enum([\n\n])` artifact anywhere.
		assert.ok(!/z\.enum\(\[\s*\]\)/.test(result));
	});

	test('empty specs emits nothing and adds no zod import', () => {
		// Defensive: every block ends up empty → helper returns '' and skips
		// the `zod` import so callers do not emit a dead import line.
		const imports = new ImportBuilder();
		const result = generate_action_method_enums([], imports);
		assert.strictEqual(result, '');
		assert.ok(!imports.has_imports());
	});
});

describe('generate_action_method_enum_block', () => {
	test('emits a single named enum block from a custom predicate', () => {
		// `BackendRequestResponseMethod` shape — methods the backend handles:
		// `kind === 'request_response' && initiator !== 'backend'`.
		const specs: ReadonlyArray<ActionSpecUnion> = [
			create_rr('frontend'), // thing_create → backend handles
			{...create_rr('backend'), method: 'pulled'}, // backend initiates → not in this set
			{...create_rr('both'), method: 'echoed'}, // either side → backend handles
			create_rn('backend'), // wrong kind → excluded by predicate
		];
		const imports = new ImportBuilder();
		const result = generate_action_method_enum_block(specs, imports, {
			name: 'BackendRequestResponseMethod',
			jsdoc: 'Names of `request_response` actions handled on the server.',
			predicate: (s) => s.kind === 'request_response' && s.initiator !== 'backend',
		});
		assert.ok(result.includes('export const BackendRequestResponseMethod = z.enum(['));
		assert.ok(
			result.includes(
				'export type BackendRequestResponseMethod = z.infer<typeof BackendRequestResponseMethod>;',
			),
		);
		assert.ok(result.includes("'thing_create'"));
		assert.ok(result.includes("'echoed'"));
		assert.ok(!result.includes("'pulled'"));
		assert.ok(!result.includes("'thing_changed'"));
		assert.ok(imports.build().includes("import {z} from 'zod';"));
	});

	test('skips empty (returns "" and registers no zod import)', () => {
		// Predicate matches nothing — must skip rather than emit `z.enum([])`,
		// and must NOT add a dead `zod` import for a block that never
		// materialized.
		const imports = new ImportBuilder();
		const result = generate_action_method_enum_block(fixture_specs, imports, {
			name: 'NeverMatches',
			jsdoc: 'Subset that never qualifies.',
			predicate: () => false,
		});
		assert.strictEqual(result, '');
		assert.ok(!imports.has_imports());
	});

	test('filters composables by default; include_composables: true puts them back', () => {
		// `heartbeat` is composable + matches "request_response, initiator
		// !== 'backend'" — verify default-exclude and opt-in re-include.
		const imports_default = new ImportBuilder();
		const default_result = generate_action_method_enum_block(fixture_specs, imports_default, {
			name: 'BackendRequestResponseMethod',
			jsdoc: 'jsdoc',
			predicate: (s) => s.kind === 'request_response' && s.initiator !== 'backend',
		});
		assert.ok(default_result.includes("'thing_create'"));
		assert.ok(!default_result.includes("'heartbeat'"));

		const imports_inclusive = new ImportBuilder();
		const inclusive_result = generate_action_method_enum_block(fixture_specs, imports_inclusive, {
			name: 'BackendRequestResponseMethod',
			jsdoc: 'jsdoc',
			predicate: (s) => s.kind === 'request_response' && s.initiator !== 'backend',
			include_composables: true,
		});
		assert.ok(inclusive_result.includes("'thing_create'"));
		assert.ok(inclusive_result.includes("'heartbeat'"));
	});

	test('emits jsdoc above the const', () => {
		const imports = new ImportBuilder();
		const result = generate_action_method_enum_block(fixture_specs, imports, {
			name: 'MyEnum',
			jsdoc: 'Custom jsdoc.',
			predicate: (s) => s.method === 'thing_create',
		});
		assert.ok(result.startsWith('/**\n * Custom jsdoc.\n */\nexport const MyEnum'));
	});
});

describe('generate_typed_action_event_alias', () => {
	test('emits the fixed-shape alias and registers all imports', () => {
		const imports = new ImportBuilder();
		const result = generate_typed_action_event_alias(imports);

		assert.ok(result.includes('type TypedActionEvent<'));
		assert.ok(result.includes('TMethod extends ActionMethod'));
		assert.ok(result.includes('TPhase extends ActionEventPhase'));
		assert.ok(result.includes('TStep extends ActionEventStep'));
		assert.ok(result.includes('& {readonly data: ActionEventDatas[TMethod]};'));

		const built = imports.build();
		assert.ok(built.includes('@fuzdev/fuz_app/actions/action_event.js'));
		assert.ok(built.includes('@fuzdev/fuz_app/actions/action_spec.js'));
		assert.ok(built.includes('@fuzdev/fuz_app/actions/action_event_types.js'));
		assert.ok(built.includes('./action_collections.js'));
		assert.ok(built.includes('./action_metatypes.js'));
		assert.ok(built.includes('ActionMethod'));
	});

	test('honors collections_path and metatypes_path overrides', () => {
		const imports = new ImportBuilder();
		generate_typed_action_event_alias(imports, {
			collections_path: '../gen/collections.js',
			metatypes_path: '../gen/metatypes.js',
		});
		const built = imports.build();
		assert.ok(built.includes("from '../gen/collections.js'"));
		assert.ok(built.includes("from '../gen/metatypes.js'"));
		assert.ok(!built.includes("from './action_collections.js'"));
		assert.ok(!built.includes("from './action_metatypes.js'"));
	});
});

describe('generate_action_specs_record', () => {
	test('emits ActionSpecs const + interface + action_specs array (composables filtered)', () => {
		const imports = new ImportBuilder();
		const result = generate_action_specs_record(fixture_specs, imports);

		assert.ok(result.includes('export const ActionSpecs = {'));
		assert.ok(result.includes('export interface ActionSpecs {'));
		assert.ok(
			result.includes(
				'export const action_specs: Array<ActionSpecUnion> = Object.values(ActionSpecs);',
			),
		);
		// Per-spec value entries — composables (heartbeat, cancel) excluded by default.
		assert.ok(result.includes('thing_create: specs.thing_create_action_spec,'));
		assert.ok(result.includes('thing_changed: specs.thing_changed_action_spec,'));
		assert.ok(result.includes('menu_toggle: specs.menu_toggle_action_spec,'));
		assert.ok(!result.includes('heartbeat: specs.heartbeat_action_spec,'));
		assert.ok(!result.includes('cancel: specs.cancel_action_spec,'));
		// Per-spec interface entries.
		assert.ok(result.includes('thing_create: typeof specs.thing_create_action_spec;'));
		// Imports the `* as specs` namespace + ActionSpecUnion type.
		const built = imports.build();
		assert.ok(built.includes("import * as specs from './action_specs.js';"));
		assert.ok(built.includes('ActionSpecUnion'));
	});

	test('include_composables: true retains heartbeat + cancel', () => {
		const imports = new ImportBuilder();
		const result = generate_action_specs_record(fixture_specs, imports, {
			include_composables: true,
		});
		assert.ok(result.includes('heartbeat: specs.heartbeat_action_spec,'));
		assert.ok(result.includes('cancel: specs.cancel_action_spec,'));
	});

	test('honors specs_module override', () => {
		const imports = new ImportBuilder();
		// Pick a non-composable spec — composables are filtered by default and
		// would short-circuit the helper before the `* as specs` import is added.
		const consumer_specs = fixture_specs.filter((s) => !is_composable_action_method(s.method));
		generate_action_specs_record(consumer_specs.slice(0, 1), imports, {
			specs_module: '../shared/action_specs.js',
		});
		assert.ok(imports.build().includes("import * as specs from '../shared/action_specs.js';"));
	});
});

describe('generate_action_inputs_outputs', () => {
	test('emits four pairs (const + interface for inputs and outputs); composables filtered', () => {
		const imports = new ImportBuilder();
		const result = generate_action_inputs_outputs(fixture_specs, imports);

		assert.ok(result.includes('export const ActionInputs = {'));
		assert.ok(result.includes('export interface ActionInputs {'));
		assert.ok(result.includes('export const ActionOutputs = {'));
		assert.ok(result.includes('export interface ActionOutputs {'));

		// Spec-derived value lines — composables filtered out by default.
		assert.ok(result.includes('thing_create: specs.thing_create_action_spec.input,'));
		assert.ok(result.includes('thing_create: specs.thing_create_action_spec.output,'));
		assert.ok(!result.includes('heartbeat: specs.heartbeat_action_spec.input,'));
		assert.ok(!result.includes('cancel: specs.cancel_action_spec.input,'));

		// `z.infer` interface entries — same exclusion.
		assert.ok(
			result.includes('thing_create: z.infer<typeof specs.thing_create_action_spec.input>;'),
		);
		assert.ok(!result.includes('heartbeat: z.infer<typeof specs.heartbeat_action_spec.input>;'));

		// Registers zod + namespace imports.
		const built = imports.build();
		assert.ok(built.includes("import {z} from 'zod';"));
		assert.ok(built.includes("import * as specs from './action_specs.js';"));
	});

	test('include_composables: true retains heartbeat + cancel', () => {
		const imports = new ImportBuilder();
		const result = generate_action_inputs_outputs(fixture_specs, imports, {
			include_composables: true,
		});
		assert.ok(result.includes('heartbeat: specs.heartbeat_action_spec.input,'));
		assert.ok(result.includes('cancel: specs.cancel_action_spec.input,'));
	});
});

describe('generate_action_event_datas', () => {
	test('selects per-kind data type and parametrizes correctly (composables filtered)', () => {
		const imports = new ImportBuilder();
		const result = generate_action_event_datas(fixture_specs, imports);

		assert.ok(result.includes('export interface ActionEventDatas {'));

		// request_response → 3-arg variant. thing_create stays; heartbeat (composable) filtered.
		assert.ok(
			result.includes(
				"thing_create: ActionEventRequestResponseData<'thing_create', ActionInputs['thing_create'], ActionOutputs['thing_create']>;",
			),
		);
		assert.ok(!result.includes("'heartbeat',"));
		assert.ok(!result.includes('heartbeat: ActionEvent'));

		// remote_notification → 2-arg variant (no output). cancel (composable) filtered.
		assert.ok(
			result.includes(
				"thing_changed: ActionEventRemoteNotificationData<'thing_changed', ActionInputs['thing_changed']>;",
			),
		);
		assert.ok(!result.includes('cancel: ActionEvent'));

		// local_call → 3-arg variant.
		assert.ok(
			result.includes(
				"menu_toggle: ActionEventLocalCallData<'menu_toggle', ActionInputs['menu_toggle'], ActionOutputs['menu_toggle']>;",
			),
		);

		// Imports the three data types (deduped by ImportBuilder).
		const built = imports.build();
		assert.ok(built.includes('ActionEventRequestResponseData'));
		assert.ok(built.includes('ActionEventRemoteNotificationData'));
		assert.ok(built.includes('ActionEventLocalCallData'));
	});

	test('default (same_file: true) does not import ActionInputs/ActionOutputs', () => {
		// Same-file convention: when ActionEventDatas is emitted into the same
		// module as ActionInputs/ActionOutputs (the zzz pattern), no import is
		// needed because they are in scope locally.
		const imports = new ImportBuilder();
		generate_action_event_datas(fixture_specs, imports);
		const built = imports.build();
		assert.ok(!built.includes('ActionInputs'));
		assert.ok(!built.includes('ActionOutputs'));
	});

	test('same_file: false adds ActionInputs/ActionOutputs imports from collections_path', () => {
		const imports = new ImportBuilder();
		generate_action_event_datas(fixture_specs, imports, {
			same_file: false,
			collections_path: '../gen/collections.js',
		});
		const built = imports.build();
		assert.ok(built.includes("from '../gen/collections.js'"));
		assert.ok(built.includes('ActionInputs'));
		assert.ok(built.includes('ActionOutputs'));
	});

	test('same_file: false defaults collections_path to ./action_collections.js', () => {
		const imports = new ImportBuilder();
		generate_action_event_datas(fixture_specs, imports, {same_file: false});
		const built = imports.build();
		assert.ok(built.includes("from './action_collections.js'"));
		assert.ok(built.includes('ActionInputs'));
		assert.ok(built.includes('ActionOutputs'));
	});

	test('collections_path alone (same_file omitted) is a no-op', () => {
		// Regression pin for the new semantic: same_file controls whether the
		// import happens; collections_path is just the path. Setting
		// collections_path with same_file omitted (default true) must NOT add
		// the import — replaces the prior surprising omit-vs-default behavior
		// where passing the literal default added an import that omitting
		// suppressed.
		const imports = new ImportBuilder();
		generate_action_event_datas(fixture_specs, imports, {
			collections_path: '../gen/collections.js',
		});
		const built = imports.build();
		assert.ok(!built.includes('ActionInputs'));
		assert.ok(!built.includes('ActionOutputs'));
	});
});

describe('generate_actions_api', () => {
	test('emits one method signature per spec; composables filtered by default', () => {
		const imports = new ImportBuilder();
		const result = generate_actions_api(fixture_specs, imports);

		assert.ok(result.includes('export interface ActionsApi {'));
		// request_response: signature with options + Promise<Result>.
		assert.ok(
			result.includes(
				"thing_create: (input: ActionInputs['thing_create'], options?: RpcClientCallOptions)",
			),
		);
		// sync local_call: direct return, no options.
		assert.ok(result.includes("menu_toggle: (input?: void) => ActionOutputs['menu_toggle'];"));
		// Composables filtered out by default.
		assert.ok(!result.includes('heartbeat:'));
		assert.ok(!result.includes('cancel:'));
		// Required imports.
		const built = imports.build();
		assert.ok(built.includes('Result'));
		assert.ok(built.includes('JsonrpcErrorObject'));
		assert.ok(built.includes('RpcClientCallOptions'));
		assert.ok(built.includes('ActionInputs'));
		assert.ok(built.includes('ActionOutputs'));
	});

	test('include_composables: true retains heartbeat + cancel', () => {
		const imports = new ImportBuilder();
		const result = generate_actions_api(fixture_specs, imports, {include_composables: true});
		assert.ok(
			result.includes(
				"heartbeat: (input: ActionInputs['heartbeat'], options?: RpcClientCallOptions)",
			),
		);
		assert.ok(result.includes('cancel:'));
	});

	test('method_filter runs on top of the composable filter', () => {
		// Verifies composition: composables removed first, then method_filter
		// narrows the consumer-owned remainder.
		const imports = new ImportBuilder();
		const result = generate_actions_api(fixture_specs, imports, {
			method_filter: (s) => s.kind === 'request_response',
		});
		assert.ok(result.includes('thing_create:'));
		assert.ok(!result.includes('heartbeat:')); // composable filter
		assert.ok(!result.includes('cancel:'));
		assert.ok(!result.includes('menu_toggle:')); // method_filter
		assert.ok(!result.includes('thing_changed:'));
	});
});

describe('generate_frontend_action_handlers', () => {
	test('emits FrontendActionHandlers with per-spec phase blocks', () => {
		const imports = new ImportBuilder();
		const result = generate_frontend_action_handlers(fixture_specs, imports);

		assert.ok(result.includes('export interface FrontendActionHandlers {'));
		// frontend executor on a 'frontend' rr spec → send_request, receive_response, send_error, receive_error.
		assert.ok(result.includes('thing_create?: {'));
		assert.ok(result.includes('send_request?:'));
		assert.ok(result.includes('receive_response?:'));
		// frontend executor on a 'backend' rn spec → receive only.
		assert.ok(result.includes('thing_changed?: {'));
		assert.ok(result.includes('receive?:'));
		// Wraps with the TypedActionEvent action_event_type — does NOT register the
		// default ActionEvent import.
		assert.ok(result.includes('TypedActionEvent<'));
		const built = imports.build();
		assert.ok(!built.includes('import type {ActionEvent}'));
	});

	test('honors collections_path option for the ActionOutputs side-effect import', () => {
		const imports = new ImportBuilder();
		generate_frontend_action_handlers(fixture_specs, imports, {
			collections_path: '../gen/action_collections.js',
		});
		assert.ok(imports.build().includes("from '../gen/action_collections.js'"));
	});
});

describe('generate_backend_actions_api', () => {
	test('filters to backend-initiated remote_notification specs', () => {
		const imports = new ImportBuilder();
		const result = generate_backend_actions_api(fixture_specs, imports);

		assert.ok(result.includes('export interface BackendActionsApi {'));
		// thing_changed (remote_notification, backend initiator) is in.
		assert.ok(
			result.includes("thing_changed: (input: ActionInputs['thing_changed']) => Promise<void>;"),
		);
		// cancel (remote_notification, frontend initiator) is OUT.
		assert.ok(!result.includes('cancel:'));
		// thing_create (request_response) is OUT.
		assert.ok(!result.includes('thing_create:'));
		// menu_toggle (local_call) is OUT.
		assert.ok(!result.includes('menu_toggle:'));

		// Emits the broadcast_action_specs runtime array alongside the interface.
		assert.ok(
			result.includes('export const broadcast_action_specs: ReadonlyArray<ActionSpecUnion> = ['),
		);
		assert.ok(result.includes('specs.thing_changed_action_spec,'));
		assert.ok(!result.includes('specs.cancel_action_spec,'));

		// Adds the namespace + collections + ActionSpecUnion imports automatically.
		const built = imports.build();
		assert.ok(built.includes("import * as specs from './action_specs.js';"));
		assert.ok(built.includes("from './action_collections.js'"));
		assert.ok(built.includes('ActionInputs'));
		assert.ok(built.includes('ActionSpecUnion'));
	});

	test('returns empty interface body and array when no specs match; skips dead imports', () => {
		const imports = new ImportBuilder();
		const only_rr: ReadonlyArray<ActionSpecUnion> = [create_rr('frontend')];
		const result = generate_backend_actions_api(only_rr, imports);

		assert.ok(result.includes('export interface BackendActionsApi {}'));
		assert.ok(
			result.includes('export const broadcast_action_specs: ReadonlyArray<ActionSpecUnion> = [];'),
		);
		// Dead-import skip: only `ActionSpecUnion` is referenced; `* as specs`
		// and `ActionInputs` would have nothing to reference.
		const built = imports.build();
		assert.ok(built.includes('ActionSpecUnion'));
		assert.ok(!built.includes('* as specs'));
		assert.ok(!built.includes('ActionInputs'));
	});

	test('honors specs_module and collections_path overrides', () => {
		const imports = new ImportBuilder();
		generate_backend_actions_api(fixture_specs, imports, {
			specs_module: '../shared/action_specs.js',
			collections_path: '../gen/collections.js',
		});
		const built = imports.build();
		assert.ok(built.includes("import * as specs from '../shared/action_specs.js';"));
		assert.ok(built.includes("from '../gen/collections.js'"));
	});
});

// --- qualify_spec — multi-source consumer support ---------------------------
//
// Multi-source consumers (tx, visiones) stitch local specs together with
// upstream `all_*_action_specs` arrays from fuz_app. Each spec resolves to
// a different namespace at codegen time, so the helpers' default
// `* as specs` import doesn't cover every method. `qualify_spec?` lets the
// consumer return a per-spec qualified identifier and manage its own
// namespace imports; the helper skips the default `* as specs` import.

describe('qualify_spec', () => {
	// tx-style mapping: thing_* lives locally, the rest comes from a shared
	// upstream namespace. Returns the bare spec identifier; the helpers
	// append `.input` / `.output` themselves where applicable.
	const ns_for = (method: string): string =>
		method.startsWith('thing') || method === 'menu_toggle' ? 'local_specs' : 'shared_specs';
	const qualify_spec = (s: ActionSpecUnion): string =>
		`${ns_for(s.method)}.${s.method}_action_spec`;

	test('generate_action_specs_record uses qualified identifiers and skips * as specs', () => {
		const imports = new ImportBuilder();
		const result = generate_action_specs_record(fixture_specs, imports, {qualify_spec});

		assert.ok(result.includes('thing_create: local_specs.thing_create_action_spec,'));
		assert.ok(result.includes('thing_changed: local_specs.thing_changed_action_spec,'));
		assert.ok(result.includes('menu_toggle: local_specs.menu_toggle_action_spec,'));
		assert.ok(result.includes('typeof local_specs.thing_create_action_spec;'));
		// Default `specs.${method}_action_spec` form must not leak through —
		// anchor on the leading tab + method to avoid `local_specs.foo`
		// matching as a superset of `specs.foo`.
		assert.ok(!result.includes('\tthing_create: specs.thing_create_action_spec,'));

		const built = imports.build();
		// No `* as specs` import — consumer manages namespace imports.
		assert.ok(!built.includes('* as specs'));
		// ActionSpecUnion type still imported for the array signature.
		assert.ok(built.includes('ActionSpecUnion'));
	});

	test('generate_action_specs_record ignores specs_module when qualify_spec is set', () => {
		const imports = new ImportBuilder();
		generate_action_specs_record(fixture_specs, imports, {
			qualify_spec,
			specs_module: '../shared/action_specs.js',
		});
		const built = imports.build();
		assert.ok(!built.includes('../shared/action_specs.js'));
		assert.ok(!built.includes('* as specs'));
	});

	test('generate_action_inputs_outputs uses qualified .input/.output identifiers', () => {
		const imports = new ImportBuilder();
		const result = generate_action_inputs_outputs(fixture_specs, imports, {qualify_spec});

		assert.ok(result.includes('thing_create: local_specs.thing_create_action_spec.input,'));
		assert.ok(result.includes('thing_create: local_specs.thing_create_action_spec.output,'));
		assert.ok(
			result.includes('thing_create: z.infer<typeof local_specs.thing_create_action_spec.input>;'),
		);
		// Default form must not leak — anchor on the leading tab + method.
		assert.ok(!result.includes('\tthing_create: specs.thing_create_action_spec.input,'));

		const built = imports.build();
		assert.ok(!built.includes('* as specs'));
		// zod still required for z.infer.
		assert.ok(built.includes("import {z} from 'zod';"));
	});

	test('generate_backend_actions_api uses qualified spec references in array', () => {
		const imports = new ImportBuilder();
		const result = generate_backend_actions_api(fixture_specs, imports, {qualify_spec});

		// thing_changed is the only backend-initiated remote_notification in
		// the fixture; it must be qualified with local_specs.
		assert.ok(result.includes('\tlocal_specs.thing_changed_action_spec,'));
		// Default form must not leak — anchor on the leading tab.
		assert.ok(!result.includes('\tspecs.thing_changed_action_spec,'));

		const built = imports.build();
		assert.ok(!built.includes('* as specs'));
		// ActionInputs + ActionSpecUnion still imported.
		assert.ok(built.includes('ActionInputs'));
		assert.ok(built.includes('ActionSpecUnion'));
	});

	test('multi-namespace lookup — different specs route to different namespaces', () => {
		// Verifies the callback can switch on per-spec data (not just method),
		// matching tx's `method_to_ns` lookup pattern.
		const mixed_qualify = (s: ActionSpecUnion): string =>
			s.kind === 'local_call'
				? `client_specs.${s.method}_action_spec`
				: `wire_specs.${s.method}_action_spec`;
		const imports = new ImportBuilder();
		const result = generate_action_specs_record(fixture_specs, imports, {
			qualify_spec: mixed_qualify,
		});
		assert.ok(result.includes('thing_create: wire_specs.thing_create_action_spec,'));
		assert.ok(result.includes('menu_toggle: client_specs.menu_toggle_action_spec,'));
	});
});

// --- empty-input behavior across helpers -------------------------------------
//
// Every spec-iterating helper short-circuits on an empty filtered list,
// emits a clean `{}` body, and skips imports that would have nothing to
// reference. Pin the contract here so future refactors do not regress.

describe('empty-input behavior', () => {
	test('generate_action_specs_record — empty body, skips `* as specs` import', () => {
		const imports = new ImportBuilder();
		const result = generate_action_specs_record([], imports);
		assert.ok(result.includes('export const ActionSpecs = {} as const;'));
		assert.ok(result.includes('export interface ActionSpecs {}'));
		assert.ok(
			result.includes('export const action_specs: Array<ActionSpecUnion> = Object.values('),
		);
		const built = imports.build();
		assert.ok(built.includes('ActionSpecUnion')); // referenced in the array type
		assert.ok(!built.includes('* as specs'));
	});

	test('generate_action_inputs_outputs — empty bodies, skips zod + specs imports', () => {
		const imports = new ImportBuilder();
		const result = generate_action_inputs_outputs([], imports);
		assert.ok(result.includes('export const ActionInputs = {} as const;'));
		assert.ok(result.includes('export interface ActionInputs {}'));
		assert.ok(result.includes('export const ActionOutputs = {} as const;'));
		assert.ok(result.includes('export interface ActionOutputs {}'));
		assert.ok(!imports.has_imports());
	});

	test('generate_action_event_datas — empty body, skips imports even with same_file: false', () => {
		const imports = new ImportBuilder();
		const result = generate_action_event_datas([], imports, {
			same_file: false,
			collections_path: './action_collections.js',
		});
		assert.ok(result.includes('export interface ActionEventDatas {}'));
		// `same_file: false` would normally add the import, but the body is
		// empty so the short-circuit fires before any import logic runs.
		assert.ok(!imports.has_imports());
	});

	test('generate_actions_api — empty body, skips every import', () => {
		const imports = new ImportBuilder();
		const result = generate_actions_api([], imports);
		assert.ok(result.includes('export interface ActionsApi {}'));
		assert.ok(!imports.has_imports());
	});

	test('generate_actions_api — method_filter producing empty also skips imports', () => {
		// Composables are filtered by default; `method_filter` rejects everything
		// else → filtered is empty → no imports emitted.
		const imports = new ImportBuilder();
		const result = generate_actions_api(fixture_specs, imports, {method_filter: () => false});
		assert.ok(result.includes('export interface ActionsApi {}'));
		assert.ok(!imports.has_imports());
	});

	test('generate_frontend_action_handlers — empty body, no dangling semicolon', () => {
		const imports = new ImportBuilder();
		const result = generate_frontend_action_handlers([], imports);
		assert.ok(result.includes('export interface FrontendActionHandlers {}'));
		// Regression pin: the prior implementation emitted `{\n;\n}` here.
		assert.ok(!/\{\s*;\s*\}/.test(result));
		assert.ok(!imports.has_imports());
	});

	test('all-composable spec list filters down to empty (default behavior)', () => {
		// Spec list with only composables → filtered is empty → empty body
		// without the consumer needing to pre-filter.
		const all_composables: ReadonlyArray<ActionSpecUnion> = fixture_specs.filter((s) =>
			is_composable_action_method(s.method),
		);
		const imports = new ImportBuilder();
		const result = generate_actions_api(all_composables, imports);
		assert.ok(result.includes('export interface ActionsApi {}'));
		assert.ok(!imports.has_imports());
	});
});
