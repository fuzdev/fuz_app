import './assert_dev_env.js';

/**
 * Gen-time helper for the `/ready` schema-drift probe's committed fixture.
 *
 * A consumer commits an `expected_schema.json` (the column map a fresh full
 * migration-chain bootstrap produces) and serves it through
 * `create_ready_route_spec`. This helper keeps the regenerate-and-verify test
 * that guards that fixture to ~10 lines: it introspects a freshly-bootstrapped
 * DB, writes the fixture when an update flag is set, and reads it back so the
 * caller can assert the committed copy equals a fresh bootstrap — the assertion
 * that fails when the fixture drifts from the DDLs, so the runtime expectation
 * can't silently fall behind.
 *
 * @module
 */

import {readFileSync, writeFileSync} from 'node:fs';

import type {Db} from '../db/db.js';
import {query_public_columns, type ExpectedSchema} from '../db/schema_ready.js';

/** Options for `sync_expected_schema_fixture`. */
export interface SyncExpectedSchemaFixtureOptions {
	/** A bootstrapped DB — the consumer has run its full migration chain on it. */
	db: Db;
	/** Committed fixture location — an `import.meta.url`-relative URL or a path. */
	fixture_url: URL | string;
	/**
	 * When true, overwrite the fixture with the live column map instead of just
	 * reading it. Drive from an env flag (e.g. `UPDATE_SCHEMA_READY === '1'`).
	 */
	update?: boolean;
}

/** The live column map and the committed fixture, for a `deepEqual` assertion. */
export interface SyncExpectedSchemaFixtureResult {
	/** Columns introspected from the live, freshly-bootstrapped DB. */
	live: Record<string, Array<string>>;
	/** The committed fixture (re-read after writing when `update`). */
	committed: ExpectedSchema;
}

/**
 * Introspect the live (bootstrapped) DB's columns, write them to the committed
 * fixture when `update`, then read the committed fixture back. The caller
 * asserts `deepEqual(live, committed)`:
 *
 * ```ts
 * const {live, committed} = await sync_expected_schema_fixture({
 *   db,
 *   fixture_url: new URL('../../lib/server/expected_schema.json', import.meta.url),
 *   update: process.env.UPDATE_SCHEMA_READY === '1',
 * });
 * assert.deepEqual(live, committed);
 * ```
 *
 * When `update` writes the fixture it emits raw `JSON.stringify` (one array
 * element per line); Prettier collapses short arrays inline, so run `gro format`
 * after `UPDATE_SCHEMA_READY=1` before committing or the format check will flag
 * the regenerated file. (The content is identical either way — the regen test
 * compares values, not formatting.)
 *
 * @returns the live column map and the committed map (post-write when `update`)
 */
export const sync_expected_schema_fixture = async (
	options: SyncExpectedSchemaFixtureOptions,
): Promise<SyncExpectedSchemaFixtureResult> => {
	const {db, fixture_url, update} = options;
	const live = await query_public_columns(db);
	if (update) {
		writeFileSync(fixture_url, JSON.stringify(live, null, '\t') + '\n');
	}
	const committed = JSON.parse(readFileSync(fixture_url, 'utf8')) as ExpectedSchema;
	return {live, committed};
};
