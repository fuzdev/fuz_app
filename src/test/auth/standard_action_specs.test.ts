/**
 * Tests for `all_standard_action_specs` — the aggregate spec registry that
 * mirrors `create_standard_rpc_actions` on the frontend.
 *
 * Symmetry checks: count adds up, no duplicates, and every method the
 * runtime factory mounts is present in the spec list. The reverse —
 * every spec is mounted — also holds.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { all_standard_action_specs } from '$lib/auth/standard_action_specs.ts';
import { all_admin_action_specs } from '$lib/auth/admin_action_specs.ts';
import { all_role_grant_offer_action_specs } from '$lib/auth/role_grant_offer_action_specs.ts';
import { all_account_action_specs } from '$lib/auth/account_action_specs.ts';
import { create_standard_rpc_actions } from '$lib/auth/standard_rpc_actions.ts';
import { create_test_audit_emitter } from '$lib/testing/stubs.ts';

const log = new Logger('test', { level: 'off' });
const deps = { log, audit: create_test_audit_emitter() };

describe('all_standard_action_specs', () => {
	test('count equals the sum of the three sub-registries', () => {
		assert.strictEqual(
			all_standard_action_specs.length,
			all_admin_action_specs.length +
				all_role_grant_offer_action_specs.length +
				all_account_action_specs.length
		);
	});

	test('no method appears twice', () => {
		const methods = all_standard_action_specs.map((s) => s.method);
		assert.strictEqual(methods.length, new Set(methods).size, 'duplicate methods in registry');
	});

	test('every method from the three sub-registries is present', () => {
		const methods = new Set(all_standard_action_specs.map((s) => s.method));
		for (const spec of all_admin_action_specs) {
			assert.isTrue(methods.has(spec.method), `missing admin method ${spec.method}`);
		}
		for (const spec of all_role_grant_offer_action_specs) {
			assert.isTrue(methods.has(spec.method), `missing role-grant-offer method ${spec.method}`);
		}
		for (const spec of all_account_action_specs) {
			assert.isTrue(methods.has(spec.method), `missing account method ${spec.method}`);
		}
	});

	test('order is admin → role_grant_offer → account (stability pin)', () => {
		const methods = all_standard_action_specs.map((s) => s.method);
		const first_admin = methods.indexOf(all_admin_action_specs[0]!.method);
		const first_offer = methods.indexOf(all_role_grant_offer_action_specs[0]!.method);
		const first_account = methods.indexOf(all_account_action_specs[0]!.method);
		assert.ok(first_admin >= 0);
		assert.ok(first_offer >= 0);
		assert.ok(first_account >= 0);
		assert.ok(first_admin < first_offer, 'admin must precede role_grant_offer');
		assert.ok(first_offer < first_account, 'role_grant_offer must precede account');
	});

	test('is a superset of create_standard_rpc_actions handler-list methods', () => {
		// Every method the runtime mounts must have a matching spec in the
		// registry so the typed Proxy can dispatch every method.
		const handler_methods = create_standard_rpc_actions(deps).map((a) => a.spec.method);
		const spec_methods = new Set(all_standard_action_specs.map((s) => s.method));
		for (const method of handler_methods) {
			assert.isTrue(spec_methods.has(method), `runtime mounts ${method} but registry omits it`);
		}
		// And the reverse — every registry spec is mounted. This pins the
		// inverse to fail fast if someone adds a spec to a sub-registry but
		// forgets the handler.
		const handler_set = new Set(handler_methods);
		for (const spec of all_standard_action_specs) {
			assert.isTrue(
				handler_set.has(spec.method),
				`registry has ${spec.method} but create_standard_rpc_actions doesn't mount it`
			);
		}
	});
});
