/**
 * Tests for `audit_drift_guard.ts`.
 *
 * `create_recording_audit_emitter` — pinning the lift contract
 * for `emit_role_grant_target` so role-grant-shape emissions land in the
 * same homogeneous `calls` array as `emit` / `emit_pool`.
 * The lift logic mirrors `create_audit_emitter`'s in-closure lift
 * (`auth/audit_emitter.ts`); if either side changes shape, this file is
 * where the drift surfaces.
 *
 * `assert_no_audit_drift` — the check `install_audit_drift_guard` runs after
 * each test: a write an emitter lost fails it.
 *
 * `assert_audit_event_metadata` — the declared parse refuses a mistyped or
 * `null` field but admits a consumer-added key; the closed-world parse
 * refuses that key too.
 *
 * @module
 */

import { beforeAll, describe, test, assert, vi } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

import {
	assert_audit_event_metadata,
	assert_no_audit_drift,
	create_recording_audit_emitter,
	install_audit_drift_guard
} from '#lib/testing/audit_drift_guard.ts';
import type { AuditLogInput } from '#lib/auth/audit_log_schema.ts';
import {
	create_audit_emitter,
	get_audit_write_failures,
	reset_audit_write_failures,
	type AuditEmitRoleGrantContext
} from '#lib/auth/audit_emitter.ts';
import type { Db } from '#lib/db/db.ts';

const create_ctx = (client_ip = '203.0.113.5'): AuditEmitRoleGrantContext => ({
	db: { in_transaction: false } as Db,
	pending_effects: [],
	post_commit_effects: [],
	client_ip
});

const create_auth = (): { account: { id: Uuid }; actor: { id: Uuid } } => ({
	account: { id: 'acct-1' as Uuid },
	actor: { id: 'actor-1' as Uuid }
});

describe('create_recording_audit_emitter — emit_role_grant_target', () => {
	test('pushes one entry to calls per invocation', async () => {
		const { emitter, calls } = create_recording_audit_emitter();
		const ctx = create_ctx();
		const auth = create_auth();

		await emitter.emit_role_grant_target(ctx, auth as never, {
			event_type: 'role_grant_create',
			target_account_id: 'tgt-acct' as Uuid,
			target_actor_id: 'tgt-actor' as Uuid,
			metadata: { role: 'admin', scope_id: null }
		});

		assert.strictEqual(calls.length, 1);
	});

	test('lifts actor_id / account_id / ip from auth + ctx into the pushed entry', async () => {
		const { emitter, calls } = create_recording_audit_emitter();
		const ctx = create_ctx('198.51.100.7');
		const auth = create_auth();

		await emitter.emit_role_grant_target(ctx, auth as never, {
			event_type: 'role_grant_revoke',
			target_account_id: 'tgt-acct' as Uuid,
			target_actor_id: 'tgt-actor' as Uuid,
			metadata: { role: 'admin', role_grant_id: 'rg-1' as Uuid, scope_id: null },
			outcome: 'success'
		});

		const lifted = calls[0]!;
		assert.strictEqual(lifted.actor_id, auth.actor.id);
		assert.strictEqual(lifted.account_id, auth.account.id);
		assert.strictEqual(lifted.ip, '198.51.100.7');
	});

	test('forwards event_type / outcome / target_*_id / metadata unchanged', async () => {
		const { emitter, calls } = create_recording_audit_emitter();
		const ctx = create_ctx();
		const auth = create_auth();
		const metadata = { role: 'admin', scope_id: null, source_offer_id: 'offer-7' as Uuid };

		await emitter.emit_role_grant_target(ctx, auth as never, {
			event_type: 'role_grant_create',
			target_account_id: 'tgt-acct' as Uuid,
			target_actor_id: 'tgt-actor' as Uuid,
			metadata,
			outcome: 'failure'
		});

		const lifted = calls[0]!;
		assert.strictEqual(lifted.event_type, 'role_grant_create');
		assert.strictEqual(lifted.outcome, 'failure');
		assert.strictEqual(lifted.target_account_id, 'tgt-acct');
		assert.strictEqual(lifted.target_actor_id, 'tgt-actor');
		assert.deepStrictEqual(lifted.metadata, metadata);
	});

	test('null target_actor_id is preserved (account-grain offer shape)', async () => {
		const { emitter, calls } = create_recording_audit_emitter();
		const ctx = create_ctx();
		const auth = create_auth();

		await emitter.emit_role_grant_target(ctx, auth as never, {
			event_type: 'role_grant_offer_create',
			target_account_id: 'tgt-acct' as Uuid,
			target_actor_id: null,
			metadata: {
				offer_id: 'offer-1' as Uuid,
				role: 'admin',
				to_account_id: 'tgt-acct' as Uuid
			}
		});

		assert.strictEqual(calls[0]!.target_actor_id, null);
	});

	test('emit and emit_role_grant_target share the same calls array', async () => {
		const { emitter, calls } = create_recording_audit_emitter();
		const ctx = create_ctx();
		const auth = create_auth();

		await emitter.emit(ctx, {
			event_type: 'login',
			outcome: 'success',
			account_id: auth.account.id
		});
		await emitter.emit_role_grant_target(ctx, auth as never, {
			event_type: 'role_grant_create',
			target_account_id: 'tgt-acct' as Uuid,
			target_actor_id: 'tgt-actor' as Uuid,
			metadata: { role: 'admin', scope_id: null }
		});

		assert.strictEqual(calls.length, 2);
		assert.strictEqual(calls[0]!.event_type, 'login');
		assert.strictEqual(calls[1]!.event_type, 'role_grant_create');
	});

	test('caller-owned calls array receives entries (calls_ref pass-through)', async () => {
		const calls_ref: Array<AuditLogInput> = [];
		const { emitter, calls } = create_recording_audit_emitter(calls_ref);
		const ctx = create_ctx();
		const auth = create_auth();

		await emitter.emit_role_grant_target(ctx, auth as never, {
			event_type: 'role_grant_create',
			target_account_id: 'tgt-acct' as Uuid,
			target_actor_id: 'tgt-actor' as Uuid,
			metadata: { role: 'admin', scope_id: null }
		});

		assert.strictEqual(calls_ref, calls);
		assert.strictEqual(calls_ref.length, 1);
	});
});

describe('assert_no_audit_drift', () => {
	test('fails once an emitter loses a write, and passes again after the reset', async () => {
		reset_audit_write_failures();
		assert_no_audit_drift();
		// a `Db` that refuses every statement — no driver involved
		const refusing_db = {
			query: () => Promise.reject(new Error('insert refused')),
			query_one: () => Promise.reject(new Error('insert refused'))
		} as unknown as Db;
		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const audit = create_audit_emitter({ db: refusing_db, log: new Logger('test') });
			// fail-open: the emit itself resolves
			await audit.emit_pool({ event_type: 'login' });
			assert.throws(assert_no_audit_drift, /failed to write/);
		} finally {
			reset_audit_write_failures();
			error_spy.mockRestore();
		}
		assert_no_audit_drift();
	});
});

describe('install_audit_drift_guard', () => {
	// a write lost before the guarded block's first test — by an earlier,
	// unguarded test in the same worker — must not fail the tests it guards
	beforeAll(async () => {
		const refusing_db = {
			query: () => Promise.reject(new Error('insert refused')),
			query_one: () => Promise.reject(new Error('insert refused'))
		} as unknown as Db;
		const audit = create_audit_emitter({
			db: refusing_db,
			log: new Logger('test', { level: 'off' })
		});
		await audit.emit_pool({ event_type: 'login' });
		assert.ok(get_audit_write_failures() > 0, 'the setup lost a write');
	});

	install_audit_drift_guard();

	test('resets the write-failure counter before each test', () => {
		assert.strictEqual(get_audit_write_failures(), 0);
	});
});

describe('assert_audit_event_metadata', () => {
	const offer_id = '11111111-1111-4111-8111-111111111111';
	const decline = (metadata: Record<string, unknown>) => ({
		event_type: 'role_grant_offer_decline',
		outcome: 'success' as const,
		metadata
	});

	test('admits metadata its event declares, under either parse', () => {
		const event = decline({ offer_id, role: 'admin', scope_id: null, reason: 'not now' });
		assert_audit_event_metadata(event);
		assert_audit_event_metadata(event, { reject_unknown_keys: true });
	});

	test('refuses a null where the event declares an optional string', () => {
		const event = decline({ offer_id, role: 'admin', scope_id: null, reason: null });
		assert.throws(() => assert_audit_event_metadata(event), /reason/);
		assert.throws(
			() => assert_audit_event_metadata(event, { reject_unknown_keys: true }),
			/reason/
		);
	});

	test('admits a key the event does not declare unless the world is closed', () => {
		const event = decline({ offer_id, role: 'admin', scope_id: null, source_invite_id: offer_id });
		assert_audit_event_metadata(event);
		assert.throws(
			() => assert_audit_event_metadata(event, { reject_unknown_keys: true }),
			/source_invite_id/
		);
	});

	test('admits null metadata where the event declares it nullable', () => {
		const event = { event_type: 'login', outcome: 'failure' as const, metadata: null };
		assert_audit_event_metadata(event, { reject_unknown_keys: true });
	});

	test('closes the world through a nullable schema too', () => {
		const event = {
			event_type: 'login',
			outcome: 'success' as const,
			metadata: { username: 'keeper', extra: 1 }
		};
		assert_audit_event_metadata(event);
		assert.throws(() => assert_audit_event_metadata(event, { reject_unknown_keys: true }), /extra/);
	});

	test('passes a consumer-registered event type unexamined', () => {
		const event = { event_type: 'app_thing', outcome: 'success' as const, metadata: { x: 1 } };
		assert_audit_event_metadata(event, { reject_unknown_keys: true });
	});
});
