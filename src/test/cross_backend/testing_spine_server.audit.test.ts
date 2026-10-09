/**
 * The TS spine binary's audit emitter tracks its in-flight writes, so
 * `_testing_drain_effects` is a real barrier: the drain waits on an audit
 * write a WS mutation left in flight. Built without `track_inflight`, the
 * drain resolves at once and the cross suites reading audit rows after a WS
 * mutation race the write.
 *
 * @module
 */

import { assert, test } from 'vitest';
import { create_deferred, wait, type Deferred } from '@fuzdev/fuz_util/async.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import type { AuditLogEvent } from '$lib/auth/audit_log_schema.ts';
import type { Db } from '$lib/db/db.ts';

import { cell_audit_factory } from './testing_spine_server.ts';

const log = new Logger('test', { level: 'off' });

const WRITTEN_EVENT: AuditLogEvent = {
	id: '00000000-0000-4000-8000-000000000001' as Uuid,
	seq: 1,
	event_type: 'login',
	outcome: 'success',
	actor_id: null,
	account_id: '00000000-0000-4000-8000-000000000002' as Uuid,
	target_account_id: null,
	target_actor_id: null,
	ip: null,
	created_at: '2025-01-01T00:00:00Z',
	metadata: null
};

test('cell_audit_factory tracks in-flight writes, so the drain waits on them', async () => {
	// every audit INSERT waits on its own gate, released by the test
	const gates: Array<Deferred<void>> = [];
	const db = {
		query: async () => {
			const gate = create_deferred<void>();
			gates.push(gate);
			await gate.promise;
			return [WRITTEN_EVENT];
		}
	} as unknown as Db;
	const audit = cell_audit_factory({ db, log });

	audit.emit(
		{ pending_effects: [], post_commit_effects: [] },
		{ event_type: 'login', outcome: 'success', account_id: WRITTEN_EVENT.account_id }
	);
	assert.strictEqual(gates.length, 1, 'the write starts at emit time');

	let drained = false;
	const drain = audit.drain_inflight().then(() => {
		drained = true;
	});
	await wait();
	assert.ok(!drained, 'the drain resolved with the write still in flight');

	gates[0]!.resolve();
	await drain;
	assert.ok(drained);
});
