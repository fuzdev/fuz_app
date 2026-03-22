/**
 * Base reactive state class with loading/error management.
 *
 * Provides the common loading/error pattern shared by all state classes.
 * Subclasses add domain-specific `$state` fields and methods that call
 * the protected `run` helper for async operations.
 *
 * @example
 * ```ts
 * class ItemsState extends Loadable {
 * 	items: Array<Item> = $state([]);
 *
 * 	async fetch(): Promise<void> {
 * 		await this.run(async () => {
 * 			const response = await fetch('/api/items');
 * 			if (!response.ok) throw new Error('failed to fetch');
 * 			this.items = await response.json();
 * 		});
 * 	}
 * }
 * ```
 *
 * @example
 * ```ts
 * // structured errors via map_error
 * class FormState extends Loadable<{field: string; message: string}> {
 * 	async submit(data: FormData): Promise<void> {
 * 		await this.run(
 * 			() => post_form(data),
 * 			(e) => ({field: 'form', message: e instanceof Error ? e.message : 'unknown'}),
 * 		);
 * 	}
 * }
 * ```
 *
 * @module
 */

export class Loadable<TError = string> {
	loading = $state(false);
	error: TError | null = $state(null);

	/** The raw caught value from the last failed `run()`, for programmatic inspection. */
	error_data: unknown = $state(null);

	/**
	 * Run an async operation with loading/error handling.
	 *
	 * Sets `loading` to `true`, clears `error` and `error_data`, runs `fn`, catches errors.
	 * Pass `map_error` to produce structured errors instead of strings.
	 *
	 * @returns the result or `undefined` if the operation failed
	 */
	protected async run<T>(
		fn: () => Promise<T>,
		map_error?: (e: unknown) => TError,
	): Promise<T | undefined> {
		this.loading = true;
		this.error = null;
		this.error_data = null;
		try {
			return await fn();
		} catch (e) {
			this.error = map_error
				? map_error(e)
				: ((e instanceof Error ? e.message : 'Request failed') as TError);
			this.error_data = e;
			return undefined;
		} finally {
			this.loading = false;
		}
	}

	/** Reset loading and error state. Subclasses override to clear data. */
	reset(): void {
		this.loading = false;
		this.error = null;
		this.error_data = null;
	}
}
