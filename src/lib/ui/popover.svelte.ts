/**
 * Popover state class with trigger, content, and container attachments.
 *
 * `Popover` manages visibility, positioning, outside-click dismissal,
 * and ARIA attributes. The `trigger`, `content`, and `container`
 * attachments wire up the DOM via Svelte's `{@attach}` directive.
 *
 * For the common button + popover pattern, see `PopoverButton`.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 * 	import {Popover} from '@fuzdev/fuz_app/ui/popover.svelte.js';
 *
 * 	const popover = new Popover();
 * </script>
 *
 * <div class="position:relative" {@attach popover.container}>
 * 	<button type="button" {@attach popover.trigger({position: 'bottom', align: 'center'})}>
 * 		toggle
 * 	</button>
 * 	{#if popover.visible}
 * 		<div {@attach popover.content({position: 'bottom', align: 'center'})}>
 * 			<button type="button" onclick={() => popover.hide()}>close</button>
 * 		</div>
 * 	{/if}
 * </div>
 * ```
 *
 * @example
 * ```ts
 * // programmatic control with callbacks
 * const popover = new Popover({
 * 	position: 'right',
 * 	align: 'start',
 * 	offset: '8px',
 * 	disable_outside_click: true,
 * 	onshow: () => console.log('opened'),
 * 	onhide: () => console.log('closed'),
 * });
 *
 * popover.show();
 * popover.toggle();
 * popover.hide();
 * ```
 *
 * @module
 */

import type {Attachment} from 'svelte/attachments';
import type {Snippet} from 'svelte';
import {on} from 'svelte/events';
import {swallow} from '@fuzdev/fuz_util/dom.js';
import type {TransitionConfig} from 'svelte/transition';

import {type Position, type Alignment, generate_position_styles} from './position_helpers.js';

const create_client_id = (): string => Math.random().toString(36).substring(2);

// TODO refactor to use the builtin Popover API, but needs to use absolute positioning still because the anchor API isn't supported enough yet
// https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/popover
// https://developer.mozilla.org/en-US/docs/Web/API/Popover_API
// https://caniuse.com/css-anchor-positioning

/**
 * Parameters for configuring the popover.
 */
export interface PopoverParameters {
	/** Position of the popover relative to its trigger. */
	position?: Position;
	/** Alignment along the position edge. */
	align?: Alignment;
	/** Distance from the position. */
	offset?: string;
	/** Whether to disable closing when clicking outside. */
	disable_outside_click?: boolean;
	/** Custom class for the popover content. */
	popover_class?: string;
	/** Optional callback when popover is shown. */
	onshow?: () => void;
	/** Optional callback when popover is hidden. */
	onhide?: () => void;
}

/**
 * Parameters for the popover trigger action.
 */
export interface PopoverTriggerParameters extends PopoverParameters {
	/** Content to render in the popover (as a snippet). */
	content?: Snippet;
}

/**
 * Support both Svelte transitions and custom transitions.
 */
export type TransitionFunction = (node: HTMLElement) => TransitionConfig | {destroy?: () => void};

/**
 * Parameters for the popover content action.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PopoverContentParameters extends PopoverParameters {
	// Container reference is managed internally through the container action
}

/**
 * Class that manages state and provides actions for popovers.
 */
export class Popover {
	/** Whether the popover is currently visible. */
	visible = $state(false);

	/** Position of the popover relative to its trigger. */
	position: Position = $state('bottom');

	/** Alignment along the position edge. */
	align: Alignment = $state('center');

	/** Distance from the position. */
	offset = $state('0');

	/** Whether to disable closing when clicking outside. */
	disable_outside_click = $state(false);

	/** Custom class for the popover. */
	popover_class = $state('');

	/** Reference to the trigger element. */
	#trigger_element: HTMLElement | null = null;

	/** Reference to the content element. */
	#content_element: HTMLElement | null = null;

	/** Reference to the container element. */
	#container_element: HTMLElement | null = null;

	/** Onshow callback. */
	#onshow: (() => void) | undefined = undefined;

	/** Onhide callback. */
	#onhide: (() => void) | undefined = undefined;

	/** Cleanup function for document click handler. */
	#document_click_cleanup: (() => void) | undefined = undefined;

	constructor(params?: PopoverParameters) {
		if (params) {
			this.update(params);
		}
	}

	/**
	 * Sets up or removes the document click handler based on current state.
	 */
	#manage_outside_click(): void {
		// If we should have an outside click handler but don't, add one
		if (this.visible && !this.disable_outside_click && !this.#document_click_cleanup) {
			this.#document_click_cleanup = on(document, 'click', (event) => {
				const target = event.target as Node;

				if (
					this.#content_element &&
					this.#trigger_element &&
					!this.#content_element.contains(target) &&
					!this.#trigger_element.contains(target) &&
					(!this.#container_element || !this.#container_element.contains(target))
				) {
					this.hide();
				}
			});
		}
		// If we shouldn't have an outside click handler but do, remove it
		else if ((!this.visible || this.disable_outside_click) && this.#document_click_cleanup) {
			this.#document_click_cleanup();
			this.#document_click_cleanup = undefined;
		}
	}

	/**
	 * Updates the popover configuration.
	 */
	update(params: PopoverParameters): void {
		// Store the old class before updating
		const old_class = this.popover_class;
		const old_disable_outside_click = this.disable_outside_click;

		// Update properties
		if (params.position !== undefined) this.position = params.position;
		if (params.align !== undefined) this.align = params.align;
		if (params.offset !== undefined) this.offset = params.offset;
		if (params.popover_class !== undefined) this.popover_class = params.popover_class;
		if (params.disable_outside_click !== undefined)
			this.disable_outside_click = params.disable_outside_click;

		// Update classes on content element if it exists and class changed
		if (
			this.#content_element &&
			params.popover_class !== undefined &&
			old_class !== params.popover_class
		) {
			// Remove old class if it exists
			if (old_class) {
				this.#content_element.classList.remove(old_class);
			}

			// Add new class if it exists
			if (this.popover_class) {
				this.#content_element.classList.add(this.popover_class);
			}
		}

		// Update outside click handler if disable_outside_click changed
		if (
			params.disable_outside_click !== undefined &&
			old_disable_outside_click !== this.disable_outside_click
		) {
			this.#manage_outside_click();
		}

		if (params.onshow !== undefined) this.#onshow = params.onshow;
		if (params.onhide !== undefined) this.#onhide = params.onhide;

		// Update ARIA attributes on trigger if it exists
		this.#update_trigger_aria_attributes();

		// Note: We don't directly manipulate visibility with style properties
		// to allow Svelte transitions to work properly
	}

	/**
	 * Updates ARIA attributes and state for accessibility.
	 */
	#update_trigger_aria_attributes(): void {
		if (this.#trigger_element) {
			this.#trigger_element.setAttribute('aria-expanded', this.visible ? 'true' : 'false');

			// If we have a content element, establish the relationship
			if (this.#content_element) {
				const content_id = this.#content_element.id || `popover-content-${create_client_id()}`;
				this.#content_element.id = content_id;
				this.#trigger_element.setAttribute('aria-controls', content_id);
			}
		}
	}

	/**
	 * Shows the popover.
	 */
	show(): void {
		if (this.visible) return;

		this.visible = true;

		this.#manage_outside_click();
		this.#update_trigger_aria_attributes();

		if (this.#onshow) this.#onshow();
	}

	/**
	 * Hides the popover.
	 */
	hide(): void {
		if (!this.visible) return;

		this.visible = false;

		this.#manage_outside_click();
		this.#update_trigger_aria_attributes();

		if (this.#onhide) this.#onhide();
	}

	/**
	 * Toggles the popover visibility.
	 */
	toggle(visible = !this.visible): void {
		if (visible) {
			this.show();
		} else {
			this.hide();
		}
	}

	/**
	 * Attachment for the container element.
	 */
	container: Attachment<HTMLElement> = (node) => {
		this.#container_element = node;

		return () => {
			if (this.#container_element === node) {
				this.#container_element = null;
			}
		};
	};

	/**
	 * Attachment factory for the trigger element that shows/hides the popover.
	 */
	trigger = (params?: PopoverTriggerParameters): Attachment<HTMLElement> => {
		return (node) => {
			this.#trigger_element = node;

			if (params) {
				this.update(params);
			}

			this.#update_trigger_aria_attributes();

			const click_handler = on(node, 'click', (e) => {
				swallow(e);
				this.toggle();
			});

			return () => {
				click_handler();
				if (this.#trigger_element === node) {
					this.#trigger_element = null;
				}
			};
		};
	};

	/**
	 * Attachment factory for the popover content element.
	 */
	content = (params?: PopoverContentParameters): Attachment<HTMLElement> => {
		return (node) => {
			this.#content_element = node;

			if (params) {
				this.update(params);
			}

			if (this.popover_class) {
				node.classList.add(this.popover_class);
			}

			node.style.position = 'absolute';
			node.style.zIndex = '10';

			const update_node_position = () => {
				const styles = generate_position_styles(this.position, this.align, this.offset);

				const position_props = [
					'top',
					'bottom',
					'left',
					'right',
					'transform',
					'transform-origin',
					'width',
					'height',
				];
				for (const prop of position_props) {
					node.style.removeProperty(prop);
				}

				for (const key in styles) {
					node.style.setProperty(key, styles[key]!);
				}
			};

			update_node_position();
			this.#manage_outside_click();

			if (!node.hasAttribute('role')) {
				node.setAttribute('role', 'dialog');
			}

			return () => {
				if (this.#document_click_cleanup) {
					this.#document_click_cleanup();
					this.#document_click_cleanup = undefined;
				}

				if (this.popover_class) {
					node.classList.remove(this.popover_class);
				}

				if (this.#content_element === node) {
					this.#content_element = null;
				}
			};
		};
	};
}
