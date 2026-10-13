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
 * @module
 */

import { describe, test, assert, vi } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import {
	assert_no_audit_drift,
	create_recording_audit_emitter
} from '#lib/testing/audit_drift_guard.ts';
import type { AuditLogInput } from '#lib/auth/audit_log_schema.ts';
import {
	create_audit_emitter,
	reset_audit_write_failures,
	type AuditEmitRoleGrantContext
} from '#lib/auth/audit_emitter.ts';
import type { Db } from '#lib/db/db.ts';

const create_ctx = (client_ip = '203.0.113.5'): AuditEmitRoleGrantContext => ({
	pending_effects: [],
	post_commit_effects: [],
	client_ip
});

const create_auth = (): { account: { id: Uuid }; actor: { id: Uuid } } => ({
	account: { id: 'acct-1' as Uuid },
	actor: { id: 'actor-1' as Uuid }
});

describe('create_recording_audit_emitter — emit_role_grant_target', () => {
	test('pushes one entry to calls per invocation', () => {
		const { emitter, calls } = create_recording_audit_emitter();
		const ctx = create_ctx();
		const auth = create_auth();

		emitter.emit_role_grant_target(ctx, auth as never, {
			event_type: 'role_grant_create',
			target_account_id: 'tgt-acct' as Uuid,
			target_actor_id: 'tgt-actor' as Uuid,
			metadata: { role: 'admin', scope_id: null }
		});

		assert.strictEqual(calls.length, 1);
	});

	test('lifts actor_id / account_id / ip from auth + ctx into the pushed entry', () => {
		const { emitter, calls } = create_recording_audit_emitter();
		const ctx = create_ctx('198.51.100.7');
		const auth = create_auth();

		emitter.emit_role_grant_target(ctx, auth as never, {
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

	test('forwards event_type / outcome / target_*_id / metadata unchanged', () => {
		const { emitter, calls } = create_recording_audit_emitter();
		const ctx = create_ctx();
		const auth = create_auth();
		const metadata = { role: 'admin', scope_id: null, source_offer_id: 'offer-7' as Uuid };

		emitter.emit_role_grant_target(ctx, auth as never, {
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

	test('null target_actor_id is preserved (account-grain offer shape)', () => {
		const { emitter, calls } = create_recording_audit_emitter();
		const ctx = create_ctx();
		const auth = create_auth();

		emitter.emit_role_grant_target(ctx, auth as never, {
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

	test('emit and emit_role_grant_target share the same calls array', () => {
		const { emitter, calls } = create_recording_audit_emitter();
		const ctx = create_ctx();
		const auth = create_auth();

		emitter.emit(ctx, { event_type: 'login', outcome: 'success', account_id: auth.account.id });
		emitter.emit_role_grant_target(ctx, auth as never, {
			event_type: 'role_grant_create',
			target_account_id: 'tgt-acct' as Uuid,
			target_actor_id: 'tgt-actor' as Uuid,
			metadata: { role: 'admin', scope_id: null }
		});

		assert.strictEqual(calls.length, 2);
		assert.strictEqual(calls[0]!.event_type, 'login');
		assert.strictEqual(calls[1]!.event_type, 'role_grant_create');
	});

	test('caller-owned calls array receives entries (calls_ref pass-through)', () => {
		const calls_ref: Array<AuditLogInput> = [];
		const { emitter, calls } = create_recording_audit_emitter(calls_ref);
		const ctx = create_ctx();
		const auth = create_auth();

		emitter.emit_role_grant_target(ctx, auth as never, {
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
