/**
 * Pins the shape of the `fuz_auth` migration chain.
 *
 * The chain is frozen and append-only (see the `auth/migrations.ts` module
 * doc): an already-bootstrapped database recorded the released entries as
 * applied, so editing, renaming, or reordering one is a silent no-op there
 * — the runner sees nothing new and the shape the code expects never lands.
 * The names are also the unit of identity the `_testing_migration_tracker`
 * parity gate compares against the Rust twin, but that gate is cross-backend
 * and opt-in; this is the in-process one that fails on a bare `gro test`.
 *
 * Appending is the supported edit: add the new name to the tail here and
 * ship the identically named twin. A diff anywhere *before* the tail is the
 * failure this test exists to catch.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import {
	auth_migrations,
	auth_migration_ns,
	AUTH_MIGRATION_NAMESPACE
} from '$lib/auth/migrations.ts';

/** The released chain, in order. Append only — never edit or reorder. */
const EXPECTED_MIGRATION_NAMES = [
	'full_auth_schema',
	'role_grant_offer_and_scoped_role_grants',
	'api_token_scope',
	'api_token_hash_unique_index',
	'audit_log_metadata_gin_index',
	'drop_session_last_seen_at'
];

describe('auth_migrations', () => {
	test('names and order match the released chain', () => {
		assert.deepStrictEqual(
			auth_migrations.map((m) => m.name),
			EXPECTED_MIGRATION_NAMES
		);
	});

	test('names are unique', () => {
		const names = auth_migrations.map((m) => m.name);
		assert.strictEqual(new Set(names).size, names.length);
	});

	test('the namespace bundles the same chain under the reserved name', () => {
		assert.strictEqual(auth_migration_ns.namespace, AUTH_MIGRATION_NAMESPACE);
		assert.strictEqual(auth_migration_ns.migrations, auth_migrations);
	});
});
