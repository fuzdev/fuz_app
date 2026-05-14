/**
 * Keyed sibling of `AsyncSlot` — fans the per-instance supersession
 * machinery out across an open set of keys.
 *
 * Each key gets its own lazily-created `AsyncSlot`, so concurrent
 * `run(key_a, ...)` and `run(key_b, ...)` calls are independent: a
 * second `run()` on `key_a` aborts only `key_a`'s in-flight call,
 * leaving `key_b` running. The keyed shape replaces the
 * `AsyncSlot` + `SvelteSet<id>` pair that state classes previously
 * carried for per-row in-flight tracking, with two genuine wins:
 *
 * - **Cross-key supersession is correct** — clicking row B while row
 *   A is in flight no longer aborts A; each row has its own
 *   AbortController.
 * - **Per-key error surfacing** — `error(key)` carries the failure
 *   for that key only, instead of the last-error-wins shape of a
 *   shared slot.
 *
 * The backing `SvelteMap` keeps entries even after a `run()` resolves
 * — components can read `error(key)` to render an inline per-row
 * failure indicator. Call `delete(key)` to dismiss an entry, or
 * `reset()` to clear everything (e.g. on page leave).
 *
 * @example
 * ```ts
 * class AdminInvitesState {
 *   readonly remove = new KeyedAsyncSlot<Uuid>();
 *
 *   async submit_delete(id: Uuid): Promise<void> {
 *     const ok = await this.remove.run(id, () => this.#rpc().delete({invite_id: id}));
 *     if (ok !== undefined) await this.fetch();
 *   }
 * }
 *
 * // In a template:
 * //   <button disabled={state.remove.loading(row.id)}>
 * //     {state.remove.loading(row.id) ? 'deleting…' : 'delete'}
 * //   </button>
 * //   {#if state.remove.error(row.id)}<p>{state.remove.error(row.id)}</p>{/if}
 * ```
 *
 * @module
 */

import {SvelteMap} from 'svelte/reactivity';

import {AsyncSlot, type AsyncSlotOptions, type RunOptions} from './async_slot.svelte.js';

/**
 * Constructor options for `KeyedAsyncSlot`. Propagated to every child
 * `AsyncSlot` at lazy creation time.
 *
 * `initial` from {@link AsyncSlotOptions} is deliberately omitted —
 * keyed slots have no per-key seed concept (the entries don't exist
 * until `run()` creates them).
 */
export type KeyedAsyncSlotOptions<T, E = string> = Omit<AsyncSlotOptions<T, E>, 'initial'>;

/**
 * Reactive container for many concurrent async operations keyed by `K`.
 *
 * @typeParam K - The key type. Map identity is SameValueZero — branded
 *   strings (`Uuid`) work directly. For composite keys, stringify at
 *   the call site (e.g. `` `${account_id}:${role}` ``).
 * @typeParam T - The success payload type. Use `void` for write-only
 *   actions whose response isn't worth retaining.
 * @typeParam E - The shape of per-key `error(key)`. Defaults to
 *   `string` (set by the default `map_error`).
 */
export class KeyedAsyncSlot<K, T = void, E = string> {
	readonly #slots: SvelteMap<K, AsyncSlot<T, E>> = new SvelteMap();
	readonly #options: KeyedAsyncSlotOptions<T, E>;

	constructor(options: KeyedAsyncSlotOptions<T, E> = {}) {
		this.#options = options;
	}

	/** Total number of keys with state (pending OR resolved). Reactive. */
	get size(): number {
		return this.#slots.size;
	}

	/** Reactive — true once `run(key, ...)` has been called and the entry hasn't been deleted. */
	has(key: K): boolean {
		return this.#slots.has(key);
	}

	/**
	 * Direct access to the underlying `AsyncSlot` for `key`, or
	 * `undefined` if no `run()` has been issued for it yet. Reactive on
	 * map population and on the slot's `$state.raw` fields.
	 *
	 * Prefer the sugar getters ({@link loading}, {@link error}) for
	 * templates; reach for `get(key)` when you need `error_data`, `data`,
	 * or to call `abort()` / `set()` / `reset()` on the underlying slot.
	 */
	get(key: K): AsyncSlot<T, E> | undefined {
		return this.#slots.get(key);
	}

	/** Reactive — `false` for keys that have never been used. */
	loading(key: K): boolean {
		return this.#slots.get(key)?.loading ?? false;
	}

	/** Reactive — `null` when the key has no entry or hasn't failed. */
	error(key: K): E | null {
		return this.#slots.get(key)?.error ?? null;
	}

	/** Reactive — `false` for keys that have never been used. */
	failed(key: K): boolean {
		return this.#slots.get(key)?.failed ?? false;
	}

	/** Reactive — `false` for keys that have never been used. */
	succeeded(key: K): boolean {
		return this.#slots.get(key)?.succeeded ?? false;
	}

	/** Reactive iterator over every key with state. */
	keys(): IterableIterator<K> {
		return this.#slots.keys();
	}

	/** Reactive iterator over every slot. */
	values(): IterableIterator<AsyncSlot<T, E>> {
		return this.#slots.values();
	}

	/** Reactive iterator over `[key, slot]` pairs. */
	entries(): IterableIterator<[K, AsyncSlot<T, E>]> {
		return this.#slots.entries();
	}

	/**
	 * Run an async operation for `key`. Lazily creates an `AsyncSlot`
	 * for the key on first use, inheriting the constructor's
	 * `map_error` / `preserve_error_on_retry` options.
	 *
	 * Supersession is scoped to `key`: a second `run(key, ...)` aborts
	 * the first's signal AND drops its commit. Calls on different keys
	 * are fully independent (each has its own `AbortController`).
	 *
	 * @returns the resolved value on success; `undefined` on failure,
	 *   abort, or supersession.
	 */
	async run(
		key: K,
		fn: (signal: AbortSignal) => Promise<T>,
		options?: RunOptions,
	): Promise<T | undefined> {
		let slot = this.#slots.get(key);
		if (!slot) {
			slot = new AsyncSlot<T, E>(this.#options);
			this.#slots.set(key, slot);
		}
		return slot.run(fn, options);
	}

	/**
	 * Abort the in-flight run for `key`, if any. No-op when the key has
	 * no entry. The slot stays in the map at its prior resolved status —
	 * call {@link delete} to remove the entry entirely.
	 */
	abort(key: K, reason?: unknown): void {
		this.#slots.get(key)?.abort(reason);
	}

	/**
	 * Abort every in-flight run. Resolved entries stay in the map —
	 * call {@link reset} to clear them too.
	 */
	abort_all(reason?: unknown): void {
		for (const slot of this.#slots.values()) {
			slot.abort(reason);
		}
	}

	/**
	 * Abort the in-flight run for `key` (if any) and remove the entry
	 * from the map. After `delete(key)`, `has(key)` returns `false` and
	 * the sugar getters report the no-entry defaults — typically how a
	 * UI dismisses a per-row error indicator.
	 *
	 * @returns `true` if the key had an entry.
	 *
	 * @mutates `this`
	 */
	delete(key: K): boolean {
		const slot = this.#slots.get(key);
		if (!slot) return false;
		slot.abort();
		return this.#slots.delete(key);
	}

	/**
	 * Abort every in-flight run and clear the map. The keyed slot looks
	 * like a fresh instance afterwards.
	 *
	 * @mutates `this`
	 */
	reset(): void {
		for (const slot of this.#slots.values()) {
			slot.abort();
		}
		this.#slots.clear();
	}
}
