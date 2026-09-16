/**
 * Unit tests for `build_action_manifest` — the spec → normalized
 * `ActionManifestEntry` mapper the cross-impl manifest-parity gate dumps.
 *
 * Pins the normalization contract both impls must match: auth axes pass
 * through, `roles` / `credential_types` flatten to sorted arrays (absent and
 * empty both → `[]`), `side_effects` passes through, and entries sort by
 * `method`. A drift in any of these would surface as a spurious cross-impl
 * diff, so they're pinned here in-process.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	action_manifest_entry,
	build_action_manifest
} from '$lib/testing/cross_backend/action_manifest.ts';
import type { RouteAuth } from '$lib/http/auth_shape.ts';

const spec = (
	method: string,
	auth: RouteAuth,
	side_effects = false
): { method: string; auth: RouteAuth; side_effects: boolean } => ({ method, auth, side_effects });

describe('action_manifest_entry', () => {
	test('passes the auth axes + side_effects through', () => {
		const entry = action_manifest_entry(
			spec(
				'admin_account_list',
				{ account: 'required', actor: 'required', roles: ['admin'] },
				false
			)
		);
		assert.deepStrictEqual(entry, {
			method: 'admin_account_list',
			side_effects: false,
			account: 'required',
			actor: 'required',
			roles: ['admin'],
			credential_types: []
		});
	});

	test('absent roles + credential_types normalize to empty arrays', () => {
		const entry = action_manifest_entry(
			spec('account_verify', { account: 'required', actor: 'none' })
		);
		assert.deepStrictEqual(entry.roles, []);
		assert.deepStrictEqual(entry.credential_types, []);
	});

	test('roles + credential_types are sorted (order-independent across impls)', () => {
		const entry = action_manifest_entry(
			spec('x', {
				account: 'required',
				actor: 'required',
				roles: ['keeper', 'admin'],
				credential_types: ['session', 'daemon_token']
			})
		);
		assert.deepStrictEqual(entry.roles, ['admin', 'keeper']);
		assert.deepStrictEqual(entry.credential_types, ['daemon_token', 'session']);
	});

	test('side_effects passes through for mutations', () => {
		const entry = action_manifest_entry(
			spec('account_token_create', { account: 'required', actor: 'none' }, true)
		);
		assert.strictEqual(entry.side_effects, true);
	});
});

describe('build_action_manifest', () => {
	test('empty input produces an empty manifest', () => {
		assert.deepStrictEqual(build_action_manifest([]), { methods: [] });
	});

	test('entries are sorted by method (byte-lexicographic, matching the Rust stub)', () => {
		const manifest = build_action_manifest([
			spec('zebra', { account: 'none', actor: 'none' }),
			spec('alpha', { account: 'none', actor: 'none' }),
			spec('_testing_action_manifest', {
				account: 'required',
				actor: 'none',
				credential_types: ['daemon_token']
			})
		]);
		assert.deepStrictEqual(
			manifest.methods.map((m) => m.method),
			['_testing_action_manifest', 'alpha', 'zebra']
		);
	});
});
