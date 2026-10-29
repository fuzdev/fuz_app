// @vitest-environment jsdom

/**
 * Tests for `AuditLogState` — audit log viewer UI state. Fetch flows through
 * the injected `AuditLogRpc` adapter; `subscribe` runs against a stub
 * `EventSource` global the test drives (the wire side of the stream is tested
 * in the round trip suite).
 *
 * @module
 */

import { describe, test, assert, vi, afterEach, beforeEach } from 'vitest';
import type { Uuid } from '#lib/primitive_schemas.ts';

import {
	AuditLogState,
	audit_log_filter_matches,
	type AuditLogRpc
} from '#lib/ui/audit_log_state.svelte.ts';
import type {
	AuditLogEventJson,
	AuditLogEventWithUsernamesJson,
	RoleGrantHistoryEventJson
} from '#lib/auth/audit_log_schema.ts';
import {
	AUDIT_LOG_LIST_LIMIT_MAX,
	type AuditLogListInput,
	type AuditLogRoleGrantHistoryInput
} from '#lib/auth/admin_action_specs.ts';
import { make_deferred } from './async_test_helpers.ts';

const acct_1 = 'acct-1' as Uuid;

interface StubCalls {
	list: Array<AuditLogListInput | undefined>;
	role_grant_history: Array<AuditLogRoleGrantHistoryInput | undefined>;
}

const make_rpc = (
	events: Array<AuditLogEventWithUsernamesJson> = [],
	role_grant_events: Array<RoleGrantHistoryEventJson> = []
): { rpc: AuditLogRpc; calls: StubCalls } => {
	const calls: StubCalls = { list: [], role_grant_history: [] };
	const rpc: AuditLogRpc = {
		list: vi.fn(async (options?: AuditLogListInput) => {
			calls.list.push(options);
			return { events };
		}),
		role_grant_history: vi.fn(async (params?: AuditLogRoleGrantHistoryInput) => {
			calls.role_grant_history.push(params);
			return { events: role_grant_events };
		})
	};
	return { rpc, calls };
};

describe('AuditLogState.fetch', () => {
	test('populates events on success', async () => {
		const events = [{ id: 'evt-1', event_type: 'login' }] as Array<AuditLogEventWithUsernamesJson>;
		const { rpc } = make_rpc(events);

		const state = new AuditLogState({ get_rpc: () => rpc });
		await state.fetch();

		assert.strictEqual(state.events.length, 1);
		assert.strictEqual(state.list.error, null);
	});

	test('count reflects events length', async () => {
		const events = [{ id: 'e-1' }, { id: 'e-2' }] as Array<AuditLogEventWithUsernamesJson>;
		const { rpc } = make_rpc(events);

		const state = new AuditLogState({ get_rpc: () => rpc });
		await state.fetch();

		assert.strictEqual(state.count, 2);
	});

	test('passes event_type filter through', async () => {
		const { rpc, calls } = make_rpc();

		const state = new AuditLogState({ get_rpc: () => rpc });
		await state.fetch({ event_type: 'login' });

		assert.deepStrictEqual(calls.list[0], { event_type: 'login' });
	});

	test('passes account_id filter through', async () => {
		const { rpc, calls } = make_rpc();

		const state = new AuditLogState({ get_rpc: () => rpc });
		await state.fetch({ account_id: acct_1 });

		assert.deepStrictEqual(calls.list[0], { account_id: acct_1 });
	});

	test('passes limit and offset through', async () => {
		const { rpc, calls } = make_rpc();

		const state = new AuditLogState({ get_rpc: () => rpc });
		await state.fetch({ limit: 50, offset: 10 });

		assert.deepStrictEqual(calls.list[0], { limit: 50, offset: 10 });
	});

	test('a superseded fetch does not overwrite the newer list', async () => {
		const first = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
		const rpc: AuditLogRpc = {
			list: vi
				.fn()
				.mockReturnValueOnce(first.promise)
				.mockResolvedValueOnce({ events: [{ id: 'evt-new' }] }),
			role_grant_history: vi.fn()
		};

		const state = new AuditLogState({ get_rpc: () => rpc });
		const stale = state.fetch({ event_type: 'logout' });
		await state.fetch();
		first.resolve({ events: [{ id: 'evt-old' }] as Array<AuditLogEventWithUsernamesJson> });
		await stale;

		assert.deepStrictEqual(
			state.events.map((e) => e.id),
			['evt-new']
		);
	});

	test('sets error on rpc rejection', async () => {
		const rpc: AuditLogRpc = {
			list: vi.fn(async () => {
				throw new Error('Network error');
			}),
			role_grant_history: vi.fn()
		};

		const state = new AuditLogState({ get_rpc: () => rpc });
		await state.fetch();

		assert.strictEqual(state.list.error, 'Network error');
		assert.strictEqual(state.list.loading, false);
	});
});

describe('AuditLogState.fetch_role_grant_history', () => {
	test('populates role_grant_history_events on success', async () => {
		const events = [{ id: 'ph-1' }] as Array<RoleGrantHistoryEventJson>;
		const { rpc } = make_rpc([], events);

		const state = new AuditLogState({ get_rpc: () => rpc });
		await state.fetch_role_grant_history();

		assert.strictEqual(state.role_grant_history_events.length, 1);
	});

	test('passes limit and offset through', async () => {
		const { rpc, calls } = make_rpc();

		const state = new AuditLogState({ get_rpc: () => rpc });
		await state.fetch_role_grant_history(25, 5);

		assert.deepStrictEqual(calls.role_grant_history[0], { limit: 25, offset: 5 });
	});

	test('sets error on rpc rejection', async () => {
		const rpc: AuditLogRpc = {
			list: vi.fn(),
			role_grant_history: vi.fn(async () => {
				throw new Error('forbidden');
			})
		};

		const state = new AuditLogState({ get_rpc: () => rpc });
		await state.fetch_role_grant_history();

		assert.strictEqual(state.role_grant_history.error, 'forbidden');
	});
});

/**
 * Stub `EventSource` the test drives: `open()`, `emit()`, and `fail()` fire the
 * handlers `AuditLogState` installed, with the `readyState` a browser would
 * report.
 */
class StubEventSource {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	static instances: Array<StubEventSource> = [];

	readonly url: string;
	readyState = StubEventSource.CONNECTING;
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(url: string) {
		this.url = url;
		StubEventSource.instances.push(this);
	}

	close(): void {
		this.closed = true;
		this.readyState = StubEventSource.CLOSED;
	}

	open(): void {
		this.readyState = StubEventSource.OPEN;
		this.onopen?.();
	}

	emit(event: AuditLogEventJson): void {
		this.onmessage?.({
			data: JSON.stringify({ jsonrpc: '2.0', method: 'audit_log', params: event })
		});
	}

	/** An error event; `gave_up` reports a refused reconnect (`CLOSED`), else a retry (`CONNECTING`). */
	fail(gave_up: boolean): void {
		this.readyState = gave_up ? StubEventSource.CLOSED : StubEventSource.CONNECTING;
		this.onerror?.();
	}
}

const latest_source = (): StubEventSource => {
	const source = StubEventSource.instances.at(-1);
	assert(source, 'no EventSource opened');
	return source;
};

const make_event = (
	seq: number,
	overrides: Partial<AuditLogEventWithUsernamesJson> = {}
): AuditLogEventWithUsernamesJson => ({
	id: `evt-${seq}` as Uuid,
	seq,
	event_type: 'login',
	outcome: 'success',
	actor_id: null,
	account_id: null,
	target_account_id: null,
	target_actor_id: null,
	ip: null,
	created_at: '2026-01-01T00:00:00.000Z',
	metadata: null,
	username: null,
	target_username: null,
	...overrides
});

const seqs = (state: AuditLogState): Array<number> => state.events.map((e) => e.seq);

/** Flush the microtasks a gap fill's `run` chain needs to settle. */
const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** An RPC whose `list` answers each call from `responses` in order, recording inputs. */
const make_list_rpc = (
	...responses: Array<Array<AuditLogEventWithUsernamesJson> | Error>
): { rpc: AuditLogRpc; calls: Array<AuditLogListInput | undefined> } => {
	const calls: Array<AuditLogListInput | undefined> = [];
	const rpc: AuditLogRpc = {
		list: vi.fn(async (input?: AuditLogListInput) => {
			calls.push(input);
			const response = responses.shift() ?? [];
			if (response instanceof Error) throw response;
			return { events: response };
		}),
		role_grant_history: vi.fn()
	};
	return { rpc, calls };
};

describe('AuditLogState.subscribe', () => {
	beforeEach(() => {
		StubEventSource.instances = [];
		vi.stubGlobal('EventSource', StubEventSource);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('stream_status', () => {
		test('starts off, connecting on subscribe, open on open', () => {
			const { rpc } = make_list_rpc();
			const state = new AuditLogState({ get_rpc: () => rpc, stream_url: '/stream' });
			assert.strictEqual(state.stream_status, 'off');

			state.subscribe();
			assert.strictEqual(state.stream_status, 'connecting');
			assert.strictEqual(latest_source().url, '/stream');

			latest_source().open();
			assert.strictEqual(state.stream_status, 'open');
		});

		test('a transient error reads connecting while EventSource retries', () => {
			const { rpc } = make_list_rpc();
			const state = new AuditLogState({ get_rpc: () => rpc });
			state.subscribe();
			const source = latest_source();
			source.open();

			source.fail(false);
			assert.strictEqual(state.stream_status, 'connecting');
			assert.isFalse(source.closed);

			source.open();
			assert.strictEqual(state.stream_status, 'open');
		});

		test('a refused reconnect reads closed and releases the source', () => {
			const { rpc } = make_list_rpc();
			const state = new AuditLogState({ get_rpc: () => rpc });
			state.subscribe();
			const source = latest_source();
			source.open();

			source.fail(true);
			assert.strictEqual(state.stream_status, 'closed');
			assert.isTrue(source.closed);
		});

		test('subscribing again after closed opens a new stream', () => {
			const { rpc } = make_list_rpc();
			const state = new AuditLogState({ get_rpc: () => rpc });
			state.subscribe();
			latest_source().fail(true);

			state.subscribe();
			assert.strictEqual(StubEventSource.instances.length, 2);
			assert.strictEqual(state.stream_status, 'connecting');
			latest_source().open();
			assert.strictEqual(state.stream_status, 'open');
		});

		test('disconnect closes the stream and reads off', () => {
			const { rpc } = make_list_rpc();
			const state = new AuditLogState({ get_rpc: () => rpc });
			const cleanup = state.subscribe();
			const source = latest_source();
			source.open();

			cleanup();
			assert.strictEqual(state.stream_status, 'off');
			assert.isTrue(source.closed);
		});

		test('a replaced stream no longer drives the status', () => {
			const { rpc } = make_list_rpc();
			const state = new AuditLogState({ get_rpc: () => rpc });
			state.subscribe();
			const first = latest_source();
			state.subscribe();
			latest_source().open();

			first.fail(true);
			assert.strictEqual(state.stream_status, 'open');
		});
	});

	describe('live events', () => {
		test('merge newest-first', () => {
			const { rpc } = make_list_rpc();
			const state = new AuditLogState({ get_rpc: () => rpc });
			state.subscribe();
			const source = latest_source();
			source.emit(make_event(1));
			source.emit(make_event(2));

			assert.deepStrictEqual(seqs(state), [2, 1]);
		});

		test('apply the filter', () => {
			const { rpc } = make_list_rpc();
			const state = new AuditLogState({ get_rpc: () => rpc });
			state.subscribe({ event_type: 'logout' });
			const source = latest_source();
			source.emit(make_event(1, { event_type: 'login' }));
			source.emit(make_event(2, { event_type: 'logout' }));

			assert.deepStrictEqual(seqs(state), [2]);
		});

		test('ignore malformed messages', () => {
			const { rpc } = make_list_rpc();
			const state = new AuditLogState({ get_rpc: () => rpc });
			state.subscribe();
			latest_source().onmessage?.({ data: 'not json' });

			assert.strictEqual(state.events.length, 0);
		});
	});

	describe('gap fill', () => {
		test('runs on open from the last seq, with the filter and the max limit', async () => {
			const { rpc, calls } = make_list_rpc([make_event(5, { event_type: 'logout' })], []);
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch({ event_type: 'logout' });

			state.subscribe({ event_type: 'logout' });
			latest_source().open();
			await settle();

			assert.deepStrictEqual(calls[1], {
				event_type: 'logout',
				since_seq: 5,
				limit: AUDIT_LOG_LIST_LIMIT_MAX
			});
		});

		test('an empty first page fills from seq 0', async () => {
			const { rpc, calls } = make_list_rpc([], [make_event(3)]);
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();

			state.subscribe();
			latest_source().open();
			await settle();

			assert.strictEqual(calls[1]?.since_seq, 0);
			assert.deepStrictEqual(seqs(state), [3]);
		});

		test('does not run without a fetched or streamed anchor', async () => {
			const { rpc, calls } = make_list_rpc();
			const state = new AuditLogState({ get_rpc: () => rpc });

			state.subscribe();
			latest_source().open();
			await settle();

			assert.strictEqual(calls.length, 0);
		});

		test('advances from the last live event on reopen', async () => {
			const { rpc, calls } = make_list_rpc([make_event(1)], [], []);
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe();
			const source = latest_source();
			source.open();
			await settle();
			source.emit(make_event(4));

			source.fail(false);
			source.open();
			await settle();

			assert.strictEqual(calls[2]?.since_seq, 4);
		});

		test('merges gap rows by seq beneath newer live rows', async () => {
			const gap = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const rpc: AuditLogRpc = {
				list: vi
					.fn()
					.mockResolvedValueOnce({ events: [make_event(10)] })
					.mockReturnValueOnce(gap.promise),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe();
			const source = latest_source();
			source.open();
			// a live row lands before the gap fill answers
			source.emit(make_event(13));

			gap.resolve({ events: [make_event(12), make_event(11)] });
			await settle();

			assert.deepStrictEqual(seqs(state), [13, 12, 11, 10]);
		});

		test('a gap row replaces the live row with the same id', async () => {
			const gap = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const rpc: AuditLogRpc = {
				list: vi
					.fn()
					.mockResolvedValueOnce({ events: [make_event(10)] })
					.mockReturnValueOnce(gap.promise),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe();
			const source = latest_source();
			source.open();
			source.emit(make_event(11));

			gap.resolve({ events: [make_event(11, { username: 'alice' })] });
			await settle();

			assert.deepStrictEqual(seqs(state), [11, 10]);
			assert.strictEqual(state.events[0]?.username, 'alice');
		});

		test('a full page flags truncation; a fetch clears it', async () => {
			const full = Array.from({ length: AUDIT_LOG_LIST_LIMIT_MAX }, (_, i) => make_event(i + 2));
			const { rpc } = make_list_rpc([make_event(1)], full, []);
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe();
			latest_source().open();
			await settle();

			assert.isTrue(state.gap_truncated);

			await state.fetch();
			assert.isFalse(state.gap_truncated);
		});

		test('a short page does not flag truncation', async () => {
			const short = Array.from({ length: AUDIT_LOG_LIST_LIMIT_MAX - 1 }, (_, i) =>
				make_event(i + 2)
			);
			const { rpc } = make_list_rpc([make_event(1)], short);
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe();
			latest_source().open();
			await settle();

			assert.isFalse(state.gap_truncated);
			assert.strictEqual(state.events.length, AUDIT_LOG_LIST_LIMIT_MAX);
		});

		test('a resubscribe with a new filter fills nothing from the old anchor', async () => {
			const list = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const rpc: AuditLogRpc = {
				list: vi
					.fn()
					// a rare filter's empty list anchors at 0, and its gap fill is empty
					.mockResolvedValueOnce({ events: [] })
					.mockResolvedValueOnce({ events: [] })
					.mockReturnValueOnce(list.promise)
					.mockResolvedValue({ events: [] }),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch({ event_type: 'logout' });
			state.subscribe({ event_type: 'logout' });
			latest_source().open();
			await settle();
			assert.strictEqual(vi.mocked(rpc.list).mock.calls.length, 2);

			// switch to all events, as `AdminAuditLog` does: fetch and resubscribe
			const fetching = state.fetch();
			state.subscribe();
			latest_source().open();
			await settle();

			assert.strictEqual(vi.mocked(rpc.list).mock.calls.length, 3);
			list.resolve({ events: [make_event(7)] });
			await fetching;
			await settle();
			// the deferred fill runs from the new page, not the old anchor
			assert.deepStrictEqual(vi.mocked(rpc.list).mock.calls[3]?.[0], {
				since_seq: 7,
				limit: AUDIT_LOG_LIST_LIMIT_MAX
			});
			assert.deepStrictEqual(seqs(state), [7]);
		});

		test('an open before the list matches fills from the fetched page once it does', async () => {
			const list = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const rpc: AuditLogRpc = {
				list: vi
					.fn()
					.mockResolvedValueOnce({ events: [] })
					.mockResolvedValueOnce({ events: [] })
					.mockReturnValueOnce(list.promise)
					// committed between the fetch's query and the stream's open
					.mockResolvedValueOnce({ events: [make_event(11, { event_type: 'logout' })] })
					.mockResolvedValue({ events: [] }),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe();
			latest_source().open();
			await settle();

			// switch to logout: the stream opens before the fetch answers
			const fetching = state.fetch({ event_type: 'logout' });
			state.subscribe({ event_type: 'logout' });
			const source = latest_source();
			source.open();
			await settle();
			assert.strictEqual(vi.mocked(rpc.list).mock.calls.length, 3);
			source.emit(make_event(12, { event_type: 'logout' }));

			list.resolve({ events: [make_event(10, { event_type: 'logout' })] });
			await fetching;
			await settle();

			// from the fetched page, not past the live row
			assert.deepStrictEqual(vi.mocked(rpc.list).mock.calls[3]?.[0], {
				event_type: 'logout',
				since_seq: 10,
				limit: AUDIT_LOG_LIST_LIMIT_MAX
			});
			assert.deepStrictEqual(seqs(state), [12, 11, 10]);

			// the deferred fill runs once: a refresh doesn't fill again
			await state.fetch({ event_type: 'logout' });
			await settle();
			assert.strictEqual(vi.mocked(rpc.list).mock.calls.length, 5);
		});

		test('a deferred fill waits for the reopen while the stream reconnects', async () => {
			const list = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const rpc: AuditLogRpc = {
				list: vi.fn().mockReturnValueOnce(list.promise).mockResolvedValue({ events: [] }),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			const fetching = state.fetch();
			state.subscribe();
			const source = latest_source();
			source.open();
			source.emit(make_event(12));
			source.fail(false);

			list.resolve({ events: [make_event(10)] });
			await fetching;
			await settle();
			assert.strictEqual(vi.mocked(rpc.list).mock.calls.length, 1);

			source.open();
			await settle();
			assert.strictEqual(vi.mocked(rpc.list).mock.calls[1]?.[0]?.since_seq, 10);
		});

		test('live rows under another stream filter drop or merge without advancing the anchor', async () => {
			const { rpc, calls } = make_list_rpc([make_event(1, { event_type: 'logout' })], []);
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch({ event_type: 'logout' });
			state.subscribe();
			latest_source().open();
			await settle();
			latest_source().emit(make_event(5));
			latest_source().emit(make_event(6, { event_type: 'logout' }));

			// the list excludes the login
			assert.deepStrictEqual(seqs(state), [6, 1]);

			// back to the list's filter without a fetch: the fill covers what the
			// all-events stream skipped since the list's anchor
			state.subscribe({ event_type: 'logout' });
			latest_source().open();
			await settle();
			assert.deepStrictEqual(calls[1], {
				event_type: 'logout',
				since_seq: 1,
				limit: AUDIT_LOG_LIST_LIMIT_MAX
			});
		});

		test('a refresh aborts an in-flight fill, so a late fill neither merges nor flags', async () => {
			const gap = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const full = Array.from({ length: AUDIT_LOG_LIST_LIMIT_MAX }, (_, i) => make_event(i + 2));
			const rpc: AuditLogRpc = {
				list: vi
					.fn()
					.mockResolvedValueOnce({ events: [make_event(1)] })
					.mockReturnValueOnce(gap.promise)
					.mockResolvedValueOnce({ events: [make_event(300), make_event(299)] })
					.mockResolvedValue({ events: [] }),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe();
			latest_source().open();
			assert.isTrue(state.gap_fill.loading);

			await state.fetch();
			gap.resolve({ events: full });
			await settle();

			assert.isFalse(state.gap_truncated);
			assert.deepStrictEqual(seqs(state), [300, 299]);
		});

		test('a refresh aborts an in-flight fill, so a late failure shows no error', async () => {
			const gap = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const rpc: AuditLogRpc = {
				list: vi
					.fn()
					.mockResolvedValueOnce({ events: [make_event(1)] })
					.mockReturnValueOnce(gap.promise)
					.mockResolvedValue({ events: [make_event(2)] }),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe();
			latest_source().open();

			await state.fetch();
			gap.reject(new Error('gap failed'));
			await settle();

			assert.strictEqual(state.gap_fill.error, null);
		});

		test('a later page leaves an in-flight fill running', async () => {
			const gap = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const rpc: AuditLogRpc = {
				list: vi
					.fn()
					.mockResolvedValueOnce({ events: [make_event(1)] })
					.mockReturnValueOnce(gap.promise)
					.mockResolvedValue({ events: [] }),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe();
			latest_source().open();

			const paging = state.fetch({ offset: 50 });
			assert.isTrue(state.gap_fill.loading);
			await paging;
		});

		test('fills again once a fetch with the stream filter re-anchors', async () => {
			const { rpc, calls } = make_list_rpc([], [make_event(4)], []);
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch({ event_type: 'logout' });
			state.subscribe();
			const source = latest_source();
			source.open();
			await settle();
			assert.strictEqual(calls.length, 1);

			await state.fetch();
			source.fail(false);
			source.open();
			await settle();

			assert.deepStrictEqual(calls[2], { since_seq: 4, limit: AUDIT_LOG_LIST_LIMIT_MAX });
		});

		test('a live anchor under another filter than the list fills nothing on reopen', async () => {
			const { rpc, calls } = make_list_rpc([make_event(1)]);
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe({ event_type: 'logout' });
			const source = latest_source();
			source.open();
			source.emit(make_event(6, { event_type: 'logout' }));

			source.fail(false);
			source.open();
			await settle();

			assert.strictEqual(calls.length, 1);
		});

		test('a stale fill resolving after a resubscribe does not merge', async () => {
			const gap = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const full = Array.from({ length: AUDIT_LOG_LIST_LIMIT_MAX }, (_, i) => make_event(i + 2));
			const rpc: AuditLogRpc = {
				list: vi
					.fn()
					.mockResolvedValueOnce({ events: [make_event(1)] })
					.mockReturnValueOnce(gap.promise)
					.mockResolvedValue({ events: [] }),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe();
			latest_source().open();

			state.subscribe({ event_type: 'logout' });
			gap.resolve({ events: full });
			await settle();

			assert.deepStrictEqual(seqs(state), [1]);
			assert.isFalse(state.gap_truncated);
		});

		test('a fill resolving after disconnect does not merge', async () => {
			const gap = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const rpc: AuditLogRpc = {
				list: vi
					.fn()
					.mockResolvedValueOnce({ events: [make_event(1)] })
					.mockReturnValueOnce(gap.promise),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe();
			latest_source().open();
			assert.isTrue(state.gap_fill.loading);

			state.disconnect();
			assert.isFalse(state.gap_fill.loading);
			gap.resolve({ events: [make_event(2)] });
			await settle();

			assert.deepStrictEqual(seqs(state), [1]);
		});

		test('a failed fill surfaces on gap_fill; a fetch clears it', async () => {
			const { rpc } = make_list_rpc([make_event(1)], new Error('gap failed'), []);
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe();
			latest_source().open();
			await settle();

			assert.strictEqual(state.gap_fill.error, 'gap failed');
			assert.deepStrictEqual(seqs(state), [1]);

			await state.fetch();
			assert.strictEqual(state.gap_fill.error, null);
		});

		describe('a superseded fill', () => {
			test('a reopen while a fill is in flight fills from that fill, not past live rows', async () => {
				const gap = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
				const rpc: AuditLogRpc = {
					list: vi
						.fn()
						.mockResolvedValueOnce({ events: [make_event(1)] })
						.mockReturnValueOnce(gap.promise)
						.mockResolvedValue({ events: [make_event(2), make_event(3), make_event(4)] }),
					role_grant_history: vi.fn()
				};
				const state = new AuditLogState({ get_rpc: () => rpc });
				await state.fetch();
				state.subscribe();
				const source = latest_source();
				source.open();
				source.emit(make_event(5));
				source.fail(false);
				source.open();
				await settle();
				gap.resolve({ events: [] });
				await settle();

				assert.deepStrictEqual(vi.mocked(rpc.list).mock.calls[2]?.[0], {
					since_seq: 1,
					limit: AUDIT_LOG_LIST_LIMIT_MAX
				});
				assert.deepStrictEqual(seqs(state), [5, 4, 3, 2, 1]);
			});

			test('a reopen while a deferred fill is in flight fills from the fetched page', async () => {
				const list = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
				const gap = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
				const rpc: AuditLogRpc = {
					list: vi
						.fn()
						.mockReturnValueOnce(list.promise)
						.mockReturnValueOnce(gap.promise)
						.mockResolvedValue({ events: [make_event(11), make_event(12)] }),
					role_grant_history: vi.fn()
				};
				const state = new AuditLogState({ get_rpc: () => rpc });
				const fetching = state.fetch({ event_type: 'login' });
				state.subscribe({ event_type: 'login' });
				const source = latest_source();
				source.open();
				list.resolve({ events: [make_event(10)] });
				await fetching;
				assert.isTrue(state.gap_fill.loading);
				source.emit(make_event(13));
				source.fail(false);
				source.open();
				await settle();
				gap.resolve({ events: [] });
				await settle();

				assert.deepStrictEqual(vi.mocked(rpc.list).mock.calls[2]?.[0], {
					event_type: 'login',
					since_seq: 10,
					limit: AUDIT_LOG_LIST_LIMIT_MAX
				});
				assert.deepStrictEqual(seqs(state), [13, 12, 11, 10]);
			});

			test('a retry after the stream closed during a fill fills from that fill', async () => {
				const gap = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
				const rpc: AuditLogRpc = {
					list: vi
						.fn()
						.mockResolvedValueOnce({ events: [make_event(1)] })
						.mockReturnValueOnce(gap.promise)
						.mockResolvedValue({ events: [make_event(2), make_event(3)] }),
					role_grant_history: vi.fn()
				};
				const state = new AuditLogState({ get_rpc: () => rpc });
				await state.fetch();
				state.subscribe();
				latest_source().open();
				latest_source().emit(make_event(5));
				latest_source().fail(true);
				assert.strictEqual(state.stream_status, 'closed');

				state.subscribe();
				latest_source().open();
				await settle();
				gap.resolve({ events: [] });
				await settle();

				assert.strictEqual(vi.mocked(rpc.list).mock.calls[2]?.[0]?.since_seq, 1);
				assert.deepStrictEqual(seqs(state), [5, 3, 2, 1]);
			});

			test('a failed fill is retried from its start on the next open', async () => {
				const { rpc, calls } = make_list_rpc([make_event(1)], new Error('gap failed'), []);
				const state = new AuditLogState({ get_rpc: () => rpc });
				await state.fetch();
				state.subscribe();
				const source = latest_source();
				source.open();
				await settle();
				assert.strictEqual(state.gap_fill.error, 'gap failed');
				source.emit(make_event(5));

				source.fail(false);
				source.open();
				await settle();

				assert.strictEqual(calls[2]?.since_seq, 1);
				assert.strictEqual(state.gap_fill.error, null);
			});

			test('a refresh that aborts a fill and fails leaves the fill owed', async () => {
				const gap = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
				const rpc: AuditLogRpc = {
					list: vi
						.fn()
						.mockResolvedValueOnce({ events: [make_event(1)] })
						.mockReturnValueOnce(gap.promise)
						.mockRejectedValueOnce(new Error('refresh failed'))
						.mockResolvedValue({ events: [] }),
					role_grant_history: vi.fn()
				};
				const state = new AuditLogState({ get_rpc: () => rpc });
				await state.fetch();
				state.subscribe();
				const source = latest_source();
				source.open();
				source.emit(make_event(5));
				await state.fetch();
				assert.strictEqual(state.list.error, 'refresh failed');
				gap.resolve({ events: [make_event(2)] });
				await settle();

				source.fail(false);
				source.open();
				await settle();

				assert.strictEqual(vi.mocked(rpc.list).mock.calls[3]?.[0]?.since_seq, 1);
			});

			test('a fill that commits clears what it owed', async () => {
				const { rpc, calls } = make_list_rpc([make_event(1)], [make_event(2)], []);
				const state = new AuditLogState({ get_rpc: () => rpc });
				await state.fetch();
				state.subscribe();
				const source = latest_source();
				source.open();
				await settle();
				source.emit(make_event(5));

				source.fail(false);
				source.open();
				await settle();

				assert.strictEqual(calls[2]?.since_seq, 5);
			});

			test('a fetch clears what a failed fill owed', async () => {
				const { rpc, calls } = make_list_rpc([make_event(1)], new Error('gap failed'), [
					make_event(4)
				]);
				const state = new AuditLogState({ get_rpc: () => rpc });
				await state.fetch();
				state.subscribe();
				const source = latest_source();
				source.open();
				await settle();
				await state.fetch();

				source.fail(false);
				source.open();
				await settle();

				assert.strictEqual(calls[3]?.since_seq, 4);
			});
		});

		test('an open during a newest-page fetch defers its fill to that fetch', async () => {
			const list = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const rpc: AuditLogRpc = {
				list: vi
					.fn()
					.mockResolvedValueOnce({ events: [make_event(8)] })
					.mockReturnValueOnce(list.promise)
					.mockResolvedValue({ events: [make_event(11)] }),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			const fetching = state.fetch();
			state.subscribe();
			const source = latest_source();
			source.open();
			source.emit(make_event(12));
			source.fail(false);
			source.open();
			await settle();
			// neither open filled past the page the fetch hasn't answered yet
			assert.strictEqual(vi.mocked(rpc.list).mock.calls.length, 2);

			list.resolve({ events: [make_event(10)] });
			await fetching;
			await settle();

			assert.deepStrictEqual(vi.mocked(rpc.list).mock.calls[2]?.[0], {
				since_seq: 10,
				limit: AUDIT_LOG_LIST_LIMIT_MAX
			});
			assert.deepStrictEqual(seqs(state), [12, 11, 10]);
		});

		test('an open deferred to a newest-page fetch that fails still owes its range', async () => {
			const list = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const rpc: AuditLogRpc = {
				list: vi
					.fn()
					.mockResolvedValueOnce({ events: [make_event(1)] })
					.mockReturnValueOnce(list.promise)
					.mockResolvedValue({ events: [make_event(2), make_event(3), make_event(4)] }),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			const fetching = state.fetch();
			state.subscribe();
			const source = latest_source();
			source.open();
			list.reject(new Error('refresh failed'));
			await fetching;
			assert.ok(state.list.error);
			source.emit(make_event(5));
			source.fail(false);
			source.open();
			await settle();

			// the reopen fills from the deferred open's anchor, not past the live row
			assert.deepStrictEqual(vi.mocked(rpc.list).mock.calls[2]?.[0], {
				since_seq: 1,
				limit: AUDIT_LOG_LIST_LIMIT_MAX
			});
			assert.deepStrictEqual(seqs(state), [5, 4, 3, 2, 1]);
		});

		test('an open deferred to a newest-page fetch keeps an earlier fill range it owes', async () => {
			const gap = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const list = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const rpc: AuditLogRpc = {
				list: vi
					.fn()
					.mockResolvedValueOnce({ events: [make_event(1)] })
					.mockReturnValueOnce(gap.promise)
					.mockReturnValueOnce(list.promise)
					.mockResolvedValue({ events: [make_event(2), make_event(3), make_event(4)] }),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe();
			const source = latest_source();
			source.open();
			// a live row advances the anchor past the fill still in flight
			source.emit(make_event(5));
			// the refresh aborts the fill, and the reopen during it defers
			const fetching = state.fetch();
			source.fail(false);
			source.open();
			list.reject(new Error('refresh failed'));
			await fetching;
			source.fail(false);
			source.open();
			await settle();

			// the next fill starts where the aborted one did, not at the deferring anchor
			assert.deepStrictEqual(vi.mocked(rpc.list).mock.calls[3]?.[0], {
				since_seq: 1,
				limit: AUDIT_LOG_LIST_LIMIT_MAX
			});
			assert.deepStrictEqual(seqs(state), [5, 4, 3, 2, 1]);
		});

		test('an open during a later-page fetch fills at once', async () => {
			const page = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const rpc: AuditLogRpc = {
				list: vi
					.fn()
					.mockResolvedValueOnce({ events: [make_event(3)] })
					.mockReturnValueOnce(page.promise)
					.mockResolvedValue({ events: [] }),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			const paging = state.fetch({ offset: 50 });
			state.subscribe();
			latest_source().open();
			await settle();

			// a later page doesn't cover the newest events, so the open doesn't wait on it
			assert.deepStrictEqual(vi.mocked(rpc.list).mock.calls[2]?.[0], {
				since_seq: 3,
				limit: AUDIT_LOG_LIST_LIMIT_MAX
			});
			page.resolve({ events: [] });
			await paging;
		});

		test('a later-page fetch under another filter keeps a fill from merging', async () => {
			const gap = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
			const logout = make_event(0, { event_type: 'logout' });
			const rpc: AuditLogRpc = {
				list: vi
					.fn()
					.mockResolvedValueOnce({ events: [make_event(1)] })
					.mockReturnValueOnce(gap.promise)
					.mockResolvedValueOnce({ events: [logout] })
					.mockResolvedValue({ events: [] }),
				role_grant_history: vi.fn()
			};
			const state = new AuditLogState({ get_rpc: () => rpc });
			await state.fetch();
			state.subscribe();
			latest_source().open();
			await state.fetch({ event_type: 'logout', offset: 50 });
			gap.resolve({ events: [make_event(2), make_event(3)] });
			await settle();

			assert.deepStrictEqual(seqs(state), [0]);
		});

		test('a later page does not run a deferred fill, which waits for the newest page', async () => {
			const { rpc, calls } = make_list_rpc([make_event(3)], [make_event(9)], []);
			const state = new AuditLogState({ get_rpc: () => rpc });
			state.subscribe();
			latest_source().open();
			await settle();
			assert.strictEqual(calls.length, 0);

			await state.fetch({ offset: 50 });
			await settle();
			assert.strictEqual(calls.length, 1);

			await state.fetch();
			await settle();
			assert.deepStrictEqual(calls[2], { since_seq: 9, limit: AUDIT_LOG_LIST_LIMIT_MAX });
		});
	});
});

describe('AuditLogState.fetch while streaming', () => {
	beforeEach(() => {
		StubEventSource.instances = [];
		vi.stubGlobal('EventSource', StubEventSource);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('keeps live rows newer than the page and anchors past them', async () => {
		const list = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
		const rpc: AuditLogRpc = {
			list: vi
				.fn()
				.mockResolvedValueOnce({ events: [make_event(5)] })
				.mockResolvedValueOnce({ events: [] })
				.mockReturnValueOnce(list.promise)
				.mockResolvedValue({ events: [] }),
			role_grant_history: vi.fn()
		};
		const state = new AuditLogState({ get_rpc: () => rpc });
		await state.fetch();
		state.subscribe();
		const source = latest_source();
		source.open();
		await settle();

		// a refresh whose query ran before the live rows 12 and 13 landed
		const fetching = state.fetch();
		source.emit(make_event(12));
		source.emit(make_event(13));
		list.resolve({ events: [make_event(10), make_event(9)] });
		await fetching;

		assert.deepStrictEqual(seqs(state), [13, 12, 10, 9]);
		source.fail(false);
		source.open();
		await settle();
		assert.strictEqual(vi.mocked(rpc.list).mock.calls[3]?.[0]?.since_seq, 13);
	});

	test('a fetch after disconnect replaces the list', async () => {
		const { rpc } = make_list_rpc([make_event(10)]);
		const state = new AuditLogState({ get_rpc: () => rpc });
		state.subscribe();
		const source = latest_source();
		source.emit(make_event(12));
		state.disconnect();

		await state.fetch();

		assert.deepStrictEqual(seqs(state), [10]);
	});

	test("keeps only the live rows that match the fetch's filter", async () => {
		const list = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
		const rpc: AuditLogRpc = {
			list: vi.fn().mockReturnValueOnce(list.promise),
			role_grant_history: vi.fn()
		};
		const state = new AuditLogState({ get_rpc: () => rpc });
		state.subscribe();
		const source = latest_source();
		source.open();

		const fetching = state.fetch({ event_type: 'logout' });
		source.emit(make_event(12));
		source.emit(make_event(13, { event_type: 'logout' }));
		list.resolve({ events: [make_event(10, { event_type: 'logout' })] });
		await fetching;
		await settle();

		assert.deepStrictEqual(seqs(state), [13, 10]);
		// the stream doesn't match the list, so no deferred fill runs
		assert.strictEqual(vi.mocked(rpc.list).mock.calls.length, 1);
	});

	test("kept live rows don't anchor a list the stream's filter doesn't match", async () => {
		const list = make_deferred<{ events: Array<AuditLogEventWithUsernamesJson> }>();
		const rpc: AuditLogRpc = {
			list: vi
				.fn()
				.mockResolvedValueOnce({ events: [make_event(1)] })
				.mockResolvedValueOnce({ events: [] })
				.mockReturnValueOnce(list.promise)
				.mockResolvedValue({ events: [] }),
			role_grant_history: vi.fn()
		};
		const state = new AuditLogState({ get_rpc: () => rpc });
		await state.fetch();
		state.subscribe();
		latest_source().open();
		await settle();

		const fetching = state.fetch({ event_type: 'logout' });
		latest_source().emit(make_event(12, { event_type: 'logout' }));
		list.resolve({ events: [make_event(10, { event_type: 'logout' })] });
		await fetching;
		assert.deepStrictEqual(seqs(state), [12, 10]);

		state.subscribe({ event_type: 'logout' });
		latest_source().open();
		await settle();
		assert.strictEqual(vi.mocked(rpc.list).mock.calls[3]?.[0]?.since_seq, 10);
	});
});

describe('audit_log_filter_matches', () => {
	const acct_2 = 'acct-2' as Uuid;

	test('matches everything without a filter', () => {
		assert.isTrue(audit_log_filter_matches(make_event(1), undefined));
		assert.isTrue(audit_log_filter_matches(make_event(1), {}));
	});

	test('matches event_type and outcome', () => {
		const event = make_event(1, { event_type: 'login', outcome: 'failure' });
		assert.isTrue(audit_log_filter_matches(event, { event_type: 'login', outcome: 'failure' }));
		assert.isFalse(audit_log_filter_matches(event, { event_type: 'logout' }));
		assert.isFalse(audit_log_filter_matches(event, { outcome: 'success' }));
	});

	test('matches account_id on either side', () => {
		assert.isTrue(
			audit_log_filter_matches(make_event(1, { account_id: acct_1 }), { account_id: acct_1 })
		);
		assert.isTrue(
			audit_log_filter_matches(make_event(1, { target_account_id: acct_1 }), { account_id: acct_1 })
		);
		assert.isFalse(
			audit_log_filter_matches(make_event(1, { account_id: acct_2, target_account_id: acct_2 }), {
				account_id: acct_1
			})
		);
	});
});
