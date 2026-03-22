/**
 * Tests for action_registry.ts — ActionRegistry filtering and query methods.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {z} from 'zod';

import {ActionRegistry} from '$lib/actions/action_registry.js';

// Minimal spec factories — plain objects that satisfy ActionSpecUnion discriminants

const rr = (
	method: string,
	initiator: 'frontend' | 'backend' | 'both' = 'frontend',
	auth: 'public' | 'authenticated' = 'authenticated',
) =>
	({
		method,
		kind: 'request_response' as const,
		initiator,
		auth,
		side_effects: true as const,
		input: z.null(),
		output: z.null(),
		async: true as const,
		description: method,
	}) as const;

const rn = (method: string, initiator: 'frontend' | 'backend' | 'both' = 'backend') =>
	({
		method,
		kind: 'remote_notification' as const,
		initiator,
		auth: null,
		side_effects: true as const,
		input: z.null(),
		output: z.void(),
		async: true as const,
		description: method,
	}) as const;

const lc = (method: string) =>
	({
		method,
		kind: 'local_call' as const,
		initiator: 'frontend' as const,
		auth: null,
		side_effects: null,
		input: z.null(),
		output: z.null(),
		async: false as const,
		description: method,
	}) as const;

describe('ActionRegistry', () => {
	test('empty registry has empty arrays and map', () => {
		const registry = new ActionRegistry([]);
		assert.deepEqual(registry.methods, []);
		assert.deepEqual(registry.specs, []);
		assert.strictEqual(registry.spec_by_method.size, 0);
	});

	test('single spec registry', () => {
		const registry = new ActionRegistry([rr('ping')]);
		assert.strictEqual(registry.specs.length, 1);
		assert.deepEqual(registry.methods, ['ping']);
	});

	describe('kind filtering', () => {
		const specs = [rr('a'), rr('b'), rn('c'), lc('d')];
		const registry = new ActionRegistry(specs);

		test('request_response_specs filters to request_response', () => {
			const result = registry.request_response_specs;
			assert.strictEqual(result.length, 2);
			assert.ok(result.every((s) => (s.kind as string) === 'request_response'));
		});

		test('remote_notification_specs filters to remote_notification', () => {
			const result = registry.remote_notification_specs;
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0]!.method, 'c');
		});

		test('local_call_specs filters to local_call', () => {
			const result = registry.local_call_specs;
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0]!.method, 'd');
		});

		test('backend_specs excludes local_call', () => {
			const result = registry.backend_specs;
			assert.strictEqual(result.length, 3);
			assert.ok(result.every((s) => s.kind !== 'local_call'));
		});

		test('frontend_specs returns all specs', () => {
			assert.strictEqual(registry.frontend_specs.length, specs.length);
		});

		test('all same kind', () => {
			const all_rr = new ActionRegistry([rr('x'), rr('y'), rr('z')]);
			assert.strictEqual(all_rr.request_response_specs.length, 3);
			assert.strictEqual(all_rr.remote_notification_specs.length, 0);
			assert.strictEqual(all_rr.local_call_specs.length, 0);
		});
	});

	describe('initiator filtering', () => {
		const specs = [
			rr('fe_only', 'frontend'),
			rr('be_only', 'backend'),
			rr('both_sides', 'both'),
			rn('notif_be', 'backend'),
		];
		const registry = new ActionRegistry(specs);

		test('frontend_to_backend_specs includes frontend and both', () => {
			const result = registry.frontend_to_backend_specs;
			assert.strictEqual(result.length, 2);
			const methods = result.map((s) => s.method);
			assert.ok(methods.includes('fe_only'));
			assert.ok(methods.includes('both_sides'));
		});

		test('backend_to_frontend_specs includes backend and both', () => {
			const result = registry.backend_to_frontend_specs;
			assert.strictEqual(result.length, 3);
			const methods = result.map((s) => s.method);
			assert.ok(methods.includes('be_only'));
			assert.ok(methods.includes('both_sides'));
			assert.ok(methods.includes('notif_be'));
		});

		test('both initiator is counted in both directions', () => {
			const registry2 = new ActionRegistry([rr('x', 'both')]);
			assert.strictEqual(registry2.frontend_to_backend_specs.length, 1);
			assert.strictEqual(registry2.backend_to_frontend_specs.length, 1);
		});
	});

	describe('auth filtering', () => {
		const specs = [
			rr('pub1', 'frontend', 'public'),
			rr('pub2', 'frontend', 'public'),
			rr('auth1', 'frontend', 'authenticated'),
			rn('notif'), // auth: null
			lc('local'), // auth: null
		];
		const registry = new ActionRegistry(specs);

		test('public_specs filters to public auth', () => {
			const result = registry.public_specs;
			assert.strictEqual(result.length, 2);
			assert.ok(result.every((s) => s.auth === 'public'));
		});

		test('authenticated_specs filters to authenticated auth', () => {
			const result = registry.authenticated_specs;
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0]!.method, 'auth1');
		});

		test('null auth excluded from both public and authenticated', () => {
			assert.ok(registry.public_specs.every((s) => s.auth !== null));
			assert.ok(registry.authenticated_specs.every((s) => s.auth !== null));
			// remote_notification and local_call have null auth — not in either
			const all_filtered = [...registry.public_specs, ...registry.authenticated_specs];
			assert.ok(!all_filtered.some((s) => s.method === 'notif'));
			assert.ok(!all_filtered.some((s) => s.method === 'local'));
		});
	});

	describe('method getters', () => {
		const specs = [rr('a'), rn('b'), lc('c')];
		const registry = new ActionRegistry(specs);

		test('methods returns all methods', () => {
			assert.deepEqual(registry.methods, ['a', 'b', 'c']);
		});

		test('request_response_methods mirrors request_response_specs methods', () => {
			assert.deepEqual(
				registry.request_response_methods,
				registry.request_response_specs.map((s) => s.method),
			);
		});

		test('remote_notification_methods mirrors remote_notification_specs methods', () => {
			assert.deepEqual(
				registry.remote_notification_methods,
				registry.remote_notification_specs.map((s) => s.method),
			);
		});

		test('local_call_methods mirrors local_call_specs methods', () => {
			assert.deepEqual(
				registry.local_call_methods,
				registry.local_call_specs.map((s) => s.method),
			);
		});

		test('public_methods mirrors public_specs methods', () => {
			const r2 = new ActionRegistry([
				rr('p', 'frontend', 'public'),
				rr('q', 'frontend', 'authenticated'),
			]);
			assert.deepEqual(
				r2.public_methods,
				r2.public_specs.map((s) => s.method),
			);
		});

		test('authenticated_methods mirrors authenticated_specs methods', () => {
			const r2 = new ActionRegistry([
				rr('p', 'frontend', 'public'),
				rr('q', 'frontend', 'authenticated'),
			]);
			assert.deepEqual(
				r2.authenticated_methods,
				r2.authenticated_specs.map((s) => s.method),
			);
		});

		test('backend_methods mirrors backend_specs methods', () => {
			assert.deepEqual(
				registry.backend_methods,
				registry.backend_specs.map((s) => s.method),
			);
		});

		test('frontend_methods equals all methods', () => {
			assert.deepEqual(registry.frontend_methods, registry.methods);
		});
	});

	describe('returned arrays are independent copies', () => {
		test('mutating methods does not affect registry', () => {
			const registry = new ActionRegistry([rr('a'), rn('b'), lc('c')]);
			const methods = registry.methods;
			const original_length = methods.length;
			methods.push('injected');
			assert.strictEqual(registry.methods.length, original_length);
		});

		test('mutating specs does not affect registry', () => {
			const registry = new ActionRegistry([rr('a'), rn('b')]);
			const specs = registry.request_response_specs;
			const original_length = specs.length;
			specs.pop();
			assert.strictEqual(registry.request_response_specs.length, original_length);
		});
	});

	describe('spec_by_method', () => {
		const spec_a = rr('thing_create');
		const spec_b = rn('thing_created');
		const registry = new ActionRegistry([spec_a, spec_b]);

		test('returns a map keyed by method name', () => {
			const map = registry.spec_by_method;
			assert.strictEqual(map.size, 2);
			assert.strictEqual(map.get('thing_create')?.method, 'thing_create');
			assert.strictEqual(map.get('thing_created')?.method, 'thing_created');
		});

		test('returns undefined for unknown method', () => {
			assert.strictEqual(registry.spec_by_method.get('unknown'), undefined);
		});
	});
});
