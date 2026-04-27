/**
 * Reactive state for the audit log viewer.
 *
 * Two fetch primitives (`fetch` for events, `fetch_permit_history` for the
 * grant/revoke shortcut) flow through an injected RPC adapter; the SSE
 * stream continues to use `EventSource` directly — streams aren't an RPC
 * concern.
 *
 * @module
 */

import {DEV} from 'esm-env';
import {create_context} from '@fuzdev/fuz_ui/context_helpers.js';

import {Loadable} from './loadable.svelte.js';
import type {
	AuditLogEventJson,
	AuditLogEventWithUsernamesJson,
	PermitHistoryEventJson,
} from '../auth/audit_log_schema.js';
import type {
	AuditLogListInput,
	AuditLogListOutput,
	AuditLogPermitHistoryInput,
	AuditLogPermitHistoryOutput,
} from '../auth/admin_action_specs.js';
import type {SseNotification} from '../realtime/sse.js';

/**
 * Narrow RPC surface consumed by `AuditLogState`. Consumers adapt their typed
 * RPC client to this shape. Mirrors `AdminAccountsRpc` / `AdminInvitesRpc`.
 * Method signatures track the wire spec inputs/outputs directly so the
 * adapter needs no casts.
 */
export interface AuditLogRpc {
	list: (input?: AuditLogListInput) => Promise<AuditLogListOutput>;
	permit_history: (input?: AuditLogPermitHistoryInput) => Promise<AuditLogPermitHistoryOutput>;
}

/**
 * Svelte context carrying the reactive `AuditLogRpc` accessor. Mirrors
 * `admin_accounts_rpc_context`. Unset context falls back to `() => null`.
 */
export const audit_log_rpc_context = create_context<() => AuditLogRpc | null>(() => () => null);

export interface AuditLogStateOptions {
	/**
	 * Reactive accessor for the RPC adapter. Matches the `get_rpc` pattern on
	 * `AdminAccountsState` — `null` disables fetch operations (SSE still works).
	 */
	get_rpc?: () => AuditLogRpc | null;
	/** SSE stream URL. Defaults to the shipped admin audit-log stream route. */
	stream_url?: string;
}

export class AuditLogState extends Loadable {
	readonly #get_rpc: () => AuditLogRpc | null;

	events: Array<AuditLogEventWithUsernamesJson> = $state.raw([]);
	permit_history_events: Array<PermitHistoryEventJson> = $state.raw([]);

	readonly count = $derived(this.events.length);

	/** Whether the SSE stream is currently connected. */
	connected = $state.raw(false);

	/** The highest `seq` seen — used for gap fill on reconnection. */
	#last_seq: number | null = null;

	/** Active EventSource instance. */
	#event_source: EventSource | null = null;

	/** Path to the SSE stream endpoint. */
	readonly #stream_url: string;

	constructor(options?: AuditLogStateOptions) {
		super();
		this.#get_rpc = options?.get_rpc ?? (() => null);
		this.#stream_url = options?.stream_url ?? '/api/admin/audit-log/stream';
	}

	/** True when an RPC adapter is wired. `fetch`/`fetch_permit_history` no-op without it. */
	get has_rpc(): boolean {
		return this.#get_rpc() !== null;
	}

	async fetch(options?: AuditLogListInput): Promise<void> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return;
		}
		await this.run(async () => {
			const {events} = await rpc.list(options);
			this.events = events;
			this.#update_last_seq(this.events);
		});
	}

	async fetch_permit_history(limit?: number, offset?: number): Promise<void> {
		const rpc = this.#get_rpc();
		if (!rpc) {
			this.error = 'rpc adapter not wired';
			return;
		}
		await this.run(async () => {
			const {events} = await rpc.permit_history({limit, offset});
			this.permit_history_events = events;
		});
	}

	/**
	 * Connect to the SSE stream for realtime audit events.
	 *
	 * New events are prepended to `events`. EventSource auto-reconnects on
	 * transient errors; `since_seq` fills gaps on reconnection.
	 *
	 * @returns cleanup function that closes the connection
	 * @mutates `this`
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

	/**
	 * Close the SSE connection.
	 *
	 * @mutates `this`
	 */
	disconnect(): void {
		if (this.#event_source) {
			this.#event_source.close();
			this.#event_source = null;
		}
		this.connected = false;
	}

	/** Fetch events missed during disconnection, keyed by `since_seq`. */
	async #fill_gap(since_seq: number): Promise<void> {
		const rpc = this.#get_rpc();
		if (!rpc) return;
		try {
			const {events: gap_events} = await rpc.list({since_seq, limit: 200});
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
