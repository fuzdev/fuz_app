/**
 * Reactive state for the consentful-role-grants offer flow.
 *
 * Maintains one offer cache keyed by id, seeded by the RPC list/history
 * actions and kept live by the six role-grant-offer WebSocket notifications.
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
import type {RoleGrantOfferJson} from '../auth/role_grant_offer_schema.js';
import {
	ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	ROLE_GRANT_REVOKE_NOTIFICATION_METHOD,
} from '../auth/role_grant_offer_notifications.js';

/**
 * Svelte context for `RoleGrantOffersState`.
 * Use `role_grant_offers_state_context.set(state)` in the provider and
 * `role_grant_offers_state_context.get()` to access.
 */
export const role_grant_offers_state_context = create_context<RoleGrantOffersState>();

/**
 * Narrow RPC surface consumed by `RoleGrantOffersState`. Consumers adapt their
 * typed client (e.g. a `create_rpc_client` Proxy) to this shape — the state
 * class stays decoupled from the client's `Result` return type so tests can
 * inject plain-function stubs.
 */
export interface RoleGrantOffersRpc {
	list: () => Promise<{offers: Array<RoleGrantOfferJson>}>;
	history: (options?: {
		limit?: number;
		offset?: number;
	}) => Promise<{offers: Array<RoleGrantOfferJson>}>;
	create: (params: {
		to_account_id: string;
		to_actor_id?: string | null;
		role: string;
		scope_id?: string | null;
		message?: string | null;
	}) => Promise<{offer: RoleGrantOfferJson}>;
	accept: (offer_id: string) => Promise<{
		role_grant_id: string;
		offer: RoleGrantOfferJson;
		superseded_offer_ids: Array<string>;
	}>;
	decline: (offer_id: string, reason?: string | null) => Promise<{ok: true}>;
	retract: (offer_id: string) => Promise<{ok: true}>;
}

/** Narrow WS notification envelope — method + params, matching `JsonrpcNotification`. */
export interface RoleGrantOfferNotification {
	method: string;
	params: unknown;
}

/** Subscription primitive — consumer wires their WS receiver; returns a disposer. */
export type RoleGrantOfferSubscribe = (
	handler: (notification: RoleGrantOfferNotification) => void,
) => () => void;

export interface RoleGrantOffersStateOptions {
	rpc: RoleGrantOffersRpc;
	/** Reactive accessor for the current account id; returns `null` when logged out. */
	account_id: () => string | null;
	/**
	 * Reactive accessor for the current actor id — required to classify
	 * offers as outgoing. Returns `null` when unknown.
	 */
	actor_id: () => string | null;
}

const is_terminal = (o: RoleGrantOfferJson): boolean =>
	o.accepted_at !== null ||
	o.declined_at !== null ||
	o.retracted_at !== null ||
	o.superseded_at !== null;

export class RoleGrantOffersState extends Loadable {
	readonly #rpc: RoleGrantOffersRpc;
	readonly #get_account_id: () => string | null;
	readonly #get_actor_id: () => string | null;

	#offers: Map<string, RoleGrantOfferJson> = $state.raw(new Map());

	/** Pending offers for the current account, soonest-expiring first. */
	readonly incoming: Array<RoleGrantOfferJson> = $derived.by(() => {
		const account_id = this.#get_account_id();
		if (!account_id) return [];
		const now = Date.now();
		const rows: Array<RoleGrantOfferJson> = [];
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
	readonly outgoing: Array<RoleGrantOfferJson> = $derived.by(() => {
		const actor_id = this.#get_actor_id();
		if (!actor_id) return [];
		const now = Date.now();
		const rows: Array<RoleGrantOfferJson> = [];
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
	readonly history: Array<RoleGrantOfferJson> = $derived.by(() => {
		const rows = Array.from(this.#offers.values());
		rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
		return rows;
	});

	readonly incoming_count: number = $derived(this.incoming.length);

	constructor(options: RoleGrantOffersStateOptions) {
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

	/**
	 * Issue a new offer; merges the returned offer into the cache on success.
	 *
	 * `to_actor_id` (optional) narrows the offer to a specific actor on
	 * `to_account_id`; omit / null for the account-grain default (any actor
	 * on the recipient account may accept).
	 */
	async create(params: {
		to_account_id: string;
		to_actor_id?: string | null;
		role: string;
		scope_id?: string | null;
		message?: string | null;
	}): Promise<RoleGrantOfferJson | undefined> {
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
	subscribe(subscribe_fn: RoleGrantOfferSubscribe): () => void {
		return subscribe_fn((notification) => {
			this.apply_notification(notification);
		});
	}

	/**
	 * Reduce a single WS notification into the cache. Exposed so consumers
	 * wiring their WS receiver directly (without `subscribe`) and tests can
	 * drive the reducer without allocating a subscription.
	 *
	 * @mutates `this`
	 */
	apply_notification(notification: RoleGrantOfferNotification): void {
		switch (notification.method) {
			case ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD:
			case ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD:
			case ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD:
			case ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD:
			case ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD: {
				const params = notification.params;
				if (!params || typeof params !== 'object' || !('offer' in params)) return;
				const offer = (params as {offer: unknown}).offer;
				if (!is_role_grant_offer_like(offer)) return;
				this.#merge_offers([offer]);
				return;
			}
			case ROLE_GRANT_REVOKE_NOTIFICATION_METHOD:
				// role_grant_revoke is a role-grant-lifecycle event — the offer cache
				// is unaffected. Consumers handle it in an auth/role_grants state.
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

	#merge_offers(offers: Array<RoleGrantOfferJson>): void {
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

const is_role_grant_offer_like = (value: unknown): value is RoleGrantOfferJson =>
	!!value &&
	typeof value === 'object' &&
	typeof (value as RoleGrantOfferJson).id === 'string' &&
	typeof (value as RoleGrantOfferJson).to_account_id === 'string' &&
	typeof (value as RoleGrantOfferJson).from_actor_id === 'string';
