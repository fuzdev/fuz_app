// @vitest-environment jsdom

/**
 * Tests for the `Popover` state class — visibility, attachments, outside click, and ARIA.
 *
 * @module
 */

import {describe, test, assert, vi, beforeEach, afterEach} from 'vitest';

import {Popover} from '$lib/ui/popover.svelte.js';
import type {Position, Alignment} from '$lib/ui/position_helpers.js';

// --- test helpers ---

interface TestElements {
	container: HTMLElement;
	trigger: HTMLElement;
	content: HTMLElement;
}

/** Creates a container with trigger and content children appended to `document.body`. */
const create_test_elements = (): TestElements => {
	const container = document.createElement('div');
	const trigger = document.createElement('button');
	const content = document.createElement('div');
	container.append(trigger, content);
	document.body.appendChild(container);
	return {container, trigger, content};
};

/** Dispatches a click on `document` with the given node as `event.target`. */
const dispatch_outside_click = (target: Node = document.body): void => {
	const event = new Event('click', {bubbles: true, cancelable: true});
	Object.defineProperty(event, 'target', {value: target});
	document.dispatchEvent(event);
};

/** Asserts a single inline style property value. */
const assert_style = (el: HTMLElement, prop: string, expected: string): void => {
	assert.strictEqual(
		el.style.getPropertyValue(prop),
		expected,
		`style '${prop}' should be '${expected}'`,
	);
};

/** Asserts multiple inline style properties. */
const assert_styles = (el: HTMLElement, expected: Record<string, string>): void => {
	for (const [prop, value] of Object.entries(expected)) {
		assert_style(el, prop, value);
	}
};

describe('Popover', () => {
	let els: TestElements;
	let popover: Popover;
	let cleanups: Array<() => void>;

	/** Registers an attachment cleanup for automatic teardown. */
	const attach = (cleanup: (() => void) | void): void => {
		if (cleanup) cleanups.push(cleanup);
	};

	/** Runs and removes the most recently registered cleanup. */
	const detach_last = (): void => {
		cleanups.pop()?.();
	};

	beforeEach(() => {
		els = create_test_elements();
		popover = new Popover();
		cleanups = [];
	});

	afterEach(() => {
		for (const fn of cleanups) fn();
		els.container.remove();
	});

	// --- constructor ---

	describe('constructor', () => {
		test('creates with default values', () => {
			assert.strictEqual(popover.visible, false);
			assert.strictEqual(popover.position, 'bottom');
			assert.strictEqual(popover.align, 'center');
			assert.strictEqual(popover.offset, '0');
			assert.strictEqual(popover.disable_outside_click, false);
			assert.strictEqual(popover.popover_class, '');
		});

		test('accepts custom parameters including callbacks', () => {
			const onshow = vi.fn();
			const onhide = vi.fn();
			popover = new Popover({
				position: 'top',
				align: 'start',
				offset: '16px',
				disable_outside_click: true,
				popover_class: 'custom',
				onshow,
				onhide,
			});

			assert.strictEqual(popover.position, 'top');
			assert.strictEqual(popover.align, 'start');
			assert.strictEqual(popover.offset, '16px');
			assert.strictEqual(popover.disable_outside_click, true);
			assert.strictEqual(popover.popover_class, 'custom');

			// verify callbacks by triggering them
			popover.show();
			assert.strictEqual(onshow.mock.calls.length, 1);
			popover.hide();
			assert.strictEqual(onhide.mock.calls.length, 1);
		});
	});

	// --- visibility ---

	describe('show/hide/toggle', () => {
		test('show sets visible and calls onshow (idempotent)', () => {
			const onshow = vi.fn();
			popover = new Popover({onshow});

			popover.show();
			assert.strictEqual(popover.visible, true);
			assert.strictEqual(onshow.mock.calls.length, 1);

			popover.show(); // no-op
			assert.strictEqual(onshow.mock.calls.length, 1);
		});

		test('hide clears visible and calls onhide (idempotent)', () => {
			const onhide = vi.fn();
			popover = new Popover({onhide});
			popover.show();

			popover.hide();
			assert.strictEqual(popover.visible, false);
			assert.strictEqual(onhide.mock.calls.length, 1);

			popover.hide(); // no-op
			assert.strictEqual(onhide.mock.calls.length, 1);
		});

		test('toggle flips visibility', () => {
			const onshow = vi.fn();
			const onhide = vi.fn();
			popover = new Popover({onshow, onhide});

			popover.toggle();
			assert.strictEqual(popover.visible, true);
			assert.strictEqual(onshow.mock.calls.length, 1);

			popover.toggle();
			assert.strictEqual(popover.visible, false);
			assert.strictEqual(onhide.mock.calls.length, 1);
		});

		test('toggle with explicit boolean forces state', () => {
			popover.toggle(true);
			assert.strictEqual(popover.visible, true);

			popover.toggle(true); // already visible — no-op via show()
			assert.strictEqual(popover.visible, true);

			popover.toggle(false);
			assert.strictEqual(popover.visible, false);

			popover.toggle(false); // already hidden — no-op via hide()
			assert.strictEqual(popover.visible, false);
		});

		test('callbacks fire in order across cycles', () => {
			const events: Array<string> = [];
			popover = new Popover({
				onshow: () => events.push('show'),
				onhide: () => events.push('hide'),
			});

			popover.show();
			popover.hide();
			popover.show();
			popover.hide();

			assert.deepStrictEqual(events, ['show', 'hide', 'show', 'hide']);
		});

		test('does not throw without attached elements', () => {
			assert.doesNotThrow(() => {
				popover.show();
				popover.hide();
				popover.toggle();
			});
		});
	});

	// --- update ---

	describe('update', () => {
		test('replaces all configuration fields', () => {
			popover = new Popover({position: 'left', align: 'end', popover_class: 'old'});
			const onshow = vi.fn();
			const onhide = vi.fn();

			popover.update({
				position: 'right',
				align: 'start',
				offset: '20px',
				disable_outside_click: true,
				popover_class: 'new',
				onshow,
				onhide,
			});

			assert.strictEqual(popover.position, 'right');
			assert.strictEqual(popover.align, 'start');
			assert.strictEqual(popover.offset, '20px');
			assert.strictEqual(popover.disable_outside_click, true);
			assert.strictEqual(popover.popover_class, 'new');

			popover.show();
			assert.strictEqual(onshow.mock.calls.length, 1);
			popover.hide();
			assert.strictEqual(onhide.mock.calls.length, 1);
		});

		test('partial update preserves unspecified fields', () => {
			popover = new Popover({position: 'left', align: 'end', offset: '10px'});
			popover.update({position: 'right'});

			assert.strictEqual(popover.position, 'right');
			assert.strictEqual(popover.align, 'end');
			assert.strictEqual(popover.offset, '10px');
		});

		test('empty update is a no-op', () => {
			popover = new Popover({position: 'top', align: 'start', offset: '5px'});
			popover.update({});

			assert.strictEqual(popover.position, 'top');
			assert.strictEqual(popover.align, 'start');
			assert.strictEqual(popover.offset, '5px');
		});
	});

	// --- trigger attachment ---

	describe('trigger attachment', () => {
		test('click toggles visibility', () => {
			attach(popover.trigger()(els.trigger));

			els.trigger.click();
			assert.strictEqual(popover.visible, true);

			els.trigger.click();
			assert.strictEqual(popover.visible, false);
		});

		test('forwards parameters to popover', () => {
			attach(popover.trigger({position: 'right', align: 'start'})(els.trigger));

			assert.strictEqual(popover.position, 'right');
			assert.strictEqual(popover.align, 'start');
		});

		test('sets aria-expanded reflecting visibility', () => {
			attach(popover.trigger()(els.trigger));
			attach(popover.content()(els.content));

			assert.strictEqual(els.trigger.getAttribute('aria-expanded'), 'false');

			popover.show();
			assert.strictEqual(els.trigger.getAttribute('aria-expanded'), 'true');

			popover.hide();
			assert.strictEqual(els.trigger.getAttribute('aria-expanded'), 'false');
		});
	});

	// --- content attachment ---

	describe('content attachment', () => {
		test('sets position:absolute and z-index:10', () => {
			attach(popover.content()(els.content));

			assert.strictEqual(els.content.style.position, 'absolute');
			assert.strictEqual(els.content.style.zIndex, '10');
		});

		test('applies position styles to the DOM', () => {
			attach(popover.content({position: 'bottom', align: 'start', offset: '15px'})(els.content));

			assert_styles(els.content, {
				top: 'calc(100% + 15px)',
				bottom: 'auto',
				left: '0px',
				right: 'auto',
				'transform-origin': 'top',
			});
		});

		test('adds popover_class and removes on cleanup', () => {
			attach(popover.content({popover_class: 'my-popover'})(els.content));
			assert.ok(els.content.classList.contains('my-popover'));

			detach_last();
			assert.ok(!els.content.classList.contains('my-popover'));
		});

		test('sets role="dialog" by default', () => {
			attach(popover.content()(els.content));
			assert.strictEqual(els.content.getAttribute('role'), 'dialog');
		});

		test('preserves existing role attribute', () => {
			els.content.setAttribute('role', 'menu');
			attach(popover.content()(els.content));
			assert.strictEqual(els.content.getAttribute('role'), 'menu');
		});

		test('z-index applied for every position type', () => {
			const positions: Array<Position> = ['left', 'right', 'top', 'bottom', 'center', 'overlay'];
			for (const position of positions) {
				attach(popover.content({position})(els.content));
				assert.strictEqual(els.content.style.zIndex, '10', `z-index for '${position}'`);
				detach_last();
			}
		});
	});

	// --- container attachment ---

	describe('container attachment', () => {
		test('clicking inside container does not close popover', () => {
			attach(popover.container(els.container));
			attach(popover.trigger()(els.trigger));
			attach(popover.content()(els.content));

			popover.show();
			dispatch_outside_click(els.container);
			assert.strictEqual(popover.visible, true);
		});
	});

	// --- positioning ---

	describe('positioning', () => {
		// generate_position_styles is exhaustively tested in position_helpers.test.ts;
		// these verify the content attachment correctly applies those styles to the DOM

		// jsdom normalizes '0' to '0px' for CSS length properties
		const CARDINAL_CASES: Array<{
			position: Position;
			align: Alignment;
			expected: Record<string, string>;
		}> = [
			// left
			{
				position: 'left',
				align: 'start',
				expected: {
					right: '100%',
					left: 'auto',
					top: '0px',
					bottom: 'auto',
					transform: '',
					'transform-origin': 'right',
				},
			},
			{
				position: 'left',
				align: 'center',
				expected: {
					right: '100%',
					left: 'auto',
					top: '50%',
					bottom: 'auto',
					transform: 'translateY(-50%)',
					'transform-origin': 'right',
				},
			},
			{
				position: 'left',
				align: 'end',
				expected: {
					right: '100%',
					left: 'auto',
					top: 'auto',
					bottom: '0px',
					transform: '',
					'transform-origin': 'right',
				},
			},
			// right
			{
				position: 'right',
				align: 'start',
				expected: {
					left: '100%',
					right: 'auto',
					top: '0px',
					bottom: 'auto',
					transform: '',
					'transform-origin': 'left',
				},
			},
			{
				position: 'right',
				align: 'center',
				expected: {
					left: '100%',
					right: 'auto',
					top: '50%',
					bottom: 'auto',
					transform: 'translateY(-50%)',
					'transform-origin': 'left',
				},
			},
			{
				position: 'right',
				align: 'end',
				expected: {
					left: '100%',
					right: 'auto',
					top: 'auto',
					bottom: '0px',
					transform: '',
					'transform-origin': 'left',
				},
			},
			// top
			{
				position: 'top',
				align: 'start',
				expected: {
					bottom: '100%',
					top: 'auto',
					left: '0px',
					right: 'auto',
					transform: '',
					'transform-origin': 'bottom',
				},
			},
			{
				position: 'top',
				align: 'center',
				expected: {
					bottom: '100%',
					top: 'auto',
					left: '50%',
					right: 'auto',
					transform: 'translateX(-50%)',
					'transform-origin': 'bottom',
				},
			},
			{
				position: 'top',
				align: 'end',
				expected: {
					bottom: '100%',
					top: 'auto',
					left: 'auto',
					right: '0px',
					transform: '',
					'transform-origin': 'bottom',
				},
			},
			// bottom
			{
				position: 'bottom',
				align: 'start',
				expected: {
					top: '100%',
					bottom: 'auto',
					left: '0px',
					right: 'auto',
					transform: '',
					'transform-origin': 'top',
				},
			},
			{
				position: 'bottom',
				align: 'center',
				expected: {
					top: '100%',
					bottom: 'auto',
					left: '50%',
					right: 'auto',
					transform: 'translateX(-50%)',
					'transform-origin': 'top',
				},
			},
			{
				position: 'bottom',
				align: 'end',
				expected: {
					top: '100%',
					bottom: 'auto',
					left: 'auto',
					right: '0px',
					transform: '',
					'transform-origin': 'top',
				},
			},
		];

		test.each(CARDINAL_CASES)(
			'$position/$align applies correct styles',
			({position, align, expected}) => {
				attach(popover.content({position, align})(els.content));
				assert_styles(els.content, expected);
			},
		);

		test('center ignores alignment and offset', () => {
			attach(popover.content({position: 'center', align: 'start', offset: '10px'})(els.content));
			assert_styles(els.content, {
				top: '50%',
				left: '50%',
				transform: 'translate(-50%, -50%)',
				'transform-origin': 'center',
			});
		});

		test('overlay ignores alignment and offset', () => {
			attach(popover.content({position: 'overlay', align: 'end', offset: '10px'})(els.content));
			assert_styles(els.content, {
				top: '0px',
				left: '0px',
				width: '100%',
				height: '100%',
				'transform-origin': 'center',
			});
		});

		test('offset produces calc expression for each cardinal direction', () => {
			const offset_cases: Array<{position: Position; prop: string}> = [
				{position: 'left', prop: 'right'},
				{position: 'right', prop: 'left'},
				{position: 'top', prop: 'bottom'},
				{position: 'bottom', prop: 'top'},
			];
			for (const {position, prop} of offset_cases) {
				attach(popover.content({position, align: 'start', offset: '10px'})(els.content));
				assert_style(els.content, prop, 'calc(100% + 10px)');
				detach_last();
			}
		});

		test('dynamic position update reapplies styles', () => {
			popover = new Popover({position: 'bottom', align: 'center', offset: '0'});
			attach(popover.content()(els.content));
			assert_style(els.content, 'top', '100%');
			assert_style(els.content, 'left', '50%');

			// attachments read at attach time — recreate after update
			detach_last();
			popover.update({position: 'right', align: 'start', offset: '15px'});
			attach(popover.content()(els.content));
			assert_style(els.content, 'left', 'calc(100% + 15px)');
			assert_style(els.content, 'top', '0px');
		});

		test('multiple sequential updates', () => {
			popover = new Popover({position: 'bottom', align: 'center'});
			attach(popover.content()(els.content));
			detach_last();

			popover.update({position: 'top', align: 'end', offset: '5px'});
			attach(popover.content()(els.content));
			assert_style(els.content, 'bottom', 'calc(100% + 5px)');
			assert_style(els.content, 'right', '0px');
			assert_style(els.content, 'top', 'auto');
			assert_style(els.content, 'left', 'auto');
		});
	});

	// --- outside click ---

	describe('outside click', () => {
		test('hides popover when clicking outside', () => {
			const onhide = vi.fn();
			popover = new Popover({onhide});
			attach(popover.trigger()(els.trigger));
			attach(popover.content()(els.content));

			popover.show();
			dispatch_outside_click();

			assert.strictEqual(popover.visible, false);
			assert.strictEqual(onhide.mock.calls.length, 1);
		});

		test('does not hide when disable_outside_click is true', () => {
			const onhide = vi.fn();
			popover = new Popover({disable_outside_click: true, onhide});
			attach(popover.trigger()(els.trigger));
			attach(popover.content()(els.content));

			popover.show();
			dispatch_outside_click();

			assert.strictEqual(popover.visible, true);
			assert.strictEqual(onhide.mock.calls.length, 0);
		});

		test('clicking trigger or content does not dismiss', () => {
			attach(popover.trigger()(els.trigger));
			attach(popover.content()(els.content));
			popover.show();

			dispatch_outside_click(els.content);
			assert.strictEqual(popover.visible, true);

			dispatch_outside_click(els.trigger);
			assert.strictEqual(popover.visible, true);
		});

		test('clicking deeply nested content child does not dismiss', () => {
			attach(popover.trigger()(els.trigger));
			attach(popover.content()(els.content));

			const wrapper = document.createElement('div');
			const nested = document.createElement('em');
			wrapper.appendChild(nested);
			els.content.appendChild(wrapper);

			popover.show();
			dispatch_outside_click(nested);
			assert.strictEqual(popover.visible, true);
		});

		test('toggling disable_outside_click dynamically', () => {
			attach(popover.trigger()(els.trigger));
			attach(popover.content()(els.content));

			// default: outside click dismisses
			popover.show();
			dispatch_outside_click();
			assert.strictEqual(popover.visible, false);

			// disable outside click
			popover.update({disable_outside_click: true});
			popover.show();
			dispatch_outside_click();
			assert.strictEqual(popover.visible, true);

			// re-enable
			popover.update({disable_outside_click: false});
			dispatch_outside_click();
			assert.strictEqual(popover.visible, false);
		});

		test('outside click does not dismiss when content element is missing', () => {
			// only trigger attached — #manage_outside_click registers the handler,
			// but the click guard requires both #content_element and #trigger_element
			attach(popover.trigger()(els.trigger));
			popover.show();

			dispatch_outside_click();
			assert.strictEqual(popover.visible, true);
		});
	});

	// --- ARIA ---

	describe('ARIA', () => {
		test('establishes aria-controls relationship on show', () => {
			attach(popover.trigger()(els.trigger));
			attach(popover.content()(els.content));

			// aria-controls is established when show() calls #update_trigger_aria_attributes
			popover.show();
			assert.ok(els.content.id, 'content should have an id');
			assert.strictEqual(els.trigger.getAttribute('aria-controls'), els.content.id);
			assert.strictEqual(els.content.getAttribute('role'), 'dialog');
		});

		test('aria-expanded tracks visibility', () => {
			attach(popover.trigger()(els.trigger));
			attach(popover.content()(els.content));

			assert.strictEqual(els.trigger.getAttribute('aria-expanded'), 'false');

			popover.show();
			assert.strictEqual(els.trigger.getAttribute('aria-expanded'), 'true');

			popover.hide();
			assert.strictEqual(els.trigger.getAttribute('aria-expanded'), 'false');
		});

		test('aria-controls persists after hide', () => {
			attach(popover.trigger()(els.trigger));
			attach(popover.content()(els.content));

			popover.show();
			const content_id = els.content.id;
			popover.hide();
			assert.strictEqual(els.trigger.getAttribute('aria-controls'), content_id);
		});

		test('content-before-trigger attachment order still establishes ARIA', () => {
			// attach content first, then trigger
			attach(popover.content()(els.content));
			attach(popover.trigger()(els.trigger));

			// trigger attachment calls #update_trigger_aria_attributes, sees content element
			assert.ok(els.content.id, 'content should have an id');
			assert.strictEqual(els.trigger.getAttribute('aria-controls'), els.content.id);
			assert.strictEqual(els.trigger.getAttribute('aria-expanded'), 'false');
		});
	});

	// --- class management ---

	describe('class management', () => {
		test('update swaps popover_class on content element', () => {
			popover = new Popover({popover_class: 'initial'});
			attach(popover.content()(els.content));
			assert.ok(els.content.classList.contains('initial'));

			popover.update({popover_class: 'updated'});
			assert.ok(!els.content.classList.contains('initial'));
			assert.ok(els.content.classList.contains('updated'));
		});

		test('update to empty string removes class', () => {
			popover = new Popover({popover_class: 'to-remove'});
			attach(popover.content()(els.content));

			popover.update({popover_class: ''});
			assert.ok(!els.content.classList.contains('to-remove'));
		});
	});

	// --- cleanup ---

	describe('cleanup', () => {
		test('trigger cleanup removes click handler', () => {
			const trigger_cleanup = popover.trigger()(els.trigger);

			els.trigger.click();
			assert.strictEqual(popover.visible, true);

			trigger_cleanup?.();

			// click no longer toggles
			els.trigger.click();
			assert.strictEqual(popover.visible, true);
		});

		test('content cleanup removes document click listener', () => {
			attach(popover.trigger()(els.trigger));
			const content_cleanup = popover.content()(els.content);

			popover.show();
			content_cleanup?.();

			// outside click no longer hides
			dispatch_outside_click();
			assert.strictEqual(popover.visible, true);
		});
	});

	// --- edge cases ---

	describe('edge cases', () => {
		test('rapid toggle cycles count correctly', () => {
			const onshow = vi.fn();
			const onhide = vi.fn();
			popover = new Popover({onshow, onhide});
			attach(popover.trigger()(els.trigger));

			for (let i = 0; i < 10; i++) {
				els.trigger.click();
			}

			// 10 clicks from hidden = even count → back to hidden
			assert.strictEqual(popover.visible, false);
			assert.strictEqual(onshow.mock.calls.length, 5);
			assert.strictEqual(onhide.mock.calls.length, 5);
		});

		test('DOM sibling manipulation does not break state', () => {
			attach(popover.trigger()(els.trigger));
			attach(popover.content()(els.content));
			popover.show();

			const sibling = document.createElement('div');
			els.container.appendChild(sibling);
			els.container.removeChild(sibling);

			assert.strictEqual(popover.visible, true);
			els.trigger.click();
			assert.strictEqual(popover.visible, false);
		});

		test('element removal does not throw', () => {
			attach(popover.trigger()(els.trigger));
			popover.show();
			els.trigger.remove();
			assert.doesNotThrow(() => popover.hide());
		});

		test('state preserved across attachment recreation', () => {
			popover = new Popover({position: 'top', align: 'start'});
			let cleanup = popover.trigger()(els.trigger);

			els.trigger.click();
			assert.strictEqual(popover.visible, true);

			// recreate attachment (simulates reactive re-mount)
			cleanup?.();
			cleanup = popover.trigger()(els.trigger);
			attach(cleanup);

			assert.strictEqual(popover.visible, true);
			assert.strictEqual(popover.position, 'top');
			assert.strictEqual(popover.align, 'start');
		});

		test('multiple independent popovers', () => {
			const els2 = create_test_elements();
			const popover2 = new Popover();

			attach(popover.trigger()(els.trigger));
			attach(popover.content()(els.content));
			attach(popover2.trigger()(els2.trigger));
			attach(popover2.content()(els2.content));

			popover.show();
			assert.strictEqual(popover.visible, true);
			assert.strictEqual(popover2.visible, false);

			popover2.show();
			assert.strictEqual(popover.visible, true);
			assert.strictEqual(popover2.visible, true);

			popover.hide();
			assert.strictEqual(popover.visible, false);
			assert.strictEqual(popover2.visible, true);

			els2.container.remove();
		});
	});
});
