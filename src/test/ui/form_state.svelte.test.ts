// @vitest-environment jsdom

/**
 * Tests for `FormState` — the Enter-key handling of its form attachment.
 *
 * @module
 */

import { describe, test, assert, afterEach } from 'vitest';

import { FormState } from '$lib/ui/form_state.svelte.ts';

interface LoginFormElements {
	form: HTMLFormElement;
	username: HTMLInputElement;
	password: HTMLInputElement;
	button: HTMLButtonElement;
	submits: () => number;
	detach: () => void;
}

/** A login-shaped form: two inputs then a `type="button"` button, like `PendingButton`. */
const create_login_form = (): LoginFormElements => {
	const form = document.createElement('form');
	const username = document.createElement('input');
	username.name = 'username';
	const password = document.createElement('input');
	password.name = 'password';
	password.type = 'password';
	const button = document.createElement('button');
	button.type = 'button';
	form.append(username, password, button);
	document.body.append(form);
	let submit_count = 0;
	form.addEventListener('submit', (e) => {
		e.preventDefault();
		submit_count++;
	});
	const cleanup = new FormState().form()(form);
	return {
		form,
		username,
		password,
		button,
		submits: () => submit_count,
		detach: () => {
			if (typeof cleanup === 'function') cleanup();
		}
	};
};

const press_enter = (target: HTMLElement): KeyboardEvent => {
	const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
	target.dispatchEvent(event);
	return event;
};

afterEach(() => {
	document.body.innerHTML = '';
});

describe('FormState form attachment — Enter', () => {
	test('Enter in an input followed by another input moves focus to it', () => {
		const { username, password, submits, detach } = create_login_form();
		username.focus();
		const event = press_enter(username);
		assert.ok(event.defaultPrevented);
		assert.strictEqual(document.activeElement, password);
		assert.strictEqual(submits(), 0);
		detach();
	});

	test('Enter in the last input submits the form instead of focusing the button', () => {
		const { password, button, submits, detach } = create_login_form();
		password.focus();
		const event = press_enter(password);
		assert.ok(event.defaultPrevented);
		assert.strictEqual(submits(), 1, 'one Enter submits');
		assert.notStrictEqual(document.activeElement, button);
		detach();
	});

	test('a disabled later input does not count as following', () => {
		const { username, password, submits, detach } = create_login_form();
		password.disabled = true;
		username.focus();
		press_enter(username);
		assert.strictEqual(submits(), 1);
		detach();
	});

	test('a hidden input after the last visible one does not count as following', () => {
		const { form, password, submits, detach } = create_login_form();
		const hidden = document.createElement('input');
		hidden.type = 'hidden';
		hidden.name = 'csrf';
		form.insertBefore(hidden, form.querySelector('button'));
		password.focus();
		press_enter(password);
		assert.strictEqual(submits(), 1);
		detach();
	});

	test('Enter while an IME is composing is left alone', () => {
		const { username, password, submits, detach } = create_login_form();
		for (const input of [username, password]) {
			input.focus();
			const event = new KeyboardEvent('keydown', {
				key: 'Enter',
				bubbles: true,
				cancelable: true,
				isComposing: true
			});
			input.dispatchEvent(event);
			assert.ok(!event.defaultPrevented, input.name);
			assert.strictEqual(document.activeElement, input, `${input.name} keeps focus`);
		}
		assert.strictEqual(submits(), 0);
		detach();
	});

	test('Enter on a button is left alone', () => {
		const { button, submits, detach } = create_login_form();
		button.focus();
		const event = press_enter(button);
		assert.ok(!event.defaultPrevented);
		assert.strictEqual(submits(), 0);
		detach();
	});

	test('detaching removes the handler', () => {
		const { password, submits, detach } = create_login_form();
		detach();
		press_enter(password);
		assert.strictEqual(submits(), 0);
	});
});
