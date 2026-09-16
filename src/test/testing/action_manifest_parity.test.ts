/**
 * Unit tests for the cross-impl action-manifest diff + format helpers.
 *
 * Covers every `ActionManifestDiff` kind via minimal hand-built manifests —
 * the per-field tests under `auth_field_differs` also act as a coverage check
 * on the `AUTH_SCALAR_FIELDS` / `AUTH_LIST_FIELDS` iteration sets: a member
 * missing from either produces zero diffs and fails the corresponding test.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	assert_action_manifests_equal,
	diff_action_manifests,
	format_action_manifest_diffs
} from '$lib/testing/cross_backend/action_manifest_parity.ts';
import type {
	ActionManifest,
	ActionManifestEntry
} from '$lib/testing/cross_backend/action_manifest.ts';

const entry = (overrides: Partial<ActionManifestEntry> = {}): ActionManifestEntry => ({
	method: 'm',
	side_effects: false,
	account: 'required',
	actor: 'none',
	roles: [],
	credential_types: [],
	...overrides
});

const manifest = (...methods: Array<ActionManifestEntry>): ActionManifest => ({ methods });

describe('diff_action_manifests', () => {
	test('empty manifests produce no diff', () => {
		assert.deepStrictEqual(diff_action_manifests(manifest(), manifest()), []);
	});

	test('matching manifests produce no diff', () => {
		const m = manifest(
			entry({ method: 'a', roles: ['admin'] }),
			entry({ method: 'b', side_effects: true, credential_types: ['daemon_token'] })
		);
		assert.deepStrictEqual(diff_action_manifests(m, m), []);
	});

	test('method_only_in (both sides)', () => {
		const diffs = diff_action_manifests(
			manifest(entry({ method: 'only_a' })),
			manifest(entry({ method: 'only_b' }))
		);
		// Methods iterate in sorted order: only_a (a-side) before only_b (b-side).
		assert.deepStrictEqual(diffs, [
			{ kind: 'method_only_in', where: 'a', method: 'only_a' },
			{ kind: 'method_only_in', where: 'b', method: 'only_b' }
		]);
	});

	test('side_effects_differ', () => {
		const diffs = diff_action_manifests(
			manifest(entry({ method: 'm', side_effects: false })),
			manifest(entry({ method: 'm', side_effects: true }))
		);
		assert.deepStrictEqual(diffs, [
			{ kind: 'side_effects_differ', method: 'm', a: false, b: true }
		]);
	});

	// Per-field auth diffs — also acts as an exhaustiveness check on
	// AUTH_SCALAR_FIELDS / AUTH_LIST_FIELDS.
	test('auth_field_differs: account', () => {
		const diffs = diff_action_manifests(
			manifest(entry({ account: 'required' })),
			manifest(entry({ account: 'optional' }))
		);
		assert.deepStrictEqual(diffs, [
			{ kind: 'auth_field_differs', method: 'm', field: 'account', a: 'required', b: 'optional' }
		]);
	});

	test('auth_field_differs: actor', () => {
		const diffs = diff_action_manifests(
			manifest(entry({ actor: 'none' })),
			manifest(entry({ actor: 'required' }))
		);
		assert.strictEqual(diffs.length, 1);
		assert.strictEqual(diffs[0]?.kind === 'auth_field_differs' && diffs[0].field, 'actor');
	});

	test('auth_field_differs: roles (set membership)', () => {
		const diffs = diff_action_manifests(
			manifest(entry({ roles: ['admin'] })),
			manifest(entry({ roles: ['keeper'] }))
		);
		assert.deepStrictEqual(diffs, [
			{ kind: 'auth_field_differs', method: 'm', field: 'roles', a: ['admin'], b: ['keeper'] }
		]);
	});

	test('auth_field_differs: credential_types', () => {
		const diffs = diff_action_manifests(
			manifest(entry({ credential_types: ['daemon_token'] })),
			manifest(entry({ credential_types: ['session'] }))
		);
		assert.strictEqual(diffs.length, 1);
		assert.strictEqual(
			diffs[0]?.kind === 'auth_field_differs' && diffs[0].field,
			'credential_types'
		);
	});

	test('equal-but-pre-sorted lists produce no diff', () => {
		// build_action_manifest sorts lists, so a matching set compares equal.
		const m = manifest(entry({ roles: ['admin', 'keeper'], credential_types: ['daemon_token'] }));
		assert.deepStrictEqual(diff_action_manifests(m, m), []);
	});

	test('multi-field auth drift on one method emits one diff per field', () => {
		const diffs = diff_action_manifests(
			manifest(entry({ account: 'required', actor: 'none', roles: [] })),
			manifest(entry({ account: 'optional', actor: 'required', roles: ['admin'] }))
		);
		const fields = diffs
			.filter((d) => d.kind === 'auth_field_differs')
			.map((d) => (d.kind === 'auth_field_differs' ? d.field : null));
		// eslint-disable-next-line @typescript-eslint/require-array-sort-compare
		assert.deepStrictEqual(fields.sort(), ['account', 'actor', 'roles']);
	});

	test('diffs emit in sorted-method order', () => {
		const diff_methods = diff_action_manifests(
			manifest(entry({ method: 'zebra' })),
			manifest(entry({ method: 'alpha' }))
		).map((d) => (d.kind === 'method_only_in' ? d.method : ''));
		assert.deepStrictEqual(diff_methods, ['alpha', 'zebra']);
	});
});

describe('format_action_manifest_diffs', () => {
	test('empty diffs render an empty string', () => {
		assert.strictEqual(format_action_manifest_diffs([]), '');
	});

	test('custom labels flow through', () => {
		const rendered = format_action_manifest_diffs(
			[{ kind: 'side_effects_differ', method: 'm', a: false, b: true }],
			{ a: 'ts', b: 'rust' }
		);
		assert.match(rendered, /ts=false/);
		assert.match(rendered, /rust=true/);
	});

	test('renders a representative drift mix', () => {
		const rendered = format_action_manifest_diffs(
			[
				{ kind: 'method_only_in', where: 'a', method: 'ghost' },
				{
					kind: 'auth_field_differs',
					method: 'cell_create',
					field: 'credential_types',
					a: ['daemon_token'],
					b: []
				}
			],
			{ a: 'ts', b: 'rust' }
		);
		assert.match(rendered, /method ghost only in ts/);
		assert.match(rendered, /cell_create auth\.credential_types differs/);
	});
});

describe('assert_action_manifests_equal', () => {
	test('no-op when manifests match', () => {
		assert.doesNotThrow(() => assert_action_manifests_equal(manifest(), manifest()));
	});

	test('throws with both labels and the diff count', () => {
		try {
			assert_action_manifests_equal(manifest(entry({ method: 'extra' })), manifest(), {
				a: 'ts',
				b: 'rust'
			});
			assert.fail('expected throw');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.match(err.message, /1 diff\(s\) between ts and rust/);
			assert.match(err.message, /method extra only in ts/);
		}
	});
});
