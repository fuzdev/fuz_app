/**
 * Shared `format_scope` callback contract for role-grant-display components.
 *
 * Role grants and offers carry a `scope_id` that names a consumer-owned resource
 * (e.g. a classroom uuid). The default render is the raw uuid. Consumers wire
 * a `FormatScope` via context to render a human label without per-page
 * lookup or forking the components.
 *
 * @module
 */

import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';

import { truncate_uuid } from './ui_format.ts';

/**
 * Render a `{scope_id, role}` pair as a human label. Return `null` to fall
 * back to the raw scope uuid (or a caller-chosen `global_label` when
 * `scope_id` is `null`).
 *
 * Returning `null` for unknown scope ids (stale cache, revoked resource) is
 * the recommended pattern — components show the raw uuid rather than a
 * misleading blank.
 */
export type FormatScope = (args: { scope_id: string | null; role: string }) => string | null;

/** Default `FormatScope` — always returns `null` so callers fall back to the raw uuid. */
export const default_format_scope: FormatScope = () => null;

/**
 * Svelte context carrying a getter for the consumer's `FormatScope`.
 * Provisioned by `provide_admin_rpc_contexts` from its `format_scope` option.
 * Default getter returns `default_format_scope` so unprovisioned trees render
 * the raw uuid.
 */
export const format_scope_context = create_context<() => FormatScope>(
	() => () => default_format_scope
);

/**
 * Resolve a scope label across the context → raw-uuid fallback chain.
 *
 * `global_label` is returned for `scope_id === null`. Callers pass `null`
 * to render no chip (admin tables — global is the implicit default) or
 * `'global'` for explicit labels (offer surfaces). The return type
 * propagates `null` only when `global_label` is `null`.
 */
export const resolve_scope_label = <G extends string | null>(
	scope_id: string | null,
	role: string,
	format_scope: FormatScope,
	global_label: G
): string | G => {
	if (scope_id === null) return global_label;
	return format_scope({ scope_id, role }) ?? truncate_uuid(scope_id);
};
