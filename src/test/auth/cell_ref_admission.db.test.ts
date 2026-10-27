/**
 * Possession-gated cell ref admission — a non-admin `cell_create`,
 * `cell_update`, or `cell_clone` whose `data` introduces a fact ref its acting
 * actor holds no `fact_holder` row for is 403 `cell_ref_not_held`, the same
 * answer for a stored and an unstored hash; refs a cell (or a clone's source
 * row) already carries stay admitted; a global admin is not gated, a scoped one
 * is; and admission answers after the 404 masks and the create policy.
 *
 * Twin of the Rust `fuz_cell_actions` `cell_authz` ref-admission cases. The
 * fact-less-schema refusal is `cell_ref_admission.fact_less.db.test.ts`; the
 * wire parity of these cases is the shared cross suite
 * (`testing/cross_backend/cell_ref_admission.ts`).
 *
 * @module
 */

import { test, assert } from 'vitest';
import type { Json } from '@fuzdev/fuz_util/json.ts';

import {
	cell_clone_action_spec,
	cell_create_action_spec,
	cell_update_action_spec,
	ERROR_CELL_CREATE_FORBIDDEN,
	ERROR_CELL_NOT_FOUND,
	ERROR_CELL_REF_NOT_HELD
} from '#lib/auth/cell_action_specs.ts';
import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { PgFactStore } from '#lib/db/fact_store.ts';
import { query_cell_create } from '#lib/db/cell_queries.ts';
import { query_delete_fact, query_orphan_facts_select_for_delete } from '#lib/db/fact_queries.ts';
import type { Db } from '#lib/db/db.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import {
	SPACE_CELL_KIND,
	test_cell_gated_create_authorize
} from '#lib/testing/cross_backend/test_cell_gated_create_authorize.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import { create_test_role_grant_direct } from '#lib/testing/db_entities.ts';
import {
	call,
	create_cell,
	create_cell_admin_test_app,
	create_cell_test_app
} from './cell_test_helpers.ts';
import { error_reason } from './rpc_test_helpers.ts';
import { describe_db } from '../cell_db_fixture.ts';

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A well-formed hash no fact is stored under. */
const UNSTORED_HASH = `blake3:${'e'.repeat(64)}`;

const count_cells = async (db: Db): Promise<number> =>
	(await db.query<{ n: number }>('SELECT count(*)::int AS n FROM cell'))[0]!.n;

/**
 * Run the orphan sweep the way an admin delete does — select past a one-hour
 * cutoff, then drop each row (cascading its holders) — returning the swept
 * hashes, sorted.
 */
const sweep_orphans_past_an_hour = async (db: Db): Promise<Array<string>> => {
	const candidates = await query_orphan_facts_select_for_delete(
		{ db },
		new Date(Date.now() - 3_600_000)
	);
	for (const { hash } of candidates) await query_delete_fact({ db }, hash);
	return candidates.map((c) => c.hash).sort();
};

const by_json = (x: Array<string>, y: Array<string>): number =>
	JSON.stringify(x).localeCompare(JSON.stringify(y));

/** The refs of every live cell `created_by` wrote, sorted by `by_json`. */
const refs_created_by = async (db: Db, created_by: Uuid): Promise<Array<Array<string>>> =>
	(
		await db.query<{ refs: Array<string> | null }>(
			'SELECT refs FROM cell WHERE created_by = $1 AND deleted_at IS NULL',
			[created_by]
		)
	)
		.map((r) => r.refs ?? [])
		.sort(by_json);

/** Seed a cell owned by `created_by` — a raw insert, so no admission runs. */
const seed_cell = async (
	db: Db,
	data: Json,
	created_by: Uuid,
	visibility: 'public' | 'private' = 'private'
): Promise<Uuid> => (await query_cell_create({ db }, { data, created_by, visibility })).id;

describe_db('cell ref admission', (get_db) => {
	install_audit_drift_guard();

	const put = (bytes: string, holder: Uuid | null): Promise<string> =>
		new PgFactStore({ deps: { db: get_db() } }).put(encode(bytes), { holder });

	test('create admits a new ref only for a holder', async () => {
		const app = await create_cell_test_app(get_db);
		const alice = await app.create_account({ username: 'adm_alice' });
		const bob = await app.create_account({ username: 'adm_bob' });
		const bob_headers = bob.create_session_headers();
		const uploaded = await put('alice photo', alice.actor.id);
		const seeded = await put('seeded', null);
		const before = await count_cells(get_db());

		// a stored fact Bob never put and an unstored hash: one identical refusal
		const stored = await call(
			app,
			cell_create_action_spec,
			{ data: { cover: uploaded }, visibility: 'public' },
			bob_headers
		);
		const unstored = await call(
			app,
			cell_create_action_spec,
			{ data: { cover: UNSTORED_HASH }, visibility: 'public' },
			bob_headers
		);
		assert.ok(!stored.ok && !unstored.ok);
		assert.strictEqual(error_reason(stored), ERROR_CELL_REF_NOT_HELD);
		assert.strictEqual(stored.status, 403);
		assert.deepEqual(
			{ status: stored.status, error: stored.error },
			{ status: unstored.status, error: unstored.error }
		);
		// a system-put fact has no holder
		const system = await call(
			app,
			cell_create_action_spec,
			{ data: { files: [seeded] } },
			bob_headers
		);
		assert.strictEqual(error_reason(system), ERROR_CELL_REF_NOT_HELD);
		assert.strictEqual(await count_cells(get_db()), before, 'a refused create wrote a cell');

		// the uploader holds it
		const created = await call(
			app,
			cell_create_action_spec,
			{ data: { cover: uploaded } },
			alice.create_session_headers()
		);
		assert.ok(created.ok);
		assert.deepEqual(created.result.cell.refs, [uploaded]);

		// Bob puts identical bytes: possession
		assert.strictEqual(await put('alice photo', bob.actor.id), uploaded);
		const held = await call(
			app,
			cell_create_action_spec,
			{ data: { cover: uploaded } },
			bob_headers
		);
		assert.ok(held.ok, JSON.stringify(held));

		// a hash inside prose is not a ref, so it needs no holding
		const prose = await call(
			app,
			cell_create_action_spec,
			{ data: { body: `see ${seeded} and ![x](${UNSTORED_HASH})` } },
			bob_headers
		);
		assert.ok(prose.ok);
		assert.strictEqual(prose.result.cell.refs, null);
	});

	test('a sweep between a re-upload and its cell write keeps the fact', async () => {
		// An old orphan re-uploaded (a dedup hit: the `fact` row keeps its old
		// `created_at`) must survive a sweep that runs before the cell write
		// naming it — else the sweep cascades the fresh holder row away and the
		// write is refused as unheld.
		const db = get_db();
		const app = await create_cell_test_app(get_db);
		const alice = await app.create_account({ username: 'adm_sweep_alice' });
		const bob = await app.create_account({ username: 'adm_sweep_bob' });
		const photo = await put('alice photo', alice.actor.id);
		const draft = await put('alice draft', alice.actor.id);
		const stale = await put('alice stale file', alice.actor.id);
		const aged = new Date(Date.now() - 48 * 3_600_000);
		await db.query('UPDATE fact SET created_at = $1', [aged]);
		await db.query('UPDATE fact_holder SET created_at = $1', [aged]);

		// Bob re-uploads the photo; Alice repeats her put of the draft.
		assert.strictEqual(await put('alice photo', bob.actor.id), photo);
		assert.strictEqual(await put('alice draft', alice.actor.id), draft);
		assert.deepEqual(await sweep_orphans_past_an_hour(db), [stale]);

		// both writes land after the sweep
		const alice_headers = alice.create_session_headers();
		const bobs = await call(
			app,
			cell_create_action_spec,
			{ data: { cover: photo } },
			bob.create_session_headers()
		);
		assert.ok(bobs.ok, JSON.stringify(bobs));
		assert.deepEqual(bobs.result.cell.refs, [photo]);
		const alices = await call(
			app,
			cell_create_action_spec,
			{ data: { file: draft } },
			alice_headers
		);
		assert.ok(alices.ok, JSON.stringify(alices));
		assert.deepEqual(alices.result.cell.refs, [draft]);
		// the swept fact took its possession with it
		const gone = await call(app, cell_create_action_spec, { data: { file: stale } }, alice_headers);
		assert.strictEqual(error_reason(gone), ERROR_CELL_REF_NOT_HELD);
	});

	test('update keeps existing refs and refuses new unheld ones', async () => {
		const app = await create_cell_test_app(get_db);
		const bob = await app.create_account({ username: 'adm_upd_bob' });
		const alice = await app.create_account({ username: 'adm_upd_alice' });
		const bob_headers = bob.create_session_headers();
		const seeded = await put('seeded', null);
		const alices = await put('alice file', alice.actor.id);
		const bobs = await put('bob file', bob.actor.id);
		// Bob owns a cell already carrying a ref he doesn't hold (a seed).
		const cell_id = await seed_cell(get_db(), { cover: seeded }, bob.actor.id);

		const kept = await call(
			app,
			cell_update_action_spec,
			{ cell_id, data: { cover: seeded, label: 'edited', file: bobs } },
			bob_headers
		);
		assert.ok(kept.ok, JSON.stringify(kept));
		assert.deepEqual(kept.result.cell.refs, [seeded, bobs].sort());

		for (const added of [alices, UNSTORED_HASH]) {
			const refused = await call(
				app,
				cell_update_action_spec,
				{ cell_id, data: { cover: seeded, file: added } },
				bob_headers
			);
			assert.strictEqual(error_reason(refused), ERROR_CELL_REF_NOT_HELD, added);
		}
		// dropping a ref and adding it back is a new ref
		assert.ok((await call(app, cell_update_action_spec, { cell_id, data: {} }, bob_headers)).ok);
		const restored = await call(
			app,
			cell_update_action_spec,
			{ cell_id, data: { cover: seeded } },
			bob_headers
		);
		assert.strictEqual(error_reason(restored), ERROR_CELL_REF_NOT_HELD);
		// a visibility-only update writes no data
		assert.ok(
			(await call(app, cell_update_action_spec, { cell_id, visibility: 'public' }, bob_headers)).ok
		);
	});

	test('clone carries source refs per row without holding them', async () => {
		const db = get_db();
		const app = await create_cell_test_app(get_db);
		const alice = await app.create_account({ username: 'adm_clone_alice' });
		const bob = await app.create_account({ username: 'adm_clone_bob' });
		const bob_headers = bob.create_session_headers();
		const cover = await put('cover', alice.actor.id);
		const attachment = await put('attachment', alice.actor.id);
		const alice_headers = alice.create_session_headers();
		const { id: child } = await create_cell(app, {
			data: { file: attachment },
			visibility: 'public',
			headers: alice_headers
		});
		const { id: source } = await create_cell(app, {
			data: { cover },
			visibility: 'public',
			items: [child],
			headers: alice_headers
		});

		assert.ok((await call(app, cell_clone_action_spec, { source_id: source }, bob_headers)).ok);
		assert.deepEqual(await refs_created_by(db, bob.actor.id), [[cover]]);

		const deep = await call(
			app,
			cell_clone_action_spec,
			{ source_id: source, deep: true },
			bob_headers
		);
		assert.ok(deep.ok, JSON.stringify(deep));
		assert.deepEqual(
			await refs_created_by(db, bob.actor.id),
			[[attachment], [cover], [cover]].sort(by_json)
		);

		const before = await count_cells(db);
		const patched = await call(
			app,
			cell_clone_action_spec,
			{ source_id: source, deep: true, with_data_patch: { extra: UNSTORED_HASH } },
			bob_headers
		);
		assert.strictEqual(error_reason(patched), ERROR_CELL_REF_NOT_HELD);
		const moved = await call(
			app,
			cell_clone_action_spec,
			{ source_id: source, with_data_patch: { extra: attachment } },
			bob_headers
		);
		assert.strictEqual(error_reason(moved), ERROR_CELL_REF_NOT_HELD);
		assert.strictEqual(await count_cells(db), before, 'a refused clone wrote a cell');
	});

	test('a global admin is not gated on refs; a scoped admin is', async () => {
		const app = await create_cell_admin_test_app(get_db);
		const seeded = await put('seeded', null);
		const created = await call(
			app,
			cell_create_action_spec,
			{ data: { cover: seeded } },
			app.create_session_headers()
		);
		assert.ok(created.ok);
		assert.deepEqual(created.result.cell.refs, [seeded]);

		const scoped = await app.create_account({ username: 'adm_scoped_admin' });
		const { id: space } = await create_cell(app, { data: {} });
		await create_test_role_grant_direct(get_db(), {
			actor_id: scoped.actor.id,
			role: ROLE_ADMIN,
			scope_kind: 'space',
			scope_id: space,
			granted_by: null
		});
		const refused = await call(
			app,
			cell_create_action_spec,
			{ data: { cover: seeded } },
			scoped.create_session_headers()
		);
		assert.strictEqual(error_reason(refused), ERROR_CELL_REF_NOT_HELD);
	});

	test('admission answers after the 404 masks and the create policy', async () => {
		const app = await create_cell_test_app(get_db, [], {
			authorize_create: test_cell_gated_create_authorize
		});
		const alice = await app.create_account({ username: 'adm_mask_alice' });
		const bob = await app.create_account({ username: 'adm_mask_bob' });
		const bob_headers = bob.create_session_headers();
		const alices = await put('alice private', alice.actor.id);
		const hidden = await seed_cell(get_db(), { file: alices }, alice.actor.id);

		for (const named of [UNSTORED_HASH, alices]) {
			const r = await call(
				app,
				cell_update_action_spec,
				{ cell_id: hidden, data: { file: named } },
				bob_headers
			);
			assert.strictEqual(error_reason(r), ERROR_CELL_NOT_FOUND, named);
		}
		const under = await call(
			app,
			cell_create_action_spec,
			{ data: { file: UNSTORED_HASH }, parent_id: hidden },
			bob_headers
		);
		assert.strictEqual(error_reason(under), ERROR_CELL_NOT_FOUND);
		const clone = await call(
			app,
			cell_clone_action_spec,
			{ source_id: hidden, with_data_patch: { extra: UNSTORED_HASH } },
			bob_headers
		);
		assert.strictEqual(error_reason(clone), ERROR_CELL_NOT_FOUND);
		const policy = await call(
			app,
			cell_create_action_spec,
			{ data: { file: UNSTORED_HASH }, kind: SPACE_CELL_KIND },
			bob_headers
		);
		assert.strictEqual(error_reason(policy), ERROR_CELL_CREATE_FORBIDDEN);
	});
});
