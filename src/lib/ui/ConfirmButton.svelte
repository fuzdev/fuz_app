<script lang="ts">
	/**
	 * Confirmation popover wrapping `PopoverButton`.
	 *
	 * Clicking the trigger opens a popover with a confirm button.
	 * On confirm, calls `onconfirm` and hides the popover (controlled
	 * by `hide_on_confirm`). Defaults to `position="left"`.
	 *
	 * Trigger content: pass `label` for a simple string, or a `children`
	 * snippet for custom content (the two are mutually exclusive — DEV
	 * errors when both are set). `pending: boolean` overlays a spinner
	 * and disables the trigger, mirroring `PendingButton` semantics so
	 * the label stays put while an async operation runs.
	 *
	 * @example
	 * ```svelte
	 * <ConfirmButton
	 * 	onconfirm={() => delete_item(item.id)}
	 * 	title="delete item"
	 * 	label="delete"
	 * 	pending={state.remove.loading(item.id)}
	 * />
	 * ```
	 *
	 * @example
	 * ```svelte
	 * <!-- custom trigger content via the children snippet -->
	 * <ConfirmButton
	 * 	onconfirm={() => grant(item.id, role)}
	 * 	title="offer {role}"
	 * 	pending={state.grant.loading(key)}
	 * >
	 * 	{#snippet children(_popover, _confirm)}+ {role}{/snippet}
	 * </ConfirmButton>
	 * ```
	 *
	 * @example
	 * ```svelte
	 * <!-- custom confirm button content -->
	 * <ConfirmButton onconfirm={handle_revoke} class="icon_button plain" title="revoke">
	 * 	revoke
	 * 	{#snippet popover_button_content()}revoke{/snippet}
	 * </ConfirmButton>
	 * ```
	 *
	 * @module
	 */

	import {DEV} from 'esm-env';
	import type {SvelteHTMLElements} from 'svelte/elements';
	import type {ComponentProps, Snippet} from 'svelte';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';
	import Glyph from '@fuzdev/fuz_ui/Glyph.svelte';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import PopoverButton from './PopoverButton.svelte';
	import type {Popover} from './popover.svelte.js';

	const GLYPH_REMOVE = '🗙';

	const {
		onconfirm,
		popover_button_attrs,
		hide_on_confirm = true,
		position = 'left',
		popover_content: popover_content_prop,
		popover_button_content,
		button,
		children,
		label,
		pending = false,
		disabled: disabled_prop,
		...rest
	}: OmitStrict<ComponentProps<typeof PopoverButton>, 'popover_content' | 'children'> &
		OmitStrict<SvelteHTMLElements['button'], 'children'> & {
			onconfirm: (popover: Popover) => void;
			popover_button_attrs?: SvelteHTMLElements['button'] | undefined;
			hide_on_confirm?: boolean | undefined;
			/** Unlike on `PopoverButton` this is optional and has a `confirm` arg */
			popover_content?: Snippet<[popover: Popover, confirm: () => void]> | undefined;
			/** Content for the popover button */
			popover_button_content?: Snippet<[popover: Popover, confirm: () => void]> | undefined;
			/** Unlike on `PopoverButton` this has a `confirm` arg */
			children?: Snippet<[popover: Popover, confirm: () => void]> | undefined;
			/** Simple string content for the trigger. Mutually exclusive with `children`. */
			label?: string | undefined;
			/**
			 * When `true`, the trigger is disabled and a spinner overlays the
			 * content (mirrors `PendingButton`). The label / children stay
			 * rendered underneath so the button keeps its size.
			 */
			pending?: boolean | undefined;
		} = $props();

	// TODO @many type union instead of this pattern?
	if (DEV) {
		$effect(() => {
			if (popover_content_prop && popover_button_attrs) {
				console.error(
					'ConfirmButton has both popover_content and popover_button_attrs defined - popover_content takes precedence',
				);
			}
			if (popover_content_prop && popover_button_content) {
				console.error(
					'ConfirmButton has both popover_content and popover_button_content defined - popover_content takes precedence',
				);
			}
			if (label !== undefined && children) {
				console.error('ConfirmButton has both label and children defined - pick one');
			}
		});
	}

	const confirm = (popover: Popover): void => {
		if (hide_on_confirm) popover.hide();
		onconfirm(popover);
	};
</script>

<!-- TODO the `as any` silences a type problem caused by the complex props -->
<PopoverButton
	{position}
	{button}
	{...rest as any}
	disabled={disabled_prop ?? pending}
	children={button ? undefined : children_default}
>
	{#snippet popover_content(popover)}
		{#if popover_content_prop}
			{@render popover_content_prop(popover, () => confirm(popover))}
		{:else}
			<button
				type="button"
				class="color_c bg_100"
				class:icon_button={!popover_button_content}
				onclick={() => confirm(popover)}
				title={rest.title ? `confirm ${rest.title}` : 'confirm'}
				{...popover_button_attrs}
			>
				{#if popover_button_content}
					{@render popover_button_content(popover, () => confirm(popover))}
				{:else}
					<Glyph glyph={GLYPH_REMOVE} />
				{/if}
			</button>
		{/if}
	{/snippet}
</PopoverButton>

{#snippet children_default(popover: Popover)}
	<span class="trigger" class:pending>
		<span class="content">
			{#if children}
				{@render children(popover, () => confirm(popover))}
			{:else if label !== undefined}
				{label}
			{:else}
				<Glyph glyph={GLYPH_REMOVE} />
			{/if}
		</span>
		{#if pending}
			<span class="animation">
				<PendingAnimation inline />
			</span>
		{/if}
	</span>
{/snippet}

<style>
	.trigger {
		position: relative;
	}
	.pending .content {
		visibility: hidden;
	}
	.animation {
		position: absolute;
		inset: 0;
		display: flex;
		justify-content: center;
		align-items: center;
	}
</style>
