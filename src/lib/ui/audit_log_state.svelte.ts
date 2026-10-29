/**
 * Reactive state for the audit log viewer.
 *
 * Two fetch primitives (`fetch` for events, `fetch_role_grant_history` for the
 * grant/revoke shortcut) flow through an injected RPC adapter; the SSE
 * stream continues to use `EventSource` directly — streams aren't an RPC
 * concern.
 *
 * Holds `AsyncSlot`s for `list` (the main event list),
 * `role_grant_history` (the dedicated role-grant history endpoint), and
 * `gap_fill` (the catch-up fetch run each time the stream opens). Data lives
 * on the class so SSE pushes and gap-fill calls update it directly; both merge
 * by `seq`, so `events` stays newest-first however they interleave.
 *
 * @module
 */

import { DEV } from 'esm-env';
import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';

import { AsyncSlot } from './async_slot.svelte.ts';
import type {
	AuditLogEventJson,
	AuditLogEventWithUsernamesJson,
	RoleGrantHistoryEventJson
} from '../auth/audit_log_schema.ts';
import {
	AUDIT_LOG_LIST_LIMIT_MAX,
	type AuditLogListInput,
	type AuditLogListOutput,
	type AuditLogRoleGrantHistoryInput,
	type AuditLogRoleGrantHistoryOutput
} from '../auth/admin_action_specs.ts';
import type { SseNotification } from '../realtime/sse.ts';

/**
 * Narrow RPC surface consumed by `AuditLogState`. Consumers adapt their typed
 * RPC client to this shape. Mirrors `AdminAccountsRpc` / `AdminInvitesRpc`.
 * Method signatures track the wire spec inputs/outputs directly so the
 * adapter needs no casts.
 */
export interface AuditLogRpc {
	list: (params?: AuditLogListInput) => Promise<AuditLogListOutput>;
	role_grant_history: (
		params?: AuditLogRoleGrantHistoryInput
	) => Promise<AuditLogRoleGrantHistoryOutput>;
}

/**
 * Svelte context carrying the reactive `AuditLogRpc` accessor. Mirrors
 * `admin_accounts_rpc_context`. `get()` throws when no provisioner ran above
 * the component — the adapter is required.
 */
export const audit_log_rpc_context = create_context<() => AuditLogRpc>();

/**
 * The filter fields of `AuditLogListInput` — what `AuditLogState.subscribe`
 * applies to live events and to its gap fill, matching what a `fetch` with the
 * same fields returns. `account_id` matches either side of an event
 * (`account_id` or `target_account_id`), as the list query does.
 */
export type AuditLogFilter = Pick<AuditLogListInput, 'event_type' | 'outcome' | 'account_id'>;

/**
 * Whether an event passes an `AuditLogFilter` — the client-side twin of the
 * list query's filter conditions, applied to live stream events.
 *
 * @param event - the event to test
 * @param filter - the filter; absent or empty fields match everything
 */
export const audit_log_filter_matches = (
	event: AuditLogEventJson,
	filter: AuditLogFilter | undefined
): boolean => {
	if (!filter) return true;
	if (filter.event_type && event.event_type !== filter.event_type) return false;
	if (filter.outcome && event.outcome !== filter.outcome) return false;
	if (
		filter.account_id &&
		event.account_id !== filter.account_id &&
		event.target_account_id !== filter.account_id
	) {
		return false;
	}
	return true;
};

/**
 * Lifecycle of the audit SSE stream.
 *
 * - `'off'` — not subscribed (initial, or after `disconnect`)
 * - `'connecting'` — opening, or `EventSource` is retrying after a transient error
 * - `'open'` — connected and receiving events
 * - `'closed'` — the stream gave up: the server refused the reconnect (a revoked
 *   credential or a lost role answers it with 401/403), so `EventSource` stopped
 *   retrying; call `subscribe` again to retry
 */
export type AuditLogStreamStatus = 'off' | 'connecting' | 'open' | 'closed';

export interface AuditLogStateOptions {
	/**
	 * Reactive accessor for the RPC adapter. Matches the `get_rpc` pattern on
	 * `AdminAccountsState`. The SSE stream uses `EventSource` directly and is
	 * independent of this adapter.
	 */
	get_rpc: () => AuditLogRpc;
	/** SSE stream URL. Defaults to the shipped admin audit-log stream route. */
	stream_url?: string;
}

export class AuditLogState {
	readonly #get_rpc: () => AuditLogRpc;

	readonly list = new AsyncSlot<void>();
	readonly role_grant_history = new AsyncSlot<void>();
	/** The catch-up fetch run each time the stream opens; its `error` surfaces a failed fill. */
	readonly gap_fill = new AsyncSlot<void>();

	events: Array<AuditLogEventWithUsernamesJson> = $state.raw([]);
	role_grant_history_events: Array<RoleGrantHistoryEventJson> = $state.raw([]);

	readonly count: number = $derived(this.events.length);

	/** Lifecycle of the SSE stream — see `AuditLogStreamStatus`. */
	stream_status: AuditLogStreamStatus = $state.raw('off');

	/**
	 * Whether a gap fill hit its row limit, so events between the last one seen
	 * and the stream's reopening may be missing. Cleared by `fetch`, which
	 * replaces the list (as is a failed `gap_fill`).
	 */
	gap_truncated = $state.raw(false);

	/**
	 * The highest `seq` the list covers — the gap-fill anchor. `fetch` sets it
	 * from its result (`0` for an empty first page, which covers everything up
	 * to then), and gap-filled events and live events while the stream's filter
	 * is the list's advance it.
	 */
	#last_seq: number | null = null;

	/**
	 * The oldest `seq` a gap fill owes from — set when a fill starts, or when an
	 * open defers its fill to an in-flight newest-page fetch, and cleared when a
	 * fill commits or a fetch replaces the list. A fill aborted by a reopen or a
	 * retry, one that failed, or a deferring fetch that failed leaves it, so the
	 * next fill starts from there instead of past the live rows that arrived
	 * meanwhile. Never above `#last_seq`, which only rises while it is set.
	 */
	#fill_since: number | null = null;

	/**
	 * Whether the latest `fetch` is for the newest page — with `list.loading`,
	 * whether a newest-page fetch is in flight.
	 */
	#fetching_newest = false;

	/**
	 * Whether the stream's last open skipped its gap fill (the list had no
	 * anchor or another filter, or a newest-page fetch was in flight), so the
	 * `fetch` that anchors the list under the stream's filter runs it.
	 */
	#fill_deferred = false;

	/** The filter of the `fetch` that loaded `events`. */
	#list_filter: AuditLogFilter | undefined;

	/** The filter the stream applies, set by `subscribe`. */
	#stream_filter: AuditLogFilter | undefined;

	/** Active EventSource instance. */
	#event_source: EventSource | null = null;

	/** Path to the SSE stream endpoint. */
	readonly #stream_url: string;

	constructor(options: AuditLogStateOptions) {
		this.#get_rpc = options.get_rpc;
		this.#stream_url = options.stream_url ?? '/api/admin/audit/stream';
	}

	/**
	 * Load a page of events, replacing `events`.
	 *
	 * While the stream is live, events it delivered after the page's newest one
	 * that match the fetch's filter are kept, so a fetch answering mid-stream
	 * doesn't drop them. A newest-page fetch aborts an in-flight gap fill, which
	 * its own query covers, and when the stream opened before the list matched
	 * its filter or while the fetch was in flight, runs that open's gap fill
	 * from the fetched page.
	 *
	 * @param options - the list input; its filter fields become the list's filter
	 * @mutates `this`
	 */
	async fetch(options?: AuditLogListInput): Promise<void> {
		// a later page (`offset > 0`) doesn't cover the newest events
		const newest_page = !options?.offset;
		// the fill covers up to the stream's open, which this newer query covers too
		if (newest_page) this.gap_fill.abort();
		this.#fetching_newest = newest_page;
		await this.list.run(async (signal) => {
			const { events } = await this.#get_rpc().list(options);
			// a superseded fetch must not overwrite a newer one's list
			if (signal.aborted) return;
			const filter = to_audit_log_filter(options);
			const fetched_seq = events.length > 0 ? max_seq(events) : 0;
			const live =
				newest_page && this.#event_source
					? this.events.filter((e) => e.seq > fetched_seq && audit_log_filter_matches(e, filter))
					: [];
			this.events = live.length > 0 ? [...live, ...events] : events;
			this.#list_filter = filter;
			// a fresh list supersedes what an earlier gap fill missed
			this.gap_truncated = false;
			if (this.gap_fill.failed) this.gap_fill.reset();
			this.#fill_since = null;
			const stream_matches =
				this.#event_source !== null && filters_equal(filter, this.#stream_filter);
			// the stream opened before this list matched it, so events between this
			// query and that open may be missing — fill from the fetched page
			const fill_deferred = newest_page && stream_matches && this.#fill_deferred;
			// live rows anchor the list only when the stream covers its filter since
			// before the query
			this.#last_seq = newest_page
				? stream_matches && !fill_deferred
					? Math.max(fetched_seq, live.length > 0 ? max_seq(live) : 0)
					: fetched_seq
				: events.length > 0
					? fetched_seq
					: null;
			if (fill_deferred) {
				this.#fill_deferred = false;
				// while reconnecting, the next open fills from the anchor
				if (this.stream_status === 'open') void this.#fill_gap(fetched_seq);
			}
		});
	}

	async fetch_role_grant_history(limit?: number, offset?: number): Promise<void> {
		await this.role_grant_history.run(async () => {
			const { events } = await this.#get_rpc().role_grant_history({ limit, offset });
			this.role_grant_history_events = events;
		});
	}

	/**
	 * Connect to the SSE stream for realtime audit events.
	 *
	 * Live events matching `filter` merge into `events` by `seq`. `EventSource`
	 * reconnects on transient errors (`stream_status` reads `'connecting'`);
	 * each open runs a gap fill from the last `seq` seen, with the same filter.
	 * A refused reconnect ends the stream (`'closed'`) — call `subscribe` again
	 * to retry. Gap fills run only while `events` was fetched with the same
	 * filter: an open the list doesn't match yet defers its fill to the `fetch`
	 * with the stream's filter, and live events under another filter than the
	 * list's merge only when they match the list's filter too, without advancing
	 * the anchor.
	 *
	 * @param filter - which events to keep; omit for all
	 * @returns cleanup function that closes the connection
	 * @mutates `this`
	 */
	subscribe(filter?: AuditLogFilter): () => void {
		this.disconnect();

		this.#stream_filter = filter;
		const source = new EventSource(this.#stream_url);
		this.#event_source = source;
		this.stream_status = 'connecting';

		source.onopen = () => {
			if (DEV) console.log('[audit_log_sse] connected');
			this.stream_status = 'open';
			// fill any gap from before this open, or leave it to the fetch that
			// anchors the list under the stream's filter — an in-flight newest-page
			// fetch included, whose page may predate live rows already merged
			const anchored =
				this.#last_seq !== null && filters_equal(this.#list_filter, this.#stream_filter);
			const fill = anchored && !(this.#fetching_newest && this.list.loading);
			this.#fill_deferred = !fill;
			if (fill) {
				void this.#fill_gap(this.#last_seq!);
			} else if (anchored) {
				// the fetch fills from its page when it commits; if it fails, the next
				// fill still owes this open's range
				this.#fill_since ??= this.#last_seq;
			}
		};

		source.onmessage = (e) => {
			let raw: AuditLogEventJson;
			try {
				const notification: SseNotification = JSON.parse(e.data as string);
				raw = notification.params as AuditLogEventJson;
				if (DEV) console.log('[audit_log_sse]', notification.method, raw);
			} catch {
				// ignore malformed messages
				return;
			}
			if (!audit_log_filter_matches(raw, this.#stream_filter)) return;
			// a stream filter other than the list's lets through events the list
			// excludes, and what it streams doesn't cover the list's filter
			if (!audit_log_filter_matches(raw, this.#list_filter)) return;
			const anchors = filters_equal(this.#list_filter, this.#stream_filter);
			// normalize SSE events to include username fields
			this.#merge([{ ...raw, username: null, target_username: null }], false, anchors);
		};

		source.onerror = () => {
			if (DEV) console.log('[audit_log_sse] error, readyState:', source.readyState);
			if (source !== this.#event_source) return;
			if (source.readyState === EventSource.CLOSED) {
				// `EventSource` gave up (a refused reconnect) and won't retry
				source.close();
				this.#event_source = null;
				this.stream_status = 'closed';
			} else {
				this.stream_status = 'connecting';
			}
		};

		return () => this.disconnect();
	}

	/**
	 * Close the SSE connection and abort an in-flight gap fill.
	 *
	 * @mutates `this`
	 */
	disconnect(): void {
		this.gap_fill.abort();
		if (this.#event_source) {
			this.#event_source.close();
			this.#event_source = null;
		}
		this.stream_status = 'off';
	}

	/**
	 * Fetch the events missed before the stream (re)opened, with the stream's
	 * filter, from the start a fill still owes (`#fill_since`) or `since_seq`. A
	 * full page means the gap may hold more than the limit returns.
	 */
	async #fill_gap(since_seq: number): Promise<void> {
		const filter = this.#stream_filter;
		const from = this.#fill_since ?? since_seq;
		this.#fill_since = from;
		await this.gap_fill.run(async (signal) => {
			const limit = AUDIT_LOG_LIST_LIMIT_MAX;
			const { events } = await this.#get_rpc().list({ ...filter, since_seq: from, limit });
			// a disconnect or a newer fill aborted this one, maybe under another filter
			if (signal.aborted) return;
			// a later-page fetch under another filter replaced the list meanwhile
			if (!filters_equal(this.#list_filter, filter)) return;
			this.#fill_since = null;
			if (events.length >= limit) this.gap_truncated = true;
			this.#merge(events, true, true);
		});
	}

	/**
	 * Merge events into the newest-first list by `seq`, deduplicating by `id`.
	 *
	 * @param incoming - events to merge, any order
	 * @param replace - whether an incoming event replaces a listed one with the
	 *   same `id` (gap-fill rows carry resolved usernames; live rows don't)
	 * @param anchors - whether the events advance the gap-fill anchor (live rows
	 *   under another filter than the list's don't)
	 */
	#merge(
		incoming: Array<AuditLogEventWithUsernamesJson>,
		replace: boolean,
		anchors: boolean
	): void {
		if (incoming.length === 0) return;
		if (anchors) this.#last_seq = Math.max(this.#last_seq ?? 0, max_seq(incoming));
		const head = this.events[0];
		// fast path: one live event newer than everything listed
		if (incoming.length === 1 && (!head || incoming[0]!.seq > head.seq)) {
			this.events = [incoming[0]!, ...this.events];
			return;
		}
		const by_id: Map<string, AuditLogEventWithUsernamesJson> = new Map();
		for (const event of this.events) by_id.set(event.id, event);
		for (const event of incoming) {
			if (replace || !by_id.has(event.id)) by_id.set(event.id, event);
		}
		this.events = Array.from(by_id.values()).sort((a, b) => b.seq - a.seq);
	}
}

/** The filter fields of a list input. */
const to_audit_log_filter = (input: AuditLogListInput | undefined): AuditLogFilter | undefined => {
	if (!input) return undefined;
	const { event_type, outcome, account_id } = input;
	return { event_type, outcome, account_id };
};

/** Whether two filters select the same events — absent and empty fields are equal. */
const filters_equal = (a: AuditLogFilter | undefined, b: AuditLogFilter | undefined): boolean =>
	(a?.event_type || undefined) === (b?.event_type || undefined) &&
	(a?.outcome || undefined) === (b?.outcome || undefined) &&
	(a?.account_id || undefined) === (b?.account_id || undefined);

const max_seq = (events: Array<AuditLogEventJson>): number => {
	let max = 0;
	for (const event of events) if (event.seq > max) max = event.seq;
	return max;
};
