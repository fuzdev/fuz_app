<script lang="ts">
	/**
	 * Button + popover composition for the common toggle-on-click pattern.
	 *
	 * Wraps a `Popover` instance with a `<button>`, a positioned content area,
	 * and scale transitions. Spreads extra props onto the button element.
	 * Pass `popover_content` for the popover body, and either `children` for
	 * simple button content or `button` for a fully custom trigger —
	 * both receive the `Popover` instance.
	 *
	 * @example
	 * ```svelte
	 * <PopoverButton position="bottom" align="center">
	 * 	{#snippet popover_content(popover)}
	 * 		<div class="box p_md">
	 * 			<button type="button" onclick={() => popover.hide()}>close</button>
	 * 		</div>
	 * 	{/snippet}
	 * 	open menu
	 * </PopoverButton>
	 * ```
	 *
	 * @example
	 * ```svelte
	 * <!-- custom trigger via the `button` snippet -->
	 * <PopoverButton position="right" align="start" disable_outside_click>
	 * 	{#snippet popover_content(popover)}
	 * 		<form onsubmit={() => popover.hide()}>
	 * 			<input name="search" />
	 * 			<button type="submit">go</button>
	 * 		</form>
	 * 	{/snippet}
	 * 	{#snippet button(popover)}
	 * 		<button type="button" class="icon_button" {@attach popover.trigger()}>
	 * 			search
	 * 		</button>
	 * 	{/snippet}
	 * </PopoverButton>
	 * ```
	 *
	 * @see `ConfirmButton` for a higher-level wrapper with confirmation semantics
	 *
	 * @module
	 */

	import type {SvelteHTMLElements} from 'svelte/elements';
	import type {Snippet} from 'svelte';
	import {scale} from 'svelte/transition';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

	import {Popover} from './popover.svelte.js';
	import type {Position, Alignment} from './position_helpers.js';

	const {
		position = 'bottom',
		align = 'center',
		disable_outside_click = false,
		popover_class,
		popover_attrs,
		popover_content,
		popover_container_attrs,
		button,
		children,
		...rest
	}: OmitStrict<SvelteHTMLElements['button'], 'children'> & {
		position?: Position | undefined;
		align?: Alignment | undefined;
		disable_outside_click?: boolean | undefined;
		popover_class?: string | undefined;
		popover_attrs?: SvelteHTMLElements['div'] | undefined;
		popover_content: Snippet<[popover: Popover]>;
		popover_container_attrs?: SvelteHTMLElements['div'] | undefined;
		button?: Snippet<[popover: Popover]> | undefined;
		children?: Snippet<[popover: Popover]> | undefined;
	} = $props();

	// TODO @many type union instead of this pattern?
	$effect(() => {
		if (children && button) {
			console.error('PopoverButton has both children and button defined - button takes precedence');
		}
		if (!children && !button) {
			console.error('PopoverButton requires either children or a button snippet prop');
		}
	});

	// Create a popover instance
	const popover = new Popover();

	// TODO refactor, try to remove
	// This hides the popover when the button is disabled
	$effect.pre(() => {
		if (rest.disabled) {
			popover.hide();
		}
	});
</script>

<!-- TODO these flex values fix some layout cases so that the container is laid out like the button, but this is a partial solution -->
<div
	{...popover_container_attrs}
	class="position:relative {popover_container_attrs?.class}"
	{@attach popover.container}
>
	{#if button}
		{@render button(popover)}
	{:else}
		<button
			type="button"
			{@attach popover.trigger({
				position,
				align,
				disable_outside_click,
			})}
			{...rest}
		>
			{@render children?.(popover)}
		</button>
	{/if}

	{#if popover.visible}
		<div
			{@attach popover.content({
				position,
				align,
				disable_outside_click,
				popover_class,
			})}
			in:scale={{duration: 80}}
			out:scale={{duration: 200}}
			{...popover_attrs}
		>
			{@render popover_content(popover)}
		</div>
	{/if}
</div>
