/**
 * Reactive form state for controlling when field errors appear and focusing invalid fields.
 *
 * Tracks per-field `touched` state (set on blur via delegated `focusout`) and form-level
 * `attempted` state (set on submit attempt). Errors show after a field is blurred or
 * after a submit attempt, avoiding premature validation while the user is still typing.
 *
 * The {@link FormState.form | form} attachment also handles Enter key advancing
 * between focusable elements.
 *
 * All trackable inputs must have a `name` attribute — an error is thrown in dev
 * if an input without `name` loses focus.
 *
 * @example
 * ```svelte
 * <script>
 *   const form_state = new FormState();
 *   let username = $state('');
 *   const username_valid = $derived(Username.safeParse(username).success);
 *   const can_submit = $derived(username.trim() && username_valid);
 *
 *   const handle_submit = async () => {
 *     form_state.attempt();
 *     if (!can_submit) {
 *       if (!username.trim() || !username_valid) form_state.focus('username');
 *       return;
 *     }
 *     // submit...
 *   };
 * </script>
 *
 * <form {@attach form_state.form()} onsubmit={(e) => { e.preventDefault(); void handle_submit(); }}>
 *   <input name="username" bind:value={username} />
 *   {#if form_state.show('username') && username && !username_valid}
 *     <p>error message</p>
 *   {/if}
 *   <PendingButton onclick={handle_submit}>submit</PendingButton>
 * </form>
 * ```
 *
 * @module
 */

import type {Attachment} from 'svelte/attachments';
import {DEV} from 'esm-env';
import {on} from 'svelte/events';
import {SvelteSet} from 'svelte/reactivity';

const FOCUSABLE_SELECTOR = 'input:not(:disabled), button:not(:disabled)';

const FORM_INPUT_SELECTOR = 'input, textarea, select';

export class FormState {
	readonly #touched: SvelteSet<string> = new SvelteSet();
	#form: HTMLFormElement | null = null;
	#attempted = $state(false);

	/**
	 * Whether a submit attempt has been made.
	 */
	get attempted(): boolean {
		return this.#attempted;
	}

	/**
	 * Creates a form attachment that handles Enter key advancing between
	 * focusable elements and tracks field touched state via delegated `focusout`.
	 *
	 * Fields are identified by their `name` attribute.
	 */
	form(): Attachment<HTMLFormElement> {
		if (DEV && this.#form) {
			throw new Error('FormState: form() called while already attached to a form.');
		}
		return (form) => {
			this.#form = form;
			const keydown_cleanup = on(form, 'keydown', (e) => {
				if (e.key !== 'Enter') return;
				if (!(e.target instanceof HTMLInputElement)) return;

				const elements = Array.from(form.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
				const index = elements.indexOf(e.target);
				if (index < 0) return;

				e.preventDefault();
				elements[(index + 1) % elements.length]!.focus();
			});
			const focusout_cleanup = on(form, 'focusout', (e) => {
				const target = e.target;
				if (target instanceof HTMLElement && target.matches(FORM_INPUT_SELECTOR)) {
					const name = (target as HTMLInputElement).name;
					if (DEV && !name) {
						throw new Error(
							'FormState: input missing name attribute. All inputs in a FormState form must have a name.',
						);
					}
					if (name) {
						this.#touched.add(name);
					}
				}
			});
			return () => {
				keydown_cleanup();
				focusout_cleanup();
				this.#form = null;
			};
		};
	}

	/**
	 * Whether a field has been blurred at least once.
	 */
	is_touched(field: string): boolean {
		return this.#touched.has(field);
	}

	/**
	 * Whether to show validation errors for a field.
	 * Returns `true` if the field has been blurred or a submit attempt was made.
	 */
	show(field: string): boolean {
		return this.#touched.has(field) || this.#attempted;
	}

	/**
	 * Programmatically marks a field as touched without requiring a blur event.
	 */
	touch(field: string): void {
		this.#touched.add(field);
	}

	/**
	 * Focuses the named input within the form.
	 */
	focus(field: string): void {
		if (DEV && !this.#form) {
			console.warn('FormState: focus() called before form() attachment is active.');
			return;
		}
		const el = this.#form?.querySelector<HTMLElement>(`[name="${field}"]`);
		if (DEV && !el) {
			console.warn(
				`FormState: no element found with name="${field}". Check for typos in the name attribute or form_state.focus() call.`,
			);
			return;
		}
		el?.focus({focusVisible: true} as FocusOptions);
	}

	/**
	 * Marks the form as having been submitted, causing all field errors to show.
	 */
	attempt(): void {
		this.#attempted = true;
	}

	/**
	 * Resets all touched and attempted state.
	 */
	reset(): void {
		this.#touched.clear();
		this.#attempted = false;
	}
}
