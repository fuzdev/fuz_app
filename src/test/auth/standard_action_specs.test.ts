/**
 * Tests for `all_standard_action_specs` — the aggregate spec registry that
 * mirrors `create_standard_rpc_actions` on the frontend.
 *
 * Symmetry checks: count adds up, no duplicates, and every method the
 * runtime factory mounts (with `app_settings` wired) is present in the
 * spec list. The reverse — every spec is mounted — also holds when
 * `app_settings` is supplied.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {all_standard_action_specs} from '$lib/auth/standard_action_specs.js';
import {all_admin_action_specs} from '$lib/auth/admin_action_specs.js';
import {all_permit_offer_action_specs} from '$lib/auth/permit_offer_action_specs.js';
import {all_account_action_specs} from '$lib/auth/account_action_specs.js';
import {create_standard_rpc_actions} from '$lib/auth/standard_rpc_actions.js';
import type {AppSettings} from '$lib/auth/app_settings_schema.js';

const log = new Logger('test', {level: 'off'});
const deps = {log, on_audit_event: () => {}};

const make_app_settings = (): AppSettings => ({
	open_signup: false,
	updated_at: null,
	updated_by: null,
});

describe('all_standard_action_specs', () => {
	test('count equals the sum of the three sub-registries', () => {
		assert.strictEqual(
			all_standard_action_specs.length,
			all_admin_action_specs.length +
				all_permit_offer_action_specs.length +
				all_account_action_specs.length,
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
		for (const spec of all_permit_offer_action_specs) {
			assert.isTrue(methods.has(spec.method), `missing permit-offer method ${spec.method}`);
		}
		for (const spec of all_account_action_specs) {
			assert.isTrue(methods.has(spec.method), `missing account method ${spec.method}`);
		}
	});

	test('order is admin → permit_offer → account (stability pin)', () => {
		const methods = all_standard_action_specs.map((s) => s.method);
		const first_admin = methods.indexOf(all_admin_action_specs[0]!.method);
		const first_offer = methods.indexOf(all_permit_offer_action_specs[0]!.method);
		const first_account = methods.indexOf(all_account_action_specs[0]!.method);
		assert.ok(first_admin >= 0);
		assert.ok(first_offer >= 0);
		assert.ok(first_account >= 0);
		assert.ok(first_admin < first_offer, 'admin must precede permit_offer');
		assert.ok(first_offer < first_account, 'permit_offer must precede account');
	});

	test('is a superset of create_standard_rpc_actions handler-list methods', () => {
		// With `app_settings` wired, every method the runtime mounts must
		// have a matching spec in the registry so the typed Proxy can
		// dispatch every method.
		const handler_methods = create_standard_rpc_actions(deps, {
			app_settings: make_app_settings(),
		}).map((a) => a.spec.method);
		const spec_methods = new Set(all_standard_action_specs.map((s) => s.method));
		for (const method of handler_methods) {
			assert.isTrue(spec_methods.has(method), `runtime mounts ${method} but registry omits it`);
		}
		// And the reverse — every registry spec is mounted when
		// `app_settings` is supplied. This pins the inverse to fail fast
		// if someone adds a spec to a sub-registry but forgets the handler.
		const handler_set = new Set(handler_methods);
		for (const spec of all_standard_action_specs) {
			assert.isTrue(
				handler_set.has(spec.method),
				`registry has ${spec.method} but create_standard_rpc_actions doesn't mount it`,
			);
		}
	});
});
