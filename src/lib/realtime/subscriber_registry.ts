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
 * Registration can run in two phases (`subscribe_pending` then `admit`) so a
 * revocation reaches a stream that is still opening — see the class doc.
 *
 * @module
 */

import type { SseStream } from './sse.ts';

/** One admitted subscriber, as `SubscriberRegistry.broadcast` sees it. */
export interface Subscriber<T> {
	stream: SseStream<T>;
	/** Channels this subscriber listens to. `null` means all channels. */
	channels: Set<string> | null;
	/** Primary (capped) identity. `null` when none. */
	scope: string | null;
	/** Grouping identities for `close_by_identity`. `null` when none. */
	groups: Set<string> | null;
}

/**
 * A registry entry: a `Subscriber` whose `stream` is `null` while it is
 * pending admission. No stream, nothing to deliver to — a pending entry is
 * inert by construction.
 */
type SubscriberEntry<T> = Omit<Subscriber<T>, 'stream'> & { stream: SseStream<T> | null };

/** Options for `SubscriberRegistry`. */
export interface SubscriberRegistryOptions {
	/**
	 * Max admitted subscribers sharing a single `scope`. When a subscriber is
	 * admitted and the count of admitted subscribers with the same `scope` has
	 * reached this limit, the oldest matching subscriber(s) are closed first.
	 * `null` (default) disables the cap. `groups` identities are never capped.
	 */
	max_per_scope?: number | null;
}

/** Options for `SubscriberRegistry.subscribe` and `subscribe_pending`. */
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
 * A registered subscription awaiting admission — what
 * `SubscriberRegistry.subscribe_pending` returns and
 * `SubscriberRegistry.admit` takes.
 *
 * Its entry is already in the registry, so every `close_by_identity` can reach
 * it, but nothing is delivered to it and it does not count toward the
 * per-scope cap until it is admitted.
 */
export interface PendingSubscription {
	/**
	 * Remove the registration, pending or admitted. Idempotent. Every path that
	 * refuses a pending subscription calls it, and an admitted stream's
	 * `on_close` listener does.
	 */
	unsubscribe: () => void;
}

/**
 * Generic subscriber registry with channel-based filtering and identity-keyed disconnection.
 *
 * Subscribers connect with optional channel filters, a capped `scope`, and
 * uncapped `groups`. Broadcasts go to a specific channel and reach only
 * matching subscribers. `close_by_identity` force-closes all subscribers
 * whose `scope` or `groups` contain the given key — use for auth revocation.
 *
 * ## Two-phase registration
 *
 * A stream is authorized once, at open, so a revocation has to be able to
 * reach it from the moment its credential is read. A route's gates run before
 * the stream exists, and each revocation closes only the streams *registered*
 * under what it revoked — registering after the gates leaves a window in which
 * a revocation closes nothing and the stream then opens on a dead session, or
 * under a role its actor no longer holds.
 *
 * So a route that authenticated a revocable credential registers in two
 * phases: `subscribe_pending` registers the subscription **un-admitted** —
 * closeable by every `close_by_identity`, and otherwise inert: it has no
 * stream, so no broadcast reaches it, the cap neither counts nor evicts for
 * it, and `count` does not see it (`pending_count` does). The route then
 * re-reads the credential and the role, and `admit` attaches the stream and
 * opens the feed — or refuses when a revocation closed the registration in
 * between, evicting nothing. The cap's eviction happens at admission.
 *
 * `subscribe` stays as the one-step form for a stream with nothing to revoke
 * behind it. The twin of the Rust `fuz_realtime` `SseRegistry`
 * (`subscribe_pending` / `admit` / `subscribe`).
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
 *
 * @example
 * ```ts
 * // two-phase, for a route behind a revocable credential
 * const pending = registry.subscribe_pending({scope: session_hash, groups: [account_id]});
 * if (!(await credential_is_still_live())) {
 *   pending.unsubscribe();
 *   return unauthorized();
 * }
 * const {response, stream} = create_sse_response(c, log);
 * if (registry.admit(pending, stream)) stream.on_close(pending.unsubscribe);
 * else stream.close(); // closed while pending — the body is the connect comment alone
 * return response;
 * ```
 */
export class SubscriberRegistry<T> {
	// insertion order is registration order — the cap's "oldest"
	readonly #subscribers: Set<SubscriberEntry<T>> = new Set();
	// each pending handle's entry; keyed per registry, so a handle from
	// another registry names nothing here
	readonly #pending: WeakMap<PendingSubscription, SubscriberEntry<T>> = new WeakMap();
	readonly #max_per_scope: number | null;

	constructor(options?: SubscriberRegistryOptions) {
		this.#max_per_scope = options?.max_per_scope ?? null;
	}

	/**
	 * Number of open — **admitted** — subscribers. A registration still pending
	 * admission is counted by `pending_count` instead.
	 */
	get count(): number {
		let count = 0;
		for (const subscriber of this.#subscribers) {
			if (subscriber.stream !== null) count++;
		}
		return count;
	}

	/**
	 * Number of registrations awaiting admission — between `subscribe_pending`
	 * and `admit` (or their refusal). For telemetry and tests.
	 */
	get pending_count(): number {
		let count = 0;
		for (const subscriber of this.#subscribers) {
			if (subscriber.stream === null) count++;
		}
		return count;
	}

	/**
	 * Add a subscriber, admitted at once — the one-step form of
	 * `subscribe_pending` + `admit`.
	 *
	 * **Not for a route that authenticated a revocable credential**: a
	 * revocation landing between that route's gates and this call closes
	 * nothing, and the stream would open on a dead credential (class doc,
	 * "Two-phase registration").
	 *
	 * @param stream - SSE stream to send data to
	 * @param options - channel filter and identity slots (`scope` + `groups`)
	 * @returns unsubscribe function
	 * @mutates registry - adds the new subscriber; closes oldest matching subscribers when `max_per_scope` is exceeded
	 */
	subscribe(stream: SseStream<T>, options?: SubscribeOptions): () => void {
		const subscriber = this.#create_entry(options);
		this.#admit_entry(subscriber, stream);
		this.#subscribers.add(subscriber);
		return () => {
			this.#subscribers.delete(subscriber);
		};
	}

	/**
	 * Register a subscription **un-admitted** — phase one of the two-phase
	 * registration (class doc).
	 *
	 * The registration is closeable at once by every `close_by_identity`
	 * matching its `scope` or `groups`, and until `admit` it receives no
	 * broadcast, is not counted, and evicts nothing. A caller that then refuses
	 * the request calls the returned handle's `unsubscribe`.
	 *
	 * @param options - channel filter and identity slots (`scope` + `groups`)
	 * @returns the pending handle `admit` takes
	 * @mutates registry - adds the un-admitted registration
	 */
	subscribe_pending(options?: SubscribeOptions): PendingSubscription {
		const subscriber = this.#create_entry(options);
		this.#subscribers.add(subscriber);
		const pending: PendingSubscription = {
			unsubscribe: () => {
				this.#subscribers.delete(subscriber);
			}
		};
		this.#pending.set(pending, subscriber);
		return pending;
	}

	/**
	 * Admit a pending subscription, attaching the stream it delivers to — phase
	 * two (class doc).
	 *
	 * If the registration is gone — a revocation closed it while it was
	 * pending, or it was unsubscribed — nothing is evicted and the subscription
	 * is refused. Otherwise the per-scope cap is enforced as in `subscribe`,
	 * counting only admitted subscribers, and the stream starts receiving
	 * `broadcast` data. Admitting twice is refused the second time.
	 *
	 * @param pending - the handle `subscribe_pending` returned
	 * @param stream - SSE stream to send data to
	 * @returns `false` when the subscription was not admitted — the caller ends the stream
	 * @mutates registry - attaches `stream`; closes oldest matching subscribers when `max_per_scope` is exceeded
	 */
	admit(pending: PendingSubscription, stream: SseStream<T>): boolean {
		const subscriber = this.#pending.get(pending);
		if (!subscriber || subscriber.stream !== null || !this.#subscribers.has(subscriber)) {
			return false;
		}
		this.#admit_entry(subscriber, stream);
		return true;
	}

	/**
	 * Broadcast data to all admitted subscribers on a channel.
	 *
	 * Subscribers with no channel filter receive all broadcasts.
	 * Subscribers with a channel filter only receive matching broadcasts. A
	 * registration pending admission is not an open stream and is skipped —
	 * nothing is queued toward a subscriber not yet authorized.
	 */
	broadcast(channel: string, data: T): void {
		for (const subscriber of this.#subscribers) {
			if (subscriber.stream === null) continue;
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
	 * Matches every registration, pending or admitted — never filter on
	 * admission here: reaching a registration in flight is the point of the
	 * pending phase, and `admit` then refuses it.
	 *
	 * A stream whose `close` throws does not stop the loop: every match is
	 * removed and closed, and the first error is thrown afterward.
	 *
	 * @param identity - the identity key to match (checked against `scope` and `groups`)
	 * @returns the number of subscribers closed
	 * @mutates registry - removes matching subscribers and closes their streams
	 * @throws the first error a stream's `close` threw, after every match was attempted
	 */
	close_by_identity(identity: string): number {
		return this.#close_where(
			(subscriber) => subscriber.scope === identity || !!subscriber.groups?.has(identity)
		);
	}

	/**
	 * Force-close every subscriber, pending or admitted — the shutdown close
	 * `AppServer.close` runs through the registry's `ConnectionCloser`.
	 *
	 * A stream whose `close` throws does not stop the loop: every subscriber is
	 * removed and closed, and the first error is thrown afterward.
	 *
	 * @returns the number of subscribers closed
	 * @mutates registry - removes every subscriber and closes its stream
	 * @throws the first error a stream's `close` threw, after every subscriber was attempted
	 */
	close_all(): number {
		return this.#close_where(() => true);
	}

	#close_where(predicate: (subscriber: SubscriberEntry<T>) => boolean): number {
		// collect first, then close — avoids mutating the Set during iteration
		// (stream.close() fires on_close listeners which may call unsubscribe)
		const to_close: Array<SubscriberEntry<T>> = [];
		for (const subscriber of this.#subscribers) {
			if (predicate(subscriber)) to_close.push(subscriber);
		}
		let failed = false;
		let first_error: unknown;
		for (const subscriber of to_close) {
			// removed first, so a stream whose close throws is unregistered too
			this.#subscribers.delete(subscriber);
			try {
				subscriber.stream?.close();
			} catch (error) {
				if (!failed) {
					failed = true;
					first_error = error;
				}
			}
		}
		if (failed) throw first_error;
		return to_close.length;
	}

	#create_entry(options: SubscribeOptions | undefined): SubscriberEntry<T> {
		return {
			stream: null,
			channels: options?.channels && options.channels.length > 0 ? new Set(options.channels) : null,
			scope: options?.scope ?? null,
			groups: options?.groups && options.groups.length > 0 ? new Set(options.groups) : null
		};
	}

	/**
	 * Enforce the per-scope cap for one more admitted subscriber on the entry's
	 * scope, then attach its stream.
	 */
	#admit_entry(subscriber: SubscriberEntry<T>, stream: SseStream<T>): void {
		// Per-scope cap — only `scope` is capped, `groups` are never capped. The
		// entry itself has no stream yet, so the eviction neither counts nor
		// removes it.
		if (this.#max_per_scope != null && subscriber.scope !== null) {
			this.#enforce_scope_limit(subscriber.scope, this.#max_per_scope);
		}
		subscriber.stream = stream;
	}

	/**
	 * Close `scope`'s oldest **admitted** subscribers until one more fits under
	 * `max`. Pending registrations are neither counted nor closed — a
	 * subscription that may yet be refused must not cost a live one its slot.
	 */
	#enforce_scope_limit(scope: string, max: number): void {
		// admitted subscribers with this scope, in registration order (the
		// backing Set's insertion order), paired with their streams
		const matching: Array<[SubscriberEntry<T>, SseStream<T>]> = [];
		for (const subscriber of this.#subscribers) {
			if (subscriber.scope === scope && subscriber.stream !== null) {
				matching.push([subscriber, subscriber.stream]);
			}
		}
		// close oldest first, stopping once we've freed up room for one more
		const overflow = matching.length - (max - 1);
		for (let i = 0; i < overflow; i++) {
			const [victim, stream] = matching[i]!;
			stream.close();
			this.#subscribers.delete(victim);
		}
	}
}
