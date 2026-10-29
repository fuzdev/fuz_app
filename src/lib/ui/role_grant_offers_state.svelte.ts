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
 * `FrontendWebsocketClient` / `ActionDispatcher` receiver to `apply_notification`.
 *
 * Holds one slot per RPC verb: `AsyncSlot`s for `list`, `list_history` and
 * `create`, and `KeyedAsyncSlot`s keyed by offer id for the per-row verbs
 * `accept`, `decline` and `retract`, so each row carries its own pending
 * state and error. The cache `#offers` lives on the class (multiple ops
 * write into it via `#merge_offers` / `#remove_offer`); the `create` slot is
 * typed `AsyncSlot<RoleGrantOfferJson>` so `submit_create` can return the
 * new offer via the slot's supersession-safe `data` path, but the other
 * slots' `data` is unused (no single op owns the cache). Each terminal verb
 * stamps the offer it answers into the cache, so `history` shows it whether
 * or not its WS notification arrives. Method names use the `submit_*`
 * prefix to avoid slot-name collisions; the `history` view stayed natural
 * by naming the fetch slot `list_history`.
 *
 * @module
 */

import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';

import { AsyncSlot } from './async_slot.svelte.ts';
import { KeyedAsyncSlot } from './keyed_async_slot.svelte.ts';
import { is_iso8601_seconds_live } from '../timestamp.ts';
import type { Uuid } from '../primitive_schemas.ts';
import type { RoleGrantOfferJson } from '../auth/role_grant_offer_schema.ts';
import {
	GRANT_SCOPE_PAIRED_MESSAGE,
	is_grant_scope_paired,
	type RoleGrantOfferAcceptInput,
	type RoleGrantOfferAcceptOutput,
	type RoleGrantOfferCreateInput,
	type RoleGrantOfferCreateOutput,
	type RoleGrantOfferDeclineInput,
	type RoleGrantOfferDeclineOutput,
	type RoleGrantOfferHistoryInput,
	type RoleGrantOfferHistoryOutput,
	type RoleGrantOfferListInput,
	type RoleGrantOfferListOutput,
	type RoleGrantOfferRetractInput,
	type RoleGrantOfferRetractOutput
} from '../auth/role_grant_offer_action_specs.ts';
import {
	ROLE_GRANT_OFFER_ACCEPTED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_DECLINED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_RETRACTED_NOTIFICATION_METHOD,
	ROLE_GRANT_OFFER_SUPERSEDE_NOTIFICATION_METHOD,
	ROLE_GRANT_REVOKE_NOTIFICATION_METHOD
} from '../auth/role_grant_offer_notifications.ts';

/**
 * The scope of an offer: global (both absent / `null`) or scoped (both set).
 * `scope_kind` and `scope_id` are paired on the wire — a lone `scope_id` is an
 * `invalid_params` refusal — so the pair is one union rather than two optional
 * fields.
 */
export type RoleGrantOfferScope =
	{ scope_kind?: null; scope_id?: null } | { scope_kind: string; scope_id: Uuid };

/**
 * Params for `submit_create` — `RoleGrantOfferCreateInput` with its scope as
 * the paired `RoleGrantOfferScope`, so a lone `scope_id` is a type error.
 */
export type RoleGrantOfferCreateParams = Omit<
	RoleGrantOfferCreateInput,
	'scope_kind' | 'scope_id'
> &
	RoleGrantOfferScope;

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
 * inject plain-function stubs. Each method takes its action's input as one
 * params object and returns its output, both typed from the action specs, so
 * the typed throwing client's methods bridge with no casts.
 */
export interface RoleGrantOffersRpc {
	list: (params?: RoleGrantOfferListInput) => Promise<RoleGrantOfferListOutput>;
	history: (params?: RoleGrantOfferHistoryInput) => Promise<RoleGrantOfferHistoryOutput>;
	create: (params: RoleGrantOfferCreateInput) => Promise<RoleGrantOfferCreateOutput>;
	accept: (params: RoleGrantOfferAcceptInput) => Promise<RoleGrantOfferAcceptOutput>;
	decline: (params: RoleGrantOfferDeclineInput) => Promise<RoleGrantOfferDeclineOutput>;
	retract: (params: RoleGrantOfferRetractInput) => Promise<RoleGrantOfferRetractOutput>;
}

/** Narrow WS notification envelope — method + params, matching `JsonrpcNotification`. */
export interface RoleGrantOfferNotification {
	method: string;
	params: unknown;
}

/** Subscription primitive — consumer wires their WS receiver; returns a disposer. */
export type RoleGrantOfferSubscribe = (
	handler: (notification: RoleGrantOfferNotification) => void
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

export class RoleGrantOffersState {
	readonly #rpc: RoleGrantOffersRpc;
	readonly #get_account_id: () => string | null;
	readonly #get_actor_id: () => string | null;

	readonly list = new AsyncSlot<void>();
	readonly list_history = new AsyncSlot<void>();
	readonly create = new AsyncSlot<RoleGrantOfferJson>();
	/** Per-offer accept, keyed by offer id. */
	readonly accept = new KeyedAsyncSlot<string>();
	/** Per-offer decline, keyed by offer id. */
	readonly decline = new KeyedAsyncSlot<string>();
	/** Per-offer retract, keyed by offer id. */
	readonly retract = new KeyedAsyncSlot<string>();

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
			// end-of-second rule, so the inbox never hides an offer the server's
			// raw-column `expires_at > NOW()` gate would still accept
			if (!is_iso8601_seconds_live(o.expires_at, now)) continue;
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
			// end-of-second comparison, see `incoming`
			if (!is_iso8601_seconds_live(o.expires_at, now)) continue;
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
		this.#rpc = options.rpc;
		this.#get_account_id = options.account_id;
		this.#get_actor_id = options.actor_id;
	}

	/** Seed the cache with the recipient-side pending inbox. */
	async fetch(): Promise<void> {
		await this.list.run(async () => {
			const { offers } = await this.#rpc.list();
			this.#merge_offers(offers);
		});
	}

	/** Seed both-directions history (includes terminal rows). */
	async fetch_history(options?: { limit?: number; offset?: number }): Promise<void> {
		await this.list_history.run(async () => {
			const { offers } = await this.#rpc.history(options);
			this.#merge_offers(offers);
		});
	}

	/**
	 * Issue a new offer; merges the returned offer into the cache on success.
	 *
	 * `to_actor_id` (optional) narrows the offer to a specific actor on
	 * `to_account_id`; omit / null for the account-grain default (any actor
	 * on the recipient account may accept). A scoped offer passes `scope_kind`
	 * and `scope_id` together; an unpaired scope (reachable from untyped
	 * callers) fails with `GRANT_SCOPE_PAIRED_MESSAGE` without an RPC.
	 */
	async submit_create(params: RoleGrantOfferCreateParams): Promise<RoleGrantOfferJson | undefined> {
		return this.create.run(async () => {
			if (!is_grant_scope_paired(params)) {
				throw new Error(GRANT_SCOPE_PAIRED_MESSAGE);
			}
			const { offer } = await this.#rpc.create(params);
			this.#merge_offers([offer]);
			return offer;
		});
	}

	/** Accept an offer; stamps it terminal in the cache and drops any siblings the server superseded. */
	async submit_accept(offer_id: Uuid): Promise<void> {
		await this.accept.run(offer_id, async () => {
			const result = await this.#rpc.accept({ offer_id });
			this.#merge_offers([result.offer]);
			// siblings are authoritatively superseded server-side; the
			// corresponding WS notifications will also arrive, but dropping
			// them eagerly keeps the inbox accurate in the gap.
			for (const sibling_id of result.superseded_offer_ids) {
				this.#remove_offer(sibling_id);
			}
		});
	}

	/** Decline an offer; stamps the declined offer the server returns into the cache. */
	async submit_decline(offer_id: Uuid, reason?: string | null): Promise<void> {
		await this.decline.run(offer_id, async () => {
			const { offer } = await this.#rpc.decline({ offer_id, reason });
			this.#merge_offers([offer]);
		});
	}

	/** Retract an offer; stamps the retracted offer the server returns into the cache. */
	async submit_retract(offer_id: Uuid): Promise<void> {
		await this.retract.run(offer_id, async () => {
			const { offer } = await this.#rpc.retract({ offer_id });
			this.#merge_offers([offer]);
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
				const offer = params.offer;
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

	/** Clear the cache and reset every slot. */
	reset(): void {
		this.list.reset();
		this.list_history.reset();
		this.create.reset();
		this.accept.reset();
		this.decline.reset();
		this.retract.reset();
		this.#offers = new Map();
	}

	/**
	 * Merge offers into the cache by id. A terminal offer is never replaced by
	 * a pending one — offers only move forward, so a late notification or seed
	 * can't revive one a verb already stamped terminal.
	 */
	#merge_offers(offers: ReadonlyArray<RoleGrantOfferJson>): void {
		const next = new Map(this.#offers);
		for (const offer of offers) {
			const known = next.get(offer.id);
			if (known && is_terminal(known) && !is_terminal(offer)) continue;
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
