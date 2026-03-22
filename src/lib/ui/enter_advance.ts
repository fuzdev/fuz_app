/**
 * Svelte action that makes Enter advance to the next focusable form element
 * (inputs and buttons), or activate the element if it's already the last one.
 *
 * @example
 * ```svelte
 * <form {@attach enter_advance()}>
 * ```
 *
 * @module
 */

const FOCUSABLE_SELECTOR = 'input:not(:disabled), button:not(:disabled)';

export const enter_advance = (): ((form: HTMLFormElement) => () => void) => {
	return (form: HTMLFormElement) => {
		const handle_keydown = (e: KeyboardEvent): void => {
			if (e.key !== 'Enter') return;
			if (!(e.target instanceof HTMLInputElement)) return;

			const elements = Array.from(form.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
			const index = elements.indexOf(e.target);
			if (index < 0) return;

			e.preventDefault();
			elements[(index + 1) % elements.length]!.focus();
		};

		form.addEventListener('keydown', handle_keydown);
		return () => form.removeEventListener('keydown', handle_keydown);
	};
};
