/**
 * Reactive state for the audit log viewer.
 *
 * Supports both fetch-based pagination and realtime SSE streaming.
 * SSE events are prepended to the list; use `fetch()` for initial load and filters.
 *
 * @module
 */

import {DEV} from 'esm-env';

import {Loadable} from './loadable.svelte.js';
import {parse_response_error, ui_fetch} from './ui_fetch.js';
import type {
	AuditLogEventJson,
	AuditLogEventWithUsernamesJson,
	PermitHistoryEventJson,
} from '../auth/audit_log_schema.js';
import type {SseNotification} from '../realtime/sse.js';

/** Options for fetching audit log events. */
export interface AuditLogFetchOptions {
	event_type?: string;
	account_id?: string;
	limit?: number;
	offset?: number;
}

export class AuditLogState extends Loadable {
	events: Array<AuditLogEventWithUsernamesJson> = $state([]);
	permit_history_events: Array<PermitHistoryEventJson> = $state([]);

	readonly count = $derived(this.events.length);

	/** Whether the SSE stream is currently connected. */
	connected = $state(false);

	/** The highest `seq` seen — used for gap fill on reconnection. */
	#last_seq: number | null = null;

	/** Active EventSource instance. */
	#event_source: EventSource | null = null;

	/** Path to the SSE stream endpoint. */
	readonly #stream_url: string;

	constructor(stream_url = '/api/admin/audit-log/stream') {
		super();
		this.#stream_url = stream_url;
	}

	async fetch(options?: AuditLogFetchOptions): Promise<void> {
		await this.run(async () => {
			const params = new URLSearchParams();
			if (options?.event_type) params.set('event_type', options.event_type);
			if (options?.account_id) params.set('account_id', options.account_id);
			if (options?.limit != null) params.set('limit', String(options.limit));
			if (options?.offset != null) params.set('offset', String(options.offset));
			const qs = params.toString();
			const url = `/api/admin/audit-log${qs ? `?${qs}` : ''}`;
			const response = await ui_fetch(url);
			if (!response.ok) {
				throw new Error(await parse_response_error(response, 'Failed to fetch audit log'));
			}
			const data = await response.json();
			this.events = data.events ?? [];
			// track the highest seq for gap fill
			this.#update_last_seq(this.events);
		});
	}

	async fetch_permit_history(limit?: number, offset?: number): Promise<void> {
		await this.run(async () => {
			const params = new URLSearchParams();
			if (limit != null) params.set('limit', String(limit));
			if (offset != null) params.set('offset', String(offset));
			const qs = params.toString();
			const url = `/api/admin/audit-log/permit-history${qs ? `?${qs}` : ''}`;
			const response = await ui_fetch(url);
			if (!response.ok) {
				throw new Error(await parse_response_error(response, 'Failed to fetch permit history'));
			}
			const data = await response.json();
			this.permit_history_events = data.events ?? [];
		});
	}

	/**
	 * Connect to the SSE stream for realtime audit events.
	 *
	 * New events are prepended to `events`. EventSource auto-reconnects on
	 * transient errors; `since_seq` fills gaps on reconnection.
	 *
	 * @returns cleanup function that closes the connection
	 */
	subscribe(): () => void {
		this.disconnect();

		const source = new EventSource(this.#stream_url);
		this.#event_source = source;

		source.onopen = () => {
			if (DEV) console.log('[audit_log_sse] connected');
			this.connected = true;
			// fill any gap from reconnection
			if (this.#last_seq != null) {
				void this.#fill_gap(this.#last_seq);
			}
		};

		source.onmessage = (e) => {
			try {
				const notification: SseNotification = JSON.parse(e.data as string);
				const raw = notification.params as AuditLogEventJson;
				if (DEV) console.log('[audit_log_sse]', notification.method, raw);
				// normalize SSE events to include username fields
				const event: AuditLogEventWithUsernamesJson = {
					...raw,
					username: null,
					target_username: null,
				};
				// prepend — newest first, matching the fetch sort order
				this.events = [event, ...this.events];
				this.#last_seq = Math.max(this.#last_seq ?? 0, event.seq);
			} catch {
				// ignore malformed messages
			}
		};

		source.onerror = () => {
			if (DEV) console.log('[audit_log_sse] error, readyState:', source.readyState);
			this.connected = source.readyState === EventSource.OPEN;
		};

		return () => this.disconnect();
	}

	/** Close the SSE connection. */
	disconnect(): void {
		if (this.#event_source) {
			this.#event_source.close();
			this.#event_source = null;
		}
		this.connected = false;
	}

	/** Fetch events missed during disconnection, keyed by `since_seq`. */
	async #fill_gap(since_seq: number): Promise<void> {
		try {
			const url = `/api/admin/audit-log?since_seq=${since_seq}&limit=200`;
			const response = await ui_fetch(url);
			if (!response.ok) return;
			const data = await response.json();
			const gap_events: Array<AuditLogEventWithUsernamesJson> = data.events ?? [];
			if (gap_events.length === 0) return;
			// merge — deduplicate by id, keep newest-first order
			const existing_ids = new Set(this.events.map((e) => e.id));
			const new_events = gap_events.filter((e) => !existing_ids.has(e.id));
			if (new_events.length > 0) {
				this.events = [...new_events, ...this.events];
				this.#update_last_seq(new_events);
			}
		} catch {
			// gap fill is best-effort
		}
	}

	/** Update `#last_seq` from an array of events. */
	#update_last_seq(events: Array<AuditLogEventWithUsernamesJson>): void {
		for (const event of events) {
			this.#last_seq = Math.max(this.#last_seq ?? 0, event.seq);
		}
	}
}
