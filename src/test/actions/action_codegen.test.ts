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
	side_effects: null,
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
		assert.ok(result.includes('Frontend'));
		// Verify imports were added
		const built = imports.build();
		assert.ok(built.includes('ActionEvent'));
		assert.ok(built.includes('Frontend'));
		assert.ok(built.includes('./action_event.js'));
		assert.ok(built.includes('./frontend.svelte.js'));
	});

	test('generates handler definitions for backend executor', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(create_rr('frontend'), 'backend', imports);
		assert.ok(result.includes('receive_request'));
		assert.ok(result.includes('send_response'));
		assert.ok(result.includes('Backend'));
		// Backend uses ../ path prefix
		const built = imports.build();
		assert.ok(built.includes('../action_event.js'));
		assert.ok(built.includes('./backend.js'));
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
		const result = get_handler_return_type(create_rr('frontend'), 'receive_request', imports, './');
		assert.ok(result.includes("ActionOutputs['thing_create']"));
		assert.ok(result.includes('Promise'));
	});

	test('receive_request adds ActionOutputs import', () => {
		const imports = new ImportBuilder();
		get_handler_return_type(create_rr('frontend'), 'receive_request', imports, './');
		assert.ok(imports.has_imports());
	});

	test('local_call execute with async returns union type', () => {
		const imports = new ImportBuilder();
		const result = get_handler_return_type(create_lc('frontend', true), 'execute', imports, './');
		assert.ok(result.includes("ActionOutputs['toggle_menu']"));
		assert.ok(result.includes('Promise'));
	});

	test('local_call execute without async returns direct type', () => {
		const imports = new ImportBuilder();
		const result = get_handler_return_type(create_lc('frontend', false), 'execute', imports, './');
		assert.ok(result.includes("ActionOutputs['toggle_menu']"));
		assert.ok(!result.includes('Promise'));
	});

	test('other phases return void', () => {
		const imports = new ImportBuilder();
		const result = get_handler_return_type(create_rr('frontend'), 'send_request', imports, './');
		assert.strictEqual(result, 'void | Promise<void>');
	});
});
