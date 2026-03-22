/**
 * Generic subscriber registry for broadcasting to SSE clients.
 *
 * Supports channel-based filtering — subscribers connect with optional
 * channel filters, and broadcasts reach only matching subscribers.
 * Optional identity keys enable force-closing subscribers by identity
 * (e.g., close all streams for a specific account when their permissions change).
 *
 * @module
 */

import type {SseStream} from './sse.js';

export interface Subscriber<T> {
	stream: SseStream<T>;
	/** Channels this subscriber listens to. `null` means all channels. */
	channels: Set<string> | null;
	/** Optional identity key for targeted disconnection (e.g., account_id). */
	identity: string | null;
}

/**
 * Generic subscriber registry with channel-based filtering and identity-keyed disconnection.
 *
 * Subscribers connect with optional channel filters and an optional identity key.
 * Broadcasts go to a specific channel and reach only matching subscribers.
 * `close_by_identity` force-closes all subscribers with a given identity —
 * use for auth revocation (close streams when a user's permissions change).
 *
 * @example
 * ```ts
 * const registry = new SubscriberRegistry<SseNotification>();
 *
 * // subscriber connects (from SSE endpoint)
 * const unsubscribe = registry.subscribe(stream, ['runs']);
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
 * // identity-keyed subscription for auth revocation
 * const unsubscribe = registry.subscribe(stream, ['audit_log'], account_id);
 *
 * // when admin revokes the user's role — close their streams
 * registry.close_by_identity(account_id);
 * ```
 */
export class SubscriberRegistry<T> {
	readonly #subscribers: Set<Subscriber<T>> = new Set();

	/** Number of active subscribers. */
	get count(): number {
		return this.#subscribers.size;
	}

	/**
	 * Add a subscriber.
	 *
	 * @param stream - SSE stream to send data to
	 * @param channels - channels to subscribe to (`undefined` or empty = all channels)
	 * @param identity - optional identity key for targeted disconnection
	 * @returns unsubscribe function
	 */
	subscribe(stream: SseStream<T>, channels?: Array<string>, identity?: string): () => void {
		const subscriber: Subscriber<T> = {
			stream,
			channels: channels && channels.length > 0 ? new Set(channels) : null,
			identity: identity ?? null,
		};
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
	 *
	 * @param channel - the channel to broadcast on
	 * @param data - the data to send
	 */
	broadcast(channel: string, data: T): void {
		for (const subscriber of this.#subscribers) {
			if (subscriber.channels === null || subscriber.channels.has(channel)) {
				subscriber.stream.send(data);
			}
		}
	}

	/**
	 * Force-close all subscribers with the given identity.
	 *
	 * Closes each matching stream and removes the subscriber from the registry.
	 * Use for auth revocation — when a user's permissions change, close their
	 * SSE connections so they must reconnect and re-authenticate.
	 *
	 * @param identity - the identity key to match
	 * @returns the number of subscribers closed
	 */
	close_by_identity(identity: string): number {
		// collect first, then close — avoids mutating the Set during iteration
		// (stream.close() fires on_close listeners which may call unsubscribe)
		const to_close: Array<Subscriber<T>> = [];
		for (const subscriber of this.#subscribers) {
			if (subscriber.identity === identity) {
				to_close.push(subscriber);
			}
		}
		for (const subscriber of to_close) {
			subscriber.stream.close();
			this.#subscribers.delete(subscriber);
		}
		return to_close.length;
	}
}
