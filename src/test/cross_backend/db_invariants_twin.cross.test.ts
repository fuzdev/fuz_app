/**
 * The two readers of the database invariant statement agree: on each spine,
 * a database left breaking several invariants answers the same rows over the
 * spine's `_testing_db_invariants` as `query_db_invariant_rows` reads from it
 * directly — on the Rust stub, the Rust handler against the TS reader over
 * one database state. And both spines, driven through the same steps, break
 * the same invariants.
 *
 * The state: a pending offer to an account whose tombstone is then written by
 * hand (its credentials, its live actor and the offer outlive it), and a
 * session forged for an account the wire deleted, backdated before the delete
 * (a credential the delete missed, read through `audit_log`).
 *
 * Runs in `cross_backend_parity`, where both spines are on PostgreSQL the test
 * process reaches.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { DAEMON_TOKEN_HEADER } from '#lib/auth/daemon_token.ts';
import { create_db } from '#lib/db/create_db.ts';
import { cross_rpc_call } from '#lib/testing/cross_backend/cross_rpc.ts';
import { inject_parity_handles } from '#lib/testing/cross_backend/provided_context.ts';
import { create_pending_role_grant_offer } from '#lib/testing/cross_backend/role_grant_cross_helpers.ts';
import {
	default_cross_process_setup,
	type ReconstructedBootstrappedBackendHandle
} from '#lib/testing/cross_backend/setup.ts';
import {
	DbInvariantRows,
	query_db_invariant_rows,
	type DbInvariantRow
} from '#lib/testing/db_invariant_queries.ts';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';

const parity = inject_parity_handles();

/** `value` as JSON with every object's keys sorted — the spines order them differently. */
const canonical = (value: unknown): string =>
	JSON.stringify(value, (_key, v: unknown) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: v
	);

/** The rows in a stable order, each canonical. */
const sorted = (rows: ReadonlyArray<DbInvariantRow>): Array<string> => rows.map(canonical).sort();

/** Leave the state the module doc names, then read it both ways. */
const break_and_read = async (
	handle: ReconstructedBootstrappedBackendHandle
): Promise<{ backdoor: Array<DbInvariantRow>; direct: Array<DbInvariantRow> }> => {
	const setup_test = default_cross_process_setup(handle, {
		exclude_db_invariants: { all: 'the test leaves invariants broken to compare their readers' }
	});
	const fixture = await setup_test();
	const { rpc_path, env } = handle.config;
	const database_url = env.DATABASE_URL ?? '';
	assert.match(database_url, /^postgres(ql)?:\/\//, `${handle.config.name}: on PostgreSQL`);
	const daemon = { [DAEMON_TOKEN_HEADER]: handle.daemon_token };

	const recipient = await fixture.create_account();
	await create_pending_role_grant_offer(fixture, recipient.account.id, undefined, { rpc_path });

	const deleted = await fixture.create_account();
	const del = await cross_rpc_call(
		fixture.fresh_transport(),
		rpc_path,
		'account_delete',
		{ account_id: deleted.account.id },
		fixture.create_session_headers()
	);
	assert.ok(del.ok, JSON.stringify(del));
	const mint = await cross_rpc_call(
		fixture.fresh_transport({ origin: null }),
		rpc_path,
		'_testing_mint_session',
		{ account_id: deleted.account.id, expires_in_seconds: -60 },
		daemon
	);
	assert.ok(mint.ok, JSON.stringify(mint));

	const { db, close } = await create_db(database_url);
	try {
		await db.query('UPDATE account SET deleted_at = NOW() WHERE id = $1', [recipient.account.id]);
		// the forged session predates the delete, as one the delete missed would
		await db.query(
			`UPDATE auth_session SET created_at = created_at - INTERVAL '1 hour' WHERE account_id = $1`,
			[deleted.account.id]
		);
		const answer = await cross_rpc_call(
			fixture.fresh_transport({ origin: null }),
			rpc_path,
			'_testing_db_invariants',
			undefined,
			daemon
		);
		assert.ok(answer.ok, JSON.stringify(answer));
		const backdoor = parse_or_throw(DbInvariantRows, answer.result).rows;
		const direct = await query_db_invariant_rows({ db });
		return { backdoor, direct };
	} finally {
		await close();
	}
};

/** The invariants the state breaks, each once. */
const EXPECTED_BROKEN = [
	'actor_tombstone_disagrees_with_account',
	'credential_of_tombstoned_account',
	'credential_outlived_account_removal',
	'pending_offer_with_dead_party'
];

describe('db invariants twin', () => {
	test('each spine answers the rows its database holds, and both break the same invariants', async () => {
		const broken: Array<Array<string>> = [];
		for (const handle of [parity.a, parity.b]) {
			const { backdoor, direct } = await break_and_read(handle);
			assert.deepStrictEqual(
				sorted(backdoor),
				sorted(direct),
				`${handle.config.name}: _testing_db_invariants answers the rows the statement reads`
			);
			const names = [...new Set(backdoor.map((r) => r.invariant))].sort();
			assert.deepStrictEqual(names, EXPECTED_BROKEN, handle.config.name);
			broken.push(backdoor.map((r) => r.invariant).sort());
		}
		assert.deepStrictEqual(broken[0], broken[1], 'both spines break the same invariants as often');
	});
});
