// @vitest-environment jsdom

/**
 * Tests for `AuditLogState` — audit log viewer UI state. Fetch flows through
 * the injected `AuditLogRpc` adapter; the SSE stream is tested in the round
 * trip suite.
 *
 * @module
 */

import {describe, test, assert, vi} from 'vitest';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {AuditLogState, type AuditLogRpc} from '$lib/ui/audit_log_state.svelte.js';
import type {
	AuditLogEventWithUsernamesJson,
	PermitHistoryEventJson,
} from '$lib/auth/audit_log_schema.js';
import type {AuditLogListInput, AuditLogPermitHistoryInput} from '$lib/auth/admin_action_specs.js';

const acct_1 = 'acct-1' as Uuid;

interface StubCalls {
	list: Array<AuditLogListInput | undefined>;
	permit_history: Array<AuditLogPermitHistoryInput | undefined>;
}

const make_rpc = (
	events: Array<AuditLogEventWithUsernamesJson> = [],
	permit_events: Array<PermitHistoryEventJson> = [],
): {rpc: AuditLogRpc; calls: StubCalls} => {
	const calls: StubCalls = {list: [], permit_history: []};
	const rpc: AuditLogRpc = {
		list: vi.fn(async (options?: AuditLogListInput) => {
			calls.list.push(options);
			return {events};
		}),
		permit_history: vi.fn(async (params?: AuditLogPermitHistoryInput) => {
			calls.permit_history.push(params);
			return {events: permit_events};
		}),
	};
	return {rpc, calls};
};

describe('AuditLogState.fetch', () => {
	test('populates events on success', async () => {
		const events = [{id: 'evt-1', event_type: 'login'}] as Array<AuditLogEventWithUsernamesJson>;
		const {rpc} = make_rpc(events);

		const state = new AuditLogState({get_rpc: () => rpc});
		await state.fetch();

		assert.strictEqual(state.events.length, 1);
		assert.strictEqual(state.error, null);
	});

	test('count reflects events length', async () => {
		const events = [{id: 'e-1'}, {id: 'e-2'}] as Array<AuditLogEventWithUsernamesJson>;
		const {rpc} = make_rpc(events);

		const state = new AuditLogState({get_rpc: () => rpc});
		await state.fetch();

		assert.strictEqual(state.count, 2);
	});

	test('passes event_type filter through', async () => {
		const {rpc, calls} = make_rpc();

		const state = new AuditLogState({get_rpc: () => rpc});
		await state.fetch({event_type: 'login'});

		assert.deepStrictEqual(calls.list[0], {event_type: 'login'});
	});

	test('passes account_id filter through', async () => {
		const {rpc, calls} = make_rpc();

		const state = new AuditLogState({get_rpc: () => rpc});
		await state.fetch({account_id: acct_1});

		assert.deepStrictEqual(calls.list[0], {account_id: acct_1});
	});

	test('passes limit and offset through', async () => {
		const {rpc, calls} = make_rpc();

		const state = new AuditLogState({get_rpc: () => rpc});
		await state.fetch({limit: 50, offset: 10});

		assert.deepStrictEqual(calls.list[0], {limit: 50, offset: 10});
	});

	test('sets error on rpc rejection', async () => {
		const rpc: AuditLogRpc = {
			list: vi.fn(async () => {
				throw new Error('Network error');
			}),
			permit_history: vi.fn(),
		};

		const state = new AuditLogState({get_rpc: () => rpc});
		await state.fetch();

		assert.strictEqual(state.error, 'Network error');
		assert.strictEqual(state.loading, false);
	});

	test('sets descriptive error when rpc adapter is absent', async () => {
		const state = new AuditLogState();
		await state.fetch();

		assert.strictEqual(state.error, 'rpc adapter not wired');
		assert.strictEqual(state.has_rpc, false);
	});
});

describe('AuditLogState.fetch_permit_history', () => {
	test('populates permit_history_events on success', async () => {
		const events = [{id: 'ph-1'}] as Array<PermitHistoryEventJson>;
		const {rpc} = make_rpc([], events);

		const state = new AuditLogState({get_rpc: () => rpc});
		await state.fetch_permit_history();

		assert.strictEqual(state.permit_history_events.length, 1);
	});

	test('passes limit and offset through', async () => {
		const {rpc, calls} = make_rpc();

		const state = new AuditLogState({get_rpc: () => rpc});
		await state.fetch_permit_history(25, 5);

		assert.deepStrictEqual(calls.permit_history[0], {limit: 25, offset: 5});
	});

	test('sets error on rpc rejection', async () => {
		const rpc: AuditLogRpc = {
			list: vi.fn(),
			permit_history: vi.fn(async () => {
				throw new Error('forbidden');
			}),
		};

		const state = new AuditLogState({get_rpc: () => rpc});
		await state.fetch_permit_history();

		assert.strictEqual(state.error, 'forbidden');
	});

	test('sets descriptive error when rpc adapter is absent', async () => {
		const state = new AuditLogState();
		await state.fetch_permit_history();

		assert.strictEqual(state.error, 'rpc adapter not wired');
	});
});
