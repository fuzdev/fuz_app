/**
 * Two concurrent `role_grant_revoke`s of each other's global `admin` grant.
 *
 * Two admin accounts each revoke the other's grant at once: the last-admin
 * guard's locked count must serialize them, so exactly one revoke lands and
 * the other is refused 403 `cannot_revoke_last_admin` — never a deadlock
 * surfacing as a 500. A holder transaction locks both grants first so both
 * revokes park inside the guard's count, then releases them together.
 * Row-lock contention needs concurrent transactions on real `pg` connections
 * (the in-memory drivers run transactions serially), so this runs against
 * `pg_factory` only and skips when `TEST_DATABASE_URL` is unset. Twin of the
 * Rust `cross_revokes_of_the_last_two_admins_serialize` (`fuz_auth`).
 *
 * @module
 */

import { assert, test } from 'vitest';
import { create_deferred, wait } from '@fuzdev/fuz_util/async.ts';

import { create_test_app } from '#lib/testing/app_server.ts';
import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import {
	ERROR_CANNOT_REVOKE_LAST_ADMIN,
	role_grant_revoke_action_spec
} from '#lib/auth/role_grant_offer_action_specs.ts';
import { create_describe_db, auth_integration_truncate_tables } from '#lib/testing/db.ts';
import { rpc_call_for_spec } from '#lib/testing/rpc_helpers.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

import { pg_factory } from '../db_fixture.ts';
import { RPC_PATH, create_route_specs, session_options } from './role_grant_offer_test_helpers.ts';

const describe_pg = create_describe_db(pg_factory, auth_integration_truncate_tables);

describe_pg('role_grant_revoke concurrent cross-revoke', (get_db) => {
	test('two admins revoking each other: one lands, the other is refused 403', async () => {
		const db = get_db();
		const test_app = await create_test_app({
			session_options,
			create_route_specs,
			db,
			roles: [ROLE_ADMIN]
		});
		const admin_grant_of = async (actor_id: Uuid): Promise<Uuid> => {
			const row = await db.query_one<{ id: Uuid }>(
				`SELECT id FROM role_grant
				 WHERE actor_id = $1 AND role = $2 AND scope_id IS NULL AND revoked_at IS NULL`,
				[actor_id, ROLE_ADMIN]
			);
			assert.ok(row, 'an active admin grant');
			return row.id;
		};
		// the keeper drops out of the count, leaving exactly two admin accounts
		await db.query(`UPDATE role_grant SET revoked_at = NOW() WHERE id = $1`, [
			await admin_grant_of(test_app.backend.actor.id)
		]);
		const one = await test_app.create_account({ username: 'cross_admin_one', roles: [ROLE_ADMIN] });
		const two = await test_app.create_account({ username: 'cross_admin_two', roles: [ROLE_ADMIN] });
		const one_admin = await admin_grant_of(one.actor.id);
		const two_admin = await admin_grant_of(two.actor.id);

		// hold both grants so each revoke parks inside the guard's locked count
		const held = create_deferred<void>();
		const release = create_deferred<void>();
		const holder = db.transaction(async (tx) => {
			await tx.query(`SELECT id FROM role_grant WHERE id = ANY($1::uuid[]) FOR UPDATE`, [
				[one_admin, two_admin]
			]);
			held.resolve();
			await release.promise;
		});
		await Promise.race([held.promise, holder]);

		const revoke = (actor_id: Uuid, role_grant_id: Uuid, headers: Record<string, string>) =>
			rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: role_grant_revoke_action_spec,
				params: { actor_id, role_grant_id },
				headers
			});
		const revokes = Promise.all([
			revoke(two.actor.id, two_admin, one.create_session_headers()),
			revoke(one.actor.id, one_admin, two.create_session_headers())
		]);
		// a failure below must still free the holder's locks and settle the revokes,
		// or the shared database's later truncates and schema resets block on them
		try {
			// both revokes are waiting on the holder's row locks
			const waiting = async (): Promise<number> =>
				Number(
					(
						await db.query_one<{ n: string }>(
							`SELECT count(*) AS n FROM pg_stat_activity
						 WHERE datname = current_database() AND wait_event_type = 'Lock'`
						)
					)?.n ?? 0
				);
			for (let i = 0; (await waiting()) < 2; i++) {
				assert.isBelow(i, 300, 'both revokes reach the guard');
				await wait(10);
			}
		} finally {
			release.resolve();
			await holder.catch(() => {});
			await revokes.catch(() => {});
		}
		await holder;

		const results = await revokes;
		const landed = results.filter((r) => r.ok);
		const refused = results.filter((r) => !r.ok);
		assert.strictEqual(landed.length, 1, JSON.stringify(results));
		assert.strictEqual(refused.length, 1, JSON.stringify(results));
		const [refusal] = refused;
		assert.ok(refusal && !refusal.ok);
		assert.strictEqual(refusal.status, 403, JSON.stringify(refusal));
		assert.deepStrictEqual(refusal.error.data, { reason: ERROR_CANNOT_REVOKE_LAST_ADMIN });

		const active = await db.query<{ id: Uuid }>(
			`SELECT id FROM role_grant WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL`,
			[[one_admin, two_admin]]
		);
		assert.strictEqual(active.length, 1, 'one admin grant survives');
	});
});
