/**
 * Generic subscriber registry for broadcasting to SSE clients.
 *
 * Supports channel-based filtering — subscribers connect with optional
 * channel filters, and broadcasts reach only matching subscribers.
 *
 * Two identity slots enable both targeted disconnection and per-scope cap
 * enforcement:
 * - `scope` — a single capped identity (e.g., session hash). Subject to
 *   the per-scope cap and matched by `close_by_identity`. Use for the
 *   narrowest identity the subscriber belongs to.
 * - `groups` — any number of uncapped identities (e.g., account id).
 *   Matched by `close_by_identity` but not subject to any cap. Use for
 *   coarser scopes a stream should be reachable by.
 *
 * The split keeps "tabs-per-session" cap semantics sane when a stream also
 * carries a broader identity for coarse close — the broader identity
 * doesn't cap across sessions.
 *
 * @module
 */

import type {SseStream} from './sse.ts';

export interface Subscriber<T> {
	stream: SseStream<T>;
	/** Channels this subscriber listens to. `null` means all channels. */
	channels: Set<string> | null;
	/** Primary (capped) identity. `null` when none. */
	scope: string | null;
	/** Grouping identities for `close_by_identity`. `null` when none. */
	groups: Set<string> | null;
}

/** Options for `SubscriberRegistry`. */
export interface SubscriberRegistryOptions {
	/**
	 * Max subscribers sharing a single `scope`. On subscribe, when the count
	 * of subscribers with the same `scope` reaches this limit, the oldest
	 * matching subscriber(s) are closed before the new one is added.
	 * `null` (default) disables the cap. `groups` identities are never capped.
	 */
	max_per_scope?: number | null;
}

/** Options for `SubscriberRegistry.subscribe`. */
export interface SubscribeOptions {
	/** Channels to subscribe to. Empty/absent = all channels. */
	channels?: ReadonlyArray<string>;
	/**
	 * Primary (capped) identity — e.g., session hash. Subject to
	 * `max_per_scope` and matched by `close_by_identity`.
	 */
	scope?: string;
	/**
	 * Grouping identities — e.g., account id. Matched by `close_by_identity`
	 * but NOT subject to the cap. Use for coarse-targeted close.
	 */
	groups?: ReadonlyArray<string>;
}

/**
 * Generic subscriber registry with channel-based filtering and identity-keyed disconnection.
 *
 * Subscribers connect with optional channel filters, a capped `scope`, and
 * uncapped `groups`. Broadcasts go to a specific channel and reach only
 * matching subscribers. `close_by_identity` force-closes all subscribers
 * whose `scope` or `groups` contain the given key — use for auth revocation.
 *
 * @example
 * ```ts
 * const registry = new SubscriberRegistry<SseNotification>();
 *
 * // subscriber connects (from SSE endpoint)
 * const unsubscribe = registry.subscribe(stream, {channels: ['runs']});
 *
 * // when a run changes
 * registry.broadcast('runs', {method: 'run_created', params: {run}});
 *
 * // subscriber disconnects
 * unsubscribe();
 * ```
 *
 * @example
 * ```ts
 * // scope = session hash (capped), groups = [account id] (close-only)
 * const unsubscribe = registry.subscribe(stream, {
 *   channels: ['audit_log'],
 *   scope: session_hash,
 *   groups: [account_id],
 * });
 *
 * // coarse — close all of a user's streams on role revocation
 * registry.close_by_identity(account_id);
 *
 * // fine — close just the stream(s) tied to a specific session
 * registry.close_by_identity(session_hash);
 * ```
 */
export class SubscriberRegistry<T> {
	readonly #subscribers: Set<Subscriber<T>> = new Set();
	readonly #max_per_scope: number | null;

	constructor(options?: SubscriberRegistryOptions) {
		this.#max_per_scope = options?.max_per_scope ?? null;
	}

	/** Number of active subscribers. */
	get count(): number {
		return this.#subscribers.size;
	}

	/**
	 * Add a subscriber.
	 *
	 * @param stream - SSE stream to send data to
	 * @param options - channel filter and identity slots (`scope` + `groups`)
	 * @returns unsubscribe function
	 * @mutates registry - adds the new subscriber; closes oldest matching subscribers when `max_per_scope` is exceeded
	 */
	subscribe(stream: SseStream<T>, options?: SubscribeOptions): () => void {
		const channels =
			options?.channels && options.channels.length > 0 ? new Set(options.channels) : null;
		const scope = options?.scope ?? null;
		const groups = options?.groups && options.groups.length > 0 ? new Set(options.groups) : null;

		// Per-scope cap — only `scope` is capped, `groups` are never capped.
		// Insertion order of the backing Set preserves FIFO eviction semantics.
		if (this.#max_per_scope != null && scope !== null) {
			this.#enforce_scope_limit(scope, this.#max_per_scope);
		}

		const subscriber: Subscriber<T> = {stream, channels, scope, groups};
		this.#subscribers.add(subscriber);
		return () => {
			this.#subscribers.delete(subscriber);
		};
	}

	/**
	 * Broadcast data to all subscribers on a channel.
	 *
	 * Subscribers with no channel filter receive all broadcasts.
	 * Subscribers with a channel filter only receive matching broadcasts.
	 */
	broadcast(channel: string, data: T): void {
		for (const subscriber of this.#subscribers) {
			if (subscriber.channels === null || subscriber.channels.has(channel)) {
				subscriber.stream.send(data);
			}
		}
	}

	/**
	 * Force-close all subscribers whose `scope` or `groups` match the given key.
	 *
	 * Closes each matching stream and removes the subscriber from the registry.
	 * Use for auth revocation — when a user's permissions change, close their
	 * SSE connections so they must reconnect and re-authenticate.
	 *
	 * @param identity - the identity key to match (checked against `scope` and `groups`)
	 * @returns the number of subscribers closed
	 * @mutates registry - removes matching subscribers and closes their streams
	 */
	close_by_identity(identity: string): number {
		// collect first, then close — avoids mutating the Set during iteration
		// (stream.close() fires on_close listeners which may call unsubscribe)
		const to_close: Array<Subscriber<T>> = [];
		for (const subscriber of this.#subscribers) {
			if (subscriber.scope === identity || subscriber.groups?.has(identity)) {
				to_close.push(subscriber);
			}
		}
		for (const subscriber of to_close) {
			subscriber.stream.close();
			this.#subscribers.delete(subscriber);
		}
		return to_close.length;
	}

	#enforce_scope_limit(scope: string, max: number): void {
		// count existing subscribers with this scope (in insertion order)
		const matching: Array<Subscriber<T>> = [];
		for (const subscriber of this.#subscribers) {
			if (subscriber.scope === scope) matching.push(subscriber);
		}
		// close oldest first, stopping once we've freed up room for one more
		let overflow = matching.length - (max - 1);
		let i = 0;
		while (overflow > 0 && i < matching.length) {
			const victim = matching[i]!;
			victim.stream.close();
			this.#subscribers.delete(victim);
			overflow--;
			i++;
		}
	}
}
