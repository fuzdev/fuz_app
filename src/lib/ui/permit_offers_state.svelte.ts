/**
 * Reactive state for the consentful-permits offer flow.
 *
 * Maintains one offer cache keyed by id, seeded by the RPC list/history
 * actions and kept live by the six permit-offer WebSocket notifications.
 * `incoming` (recipient-side pending) and `outgoing` (grantor-side pending)
 * are derived views; `history` is the full cache ordered newest-first for
 * the grantor/admin history view.
 *
 * Wiring is transport-agnostic: the ctor accepts a narrow RPC interface
 * the consumer adapts from their typed client, plus an `account_id` /
 * `actor_id` getter pair (typically bound to `auth_state`). Notification
 * delivery is pull-only via `subscribe()` — the consumer plumbs their
 * `FrontendWebsocketClient` / `ActionPeer` receiver to `apply_notification`.
 *
 * @module
 */

import {create_context} from '@fuzdev/fuz_ui/context_helpers.js';

import {Loadable} from './loadable.svelte.js';
import type {PermitOfferJson} from '../auth/permit_offer_schema.js';
import {
	PERMIT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
	PERMIT_OFFER_DECLINED_NOTIFICATION_METHOD,
	PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD,
	PERMIT_OFFER_RETRACTED_NOTIFICATION_METHOD,
	PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	PERMIT_REVOKE_NOTIFICATION_METHOD,
} from '../auth/permit_offer_notifications.js';

/**
 * Svelte context for `PermitOffersState`.
 * Use `permit_offers_state_context.set(state)` in the provider and
 * `permit_offers_state_context.get()` to access.
 */
export const permit_offers_state_context = create_context<PermitOffersState>();

/**
 * Narrow RPC surface consumed by `PermitOffersState`. Consumers adapt their
 * typed client (e.g. a `create_rpc_client` Proxy) to this shape — the state
 * class stays decoupled from the client's `Result` return type so tests can
 * inject plain-function stubs.
 */
export interface PermitOffersRpc {
	list: () => Promise<{offers: Array<PermitOfferJson>}>;
	history: (options?: {
		limit?: number;
		offset?: number;
	}) => Promise<{offers: Array<PermitOfferJson>}>;
	create: (params: {
		to_account_id: string;
		role: string;
		scope_id?: string | null;
		message?: string | null;
	}) => Promise<{offer: PermitOfferJson}>;
	accept: (offer_id: string) => Promise<{
		permit_id: string;
		offer: PermitOfferJson;
		superseded_offer_ids: Array<string>;
	}>;
	decline: (offer_id: string, reason?: string | null) => Promise<{ok: true}>;
	retract: (offer_id: string) => Promise<{ok: true}>;
}

/** Narrow WS notification envelope — method + params, matching `JsonrpcNotification`. */
export interface PermitOfferNotification {
	method: string;
	params: unknown;
}

/** Subscription primitive — consumer wires their WS receiver; returns a disposer. */
export type PermitOfferSubscribe = (
	handler: (notification: PermitOfferNotification) => void,
) => () => void;

export interface PermitOffersStateOptions {
	rpc: PermitOffersRpc;
	/** Reactive accessor for the current account id; returns `null` when logged out. */
	account_id: () => string | null;
	/**
	 * Reactive accessor for the current actor id — required to classify
	 * offers as outgoing. Returns `null` when unknown.
	 */
	actor_id: () => string | null;
}

const is_terminal = (o: PermitOfferJson): boolean =>
	o.accepted_at !== null ||
	o.declined_at !== null ||
	o.retracted_at !== null ||
	o.superseded_at !== null;

export class PermitOffersState extends Loadable {
	readonly #rpc: PermitOffersRpc;
	readonly #get_account_id: () => string | null;
	readonly #get_actor_id: () => string | null;

	#offers: Map<string, PermitOfferJson> = $state.raw(new Map());

	/** Pending offers for the current account, soonest-expiring first. */
	readonly incoming: Array<PermitOfferJson> = $derived.by(() => {
		const account_id = this.#get_account_id();
		if (!account_id) return [];
		const now = Date.now();
		const rows: Array<PermitOfferJson> = [];
		for (const o of this.#offers.values()) {
			if (o.to_account_id !== account_id) continue;
			if (is_terminal(o)) continue;
			if (Date.parse(o.expires_at) <= now) continue;
			rows.push(o);
		}
		rows.sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
		return rows;
	});

	/** Pending offers from the current actor, newest-created first. */
	readonly outgoing: Array<PermitOfferJson> = $derived.by(() => {
		const actor_id = this.#get_actor_id();
		if (!actor_id) return [];
		const now = Date.now();
		const rows: Array<PermitOfferJson> = [];
		for (const o of this.#offers.values()) {
			if (o.from_actor_id !== actor_id) continue;
			if (is_terminal(o)) continue;
			if (Date.parse(o.expires_at) <= now) continue;
			rows.push(o);
		}
		rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
		return rows;
	});

	/** Every offer known to this state, newest-created first. Feeds the history view. */
	readonly history: Array<PermitOfferJson> = $derived.by(() => {
		const rows = Array.from(this.#offers.values());
		rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
		return rows;
	});

	readonly incoming_count: number = $derived(this.incoming.length);

	constructor(options: PermitOffersStateOptions) {
		super();
		this.#rpc = options.rpc;
		this.#get_account_id = options.account_id;
		this.#get_actor_id = options.actor_id;
	}

	/** Seed the cache with the recipient-side pending inbox. */
	async fetch(): Promise<void> {
		await this.run(async () => {
			const {offers} = await this.#rpc.list();
			this.#merge_offers(offers);
		});
	}

	/** Seed both-directions history (includes terminal rows). */
	async fetch_history(options?: {limit?: number; offset?: number}): Promise<void> {
		await this.run(async () => {
			const {offers} = await this.#rpc.history(options);
			this.#merge_offers(offers);
		});
	}

	/** Issue a new offer; merges the returned offer into the cache on success. */
	async create(params: {
		to_account_id: string;
		role: string;
		scope_id?: string | null;
		message?: string | null;
	}): Promise<PermitOfferJson | undefined> {
		return this.run(async () => {
			const {offer} = await this.#rpc.create(params);
			this.#merge_offers([offer]);
			return offer;
		});
	}

	/** Accept an offer; stamps it terminal in the cache and drops any siblings the server superseded. */
	async accept(offer_id: string): Promise<void> {
		await this.run(async () => {
			const result = await this.#rpc.accept(offer_id);
			this.#merge_offers([result.offer]);
			// siblings are authoritatively superseded server-side; the
			// corresponding WS notifications will also arrive, but dropping
			// them eagerly keeps the inbox accurate in the gap.
			for (const sibling_id of result.superseded_offer_ids) {
				this.#remove_offer(sibling_id);
			}
		});
	}

	async decline(offer_id: string, reason?: string | null): Promise<void> {
		await this.run(async () => {
			await this.#rpc.decline(offer_id, reason);
			this.#remove_offer(offer_id);
		});
	}

	async retract(offer_id: string): Promise<void> {
		await this.run(async () => {
			await this.#rpc.retract(offer_id);
			this.#remove_offer(offer_id);
		});
	}

	/**
	 * Wire a notification subscription. The handler dispatches each matching
	 * notification into `apply_notification`; the returned disposer unwires.
	 */
	subscribe(subscribe_fn: PermitOfferSubscribe): () => void {
		return subscribe_fn((notification) => {
			this.apply_notification(notification);
		});
	}

	/**
	 * Reduce a single WS notification into the cache. Exposed so consumers
	 * wiring their WS receiver directly (without `subscribe`) and tests can
	 * drive the reducer without allocating a subscription.
	 */
	apply_notification(notification: PermitOfferNotification): void {
		switch (notification.method) {
			case PERMIT_OFFER_RECEIVED_NOTIFICATION_METHOD:
			case PERMIT_OFFER_RETRACTED_NOTIFICATION_METHOD:
			case PERMIT_OFFER_ACCEPTED_NOTIFICATION_METHOD:
			case PERMIT_OFFER_DECLINED_NOTIFICATION_METHOD:
			case PERMIT_OFFER_SUPERSEDE_NOTIFICATION_METHOD: {
				const params = notification.params;
				if (!params || typeof params !== 'object' || !('offer' in params)) return;
				const offer = (params as {offer: unknown}).offer;
				if (!is_permit_offer_like(offer)) return;
				this.#merge_offers([offer]);
				return;
			}
			case PERMIT_REVOKE_NOTIFICATION_METHOD:
				// permit_revoke is a permit-lifecycle event — the offer cache
				// is unaffected. Consumers handle it in an auth/permits state.
				return;
			default:
				// unrelated notifications — ignore silently.
				return;
		}
	}

	/** Clear the cache and reset loading/error state. */
	override reset(): void {
		super.reset();
		this.#offers = new Map();
	}

	#merge_offers(offers: Array<PermitOfferJson>): void {
		const next = new Map(this.#offers);
		for (const offer of offers) {
			next.set(offer.id, offer);
		}
		this.#offers = next;
	}

	#remove_offer(offer_id: string): void {
		if (!this.#offers.has(offer_id)) return;
		const next = new Map(this.#offers);
		next.delete(offer_id);
		this.#offers = next;
	}
}

const is_permit_offer_like = (value: unknown): value is PermitOfferJson =>
	!!value &&
	typeof value === 'object' &&
	typeof (value as PermitOfferJson).id === 'string' &&
	typeof (value as PermitOfferJson).to_account_id === 'string' &&
	typeof (value as PermitOfferJson).from_actor_id === 'string';
