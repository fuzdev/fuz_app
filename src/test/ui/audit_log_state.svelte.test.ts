// @vitest-environment jsdom

/**
 * Tests for `AuditLogState` — audit log viewer UI state.
 *
 * @module
 */

import {describe, test, assert, vi, beforeEach, afterEach} from 'vitest';

import {AuditLogState} from '$lib/ui/audit_log_state.svelte.js';

const json_response = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {'Content-Type': 'application/json'},
	});

let fetch_mock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetch_mock = vi.fn();
	globalThis.fetch = fetch_mock as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('AuditLogState.fetch', () => {
	test('populates events on success', async () => {
		const events = [{id: 'evt-1', event_type: 'login'}];
		fetch_mock.mockResolvedValueOnce(json_response({events}));

		const state = new AuditLogState();
		await state.fetch();

		assert.strictEqual(state.events.length, 1);
		assert.strictEqual(state.error, null);
	});

	test('count reflects events length', async () => {
		const events = [{id: 'e-1'}, {id: 'e-2'}];
		fetch_mock.mockResolvedValueOnce(json_response({events}));

		const state = new AuditLogState();
		await state.fetch();

		assert.strictEqual(state.count, 2);
	});

	test('sets error on non-ok response', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'forbidden'}, 403));

		const state = new AuditLogState();
		await state.fetch();

		assert.strictEqual(state.error, 'forbidden');
	});

	test('fetches from /api/admin/audit-log by default', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({events: []}));

		const state = new AuditLogState();
		await state.fetch();

		assert.strictEqual(fetch_mock.mock.calls[0]![0], '/api/admin/audit-log');
	});

	test('appends event_type filter as query param', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({events: []}));

		const state = new AuditLogState();
		await state.fetch({event_type: 'login'});

		const url = fetch_mock.mock.calls[0]![0] as string;
		assert.ok(url.includes('event_type=login'));
	});

	test('appends account_id filter', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({events: []}));

		const state = new AuditLogState();
		await state.fetch({account_id: 'acct-1'});

		const url = fetch_mock.mock.calls[0]![0] as string;
		assert.ok(url.includes('account_id=acct-1'));
	});

	test('appends limit and offset', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({events: []}));

		const state = new AuditLogState();
		await state.fetch({limit: 50, offset: 10});

		const url = fetch_mock.mock.calls[0]![0] as string;
		assert.ok(url.includes('limit=50'));
		assert.ok(url.includes('offset=10'));
	});

	test('sets error on network failure', async () => {
		fetch_mock.mockRejectedValueOnce(new Error('Network error'));

		const state = new AuditLogState();
		await state.fetch();

		assert.strictEqual(state.error, 'Network error');
		assert.strictEqual(state.loading, false);
	});

	test('includes limit and offset of 0 in query params', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({events: []}));

		const state = new AuditLogState();
		await state.fetch({limit: 0, offset: 0});

		const url = fetch_mock.mock.calls[0]![0] as string;
		assert.ok(url.includes('limit=0'));
		assert.ok(url.includes('offset=0'));
	});

	test('handles missing events field', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({}));

		const state = new AuditLogState();
		await state.fetch();

		assert.strictEqual(state.events.length, 0);
	});
});

describe('AuditLogState.fetch_permit_history', () => {
	test('populates permit_history_events on success', async () => {
		const events = [{id: 'ph-1'}];
		fetch_mock.mockResolvedValueOnce(json_response({events}));

		const state = new AuditLogState();
		await state.fetch_permit_history();

		assert.strictEqual(state.permit_history_events.length, 1);
	});

	test('fetches from permit-history endpoint', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({events: []}));

		const state = new AuditLogState();
		await state.fetch_permit_history();

		const url = fetch_mock.mock.calls[0]![0] as string;
		assert.ok(url.includes('/api/admin/audit-log/permit-history'));
	});

	test('appends limit and offset', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({events: []}));

		const state = new AuditLogState();
		await state.fetch_permit_history(25, 5);

		const url = fetch_mock.mock.calls[0]![0] as string;
		assert.ok(url.includes('limit=25'));
		assert.ok(url.includes('offset=5'));
	});

	test('includes offset of 0 in query params', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({events: []}));

		const state = new AuditLogState();
		await state.fetch_permit_history(50, 0);

		const url = fetch_mock.mock.calls[0]![0] as string;
		assert.ok(url.includes('limit=50'));
		assert.ok(url.includes('offset=0'));
	});

	test('sets error on failure', async () => {
		fetch_mock.mockResolvedValueOnce(json_response({error: 'forbidden'}, 403));

		const state = new AuditLogState();
		await state.fetch_permit_history();

		assert.strictEqual(state.error, 'forbidden');
	});
});
