/**
 * Composable async-operation slot for Svelte 5 reactive state classes.
 *
 * A state class HOLDS one or more `AsyncSlot`s via composition — one slot
 * per distinct async operation (e.g. `list` + `create` + `revoke`). Each
 * slot tracks the status, payload, and error of its operation
 * independently, so state classes with multiple write paths don't accumulate
 * ad-hoc `creating` / `updating` fields beside a single shared
 * `loading` / `error` pair.
 *
 * Core surface:
 *
 * - **Explicit four-value `status`** — `AsyncStatus` from
 *   `@fuzdev/fuz_util/async.ts`: `'initial' | 'pending' | 'success' |
 *   'failure'`. `loading: false, error: null` would be ambiguous
 *   between "never tried" and "succeeded once and now resting"; the
 *   four-value status removes the need for a per-class `submitted` /
 *   `hydrated` flag.
 * - **Owns `data: T | undefined`** — the success payload persists
 *   across retries (stale-while-revalidate). The sentinel is
 *   `undefined` (not `null`) so `null` stays available as a legitimate
 *   success value for nullable `T`s. Pass `T = void` for write-only
 *   actions whose response isn't worth keeping.
 * - **Supersession via internal `AbortController`** — a second `run()`
 *   aborts the first, and superseded results are silently discarded
 *   without writing to state. Removes the "in-flight call resolves
 *   after the locator advanced" race that locator-style state classes
 *   would otherwise need to compensate for.
 * - **`AbortSignal` threaded to the callback** — RPC clients that accept
 *   a signal (or `fetch`) get cancellation for free; callers can also
 *   pass an external `signal` via {@link RunOptions} to bind the slot's
 *   lifetime to a component / page.
 * - **`preserve_error_on_retry`** — opt-in to keeping the previous error
 *   visible while a retry is pending (default clears at the start of
 *   each `run()`).
 * - **Per-slot `map_error`** — set once in the constructor
 *   (`{map_error: to_rpc_error_message}`); every `run()` gets the right
 *   normalization without re-passing per call.
 * - **Public `run()`** — slots are composed, not subclassed, so call
 *   sites can invoke `state.list.run(...)` directly.
 *
 * @example
 * ```ts
 * class CellsState {
 *   readonly list = new AsyncSlot<{cells: ReadonlyArray<CellJson>}>();
 *   readonly create = new AsyncSlot<{cell: CellJson}>({map_error: to_rpc_error_message});
 *
 *   async fetch() {
 *     await this.list.run((signal) => this.#api.cell_list({}, {signal}));
 *   }
 *
 *   async submit_new(input: CellCreateInput) {
 *     const result = await this.create.run(() => this.#api.cell_create(input));
 *     if (result) await this.fetch();
 *   }
 * }
 * ```
 *
 * @module
 */

import type { AsyncStatus } from '@fuzdev/fuz_util/async.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

export interface AsyncSlotOptions<T, E = string> {
	/**
	 * Seed `data` and put the slot in `'success'` before any `run()`. Useful
	 * when the page already has the resource in hand (SSR hydration, a
	 * mutation response, hand-off from a parent slot).
	 */
	initial?: T;
	/**
	 * Convert a caught throw into the error value stored in
	 * {@link AsyncSlot.error}. Default extracts `Error.message` (falling
	 * back to `'Request failed'` for non-Error throws). Pass
	 * `to_rpc_error_message` to unwrap JSON-RPC `data.reason` codes.
	 */
	map_error?: (e: unknown) => E;
	/**
	 * When `true`, the previous `error` / `error_data` survive the start
	 * of a new `run()` until the next success (or another failure
	 * overwrites them). Useful for retry UX that wants to keep the
	 * failure message visible alongside an inline spinner. Default `false`
	 * — `run()` clears the error at the start so the pending state reads
	 * "no current error."
	 */
	preserve_error_on_retry?: boolean;
}

export interface RunOptions {
	/**
	 * External signal chained into the slot's internal controller. Aborts
	 * the in-flight run when fired (alongside automatic supersession by
	 * the next `run()` and manual {@link AsyncSlot.abort} calls).
	 */
	signal?: AbortSignal;
}

/**
 * Reactive container for a single async operation.
 *
 * @typeParam T - The success payload type. Use `void` for write-only
 *   actions whose response isn't worth retaining.
 * @typeParam E - The shape of {@link AsyncSlot.error}. Defaults to
 *   `string` (set by the default `map_error`). Narrow to a structured
 *   type by providing a `map_error` that returns it.
 */
export class AsyncSlot<T = void, E = string> {
	status: AsyncStatus = $state.raw('initial');
	data: T | undefined = $state.raw<T | undefined>(undefined);
	error: E | null = $state.raw(null);
	/** The raw caught value from the last failed `run()`, for programmatic inspection. */
	error_data: unknown = $state.raw(null);

	/** Convenience derived: `status === 'initial'`. */
	readonly initial: boolean = $derived(this.status === 'initial');
	/** Convenience derived: `status === 'pending'`. */
	readonly loading: boolean = $derived(this.status === 'pending');
	/** Convenience derived: `status === 'success'`. */
	readonly succeeded: boolean = $derived(this.status === 'success');
	/** Convenience derived: `status === 'failure'`. */
	readonly failed: boolean = $derived(this.status === 'failure');

	#controller: AbortController | null = null;
	/**
	 * Tracks whether any `run()` or `set()` has ever produced a success
	 * result. Used by {@link abort} to revert to `'success'` (vs `'initial'`)
	 * — explicit flag instead of inspecting `data` so the discriminator
	 * stays correct for `T = void` (where success-`data` is `undefined`)
	 * and for nullable `T`s where `null` is a legitimate success value.
	 */
	#has_succeeded: boolean = false;
	readonly #map_error: (e: unknown) => E;
	readonly #preserve_error: boolean;

	constructor(options: AsyncSlotOptions<T, E> = {}) {
		if (options.initial !== undefined) {
			this.data = options.initial;
			this.status = 'success';
			this.#has_succeeded = true;
		}
		this.#map_error = options.map_error ?? (default_map_error as (e: unknown) => E);
		this.#preserve_error = options.preserve_error_on_retry ?? false;
	}

	/**
	 * Run an async operation. The callback receives an `AbortSignal` it
	 * can forward to fetch / RPC clients that support cancellation; the
	 * slot also discards superseded results internally even if the
	 * callback ignores the signal.
	 *
	 * Supersession rule: a second `run()` aborts the first's signal AND
	 * silently drops its commit if it resolves anyway. So
	 * back-to-back-to-back `run()` calls leave only the last call's
	 * result in `data`.
	 *
	 * Abort rule: a `run()` that throws because of its own signal (manual
	 * `abort()`, external `options.signal`, OR supersession by another
	 * `run()`) does NOT promote to `'failure'`. Manual / external aborts
	 * revert status to the previous resolved state (`'initial'` if no
	 * `run()` has ever succeeded, `'success'` otherwise). Supersession is
	 * handled by the bail-on-mismatch check, leaving the second run's
	 * `'pending'` standing.
	 *
	 * @returns the resolved value on success; `undefined` on failure,
	 *   abort, or supersession
	 */
	async run(
		fn: (signal: AbortSignal) => Promise<T>,
		options: RunOptions = {}
	): Promise<T | undefined> {
		this.#controller?.abort();
		const controller = new AbortController();
		this.#controller = controller;
		const external = options.signal;
		let external_handler: (() => void) | undefined;
		if (external) {
			if (external.aborted) {
				this.abort(external.reason);
				return undefined;
			}
			// Route external abort through the slot's own abort() so the
			// controller-null + status-revert + signal-fire happens
			// atomically (same path as manual abort). Listener is
			// removed in the finally so successful / failing runs don't
			// leak listeners on long-lived external signals.
			external_handler = () => {
				if (this.#controller === controller) this.abort(external.reason);
			};
			external.addEventListener('abort', external_handler, { once: true });
		}

		this.status = 'pending';
		if (!this.#preserve_error) {
			this.error = null;
			this.error_data = null;
		}

		try {
			const result = await fn(controller.signal);
			// Bail if this run was superseded or manually aborted —
			// `abort()` nulls `#controller`, so the mismatch fires in
			// both cases. A callback that ignored its signal and
			// resolved anyway has its result dropped silently.
			if (this.#controller !== controller) return undefined;
			this.data = result;
			this.error = null;
			this.error_data = null;
			this.status = 'success';
			this.#has_succeeded = true;
			return result;
		} catch (e) {
			if (this.#controller !== controller) return undefined;
			this.error = this.#map_error(e);
			this.error_data = e;
			this.status = 'failure';
			return undefined;
		} finally {
			if (external_handler) external?.removeEventListener('abort', external_handler);
			if (this.#controller === controller) this.#controller = null;
		}
	}

	/**
	 * Abort the in-flight run (if any) and null out the controller field.
	 * Shared by {@link abort}, {@link set}, and {@link reset}.
	 */
	#clear_controller(reason?: unknown): void {
		this.#controller?.abort(reason);
		this.#controller = null;
	}

	/**
	 * Manually abort the in-flight run, if any. Reverts `status`
	 * synchronously to the prior resolved state — `'initial'` if no
	 * `run()` (or `set()`) has ever succeeded on this slot, `'success'`
	 * otherwise. The aborted run's eventual resolution / rejection is
	 * dropped without writing to state (the run's `Promise` resolves to
	 * `undefined`).
	 */
	abort(reason?: unknown): void {
		if (!this.#controller) return;
		this.#clear_controller(reason);
		this.status = this.#has_succeeded ? 'success' : 'initial';
	}

	/**
	 * Replace `data` directly and mark the slot `'success'`. For
	 * post-mutation hydration where the calling RPC already returned the
	 * canonical row (parallels `CellState.set_cell`).
	 *
	 * Aborts any in-flight `run()` first — without this, the in-flight
	 * callback could resolve after `set()` and overwrite the explicit
	 * value (the bail-on-mismatch check only fires when `#controller`
	 * was rotated).
	 *
	 * @mutates `this`
	 */
	set(data: T): void {
		this.#clear_controller();
		this.data = data;
		this.status = 'success';
		this.#has_succeeded = true;
		this.error = null;
		this.error_data = null;
	}

	/**
	 * Reset to `'initial'`, clear `data` / `error` / `error_data`, and
	 * abort any in-flight run. After `reset()` the slot looks like a
	 * fresh instance with no `initial` option.
	 *
	 * @mutates `this`
	 */
	reset(): void {
		this.#clear_controller();
		this.status = 'initial';
		this.data = undefined;
		this.error = null;
		this.error_data = null;
		this.#has_succeeded = false;
	}
}

const default_map_error = (e: unknown): string => to_error_message(e, 'Request failed');
