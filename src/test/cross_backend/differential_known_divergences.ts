/**
 * The known-divergence ledger for fuz_app's own TS-vs-Rust differential
 * (`differential.cross.test.ts`).
 *
 * Every entry is a tracked difference between the TS spine and the Rust
 * `testing_spine_stub`, with the paths it differs at. The differential asserts
 * each still differs there and nowhere else, and turns red when it closes, so
 * an entry is deleted as soon as the spines converge. Nothing goes here
 * without a tracking id.
 *
 * @module
 */

import type { KnownDivergence } from '#lib/testing/cross_backend/differential.ts';

/**
 * The TS spine's DEV-only Zod `issues` on `invalid_params`: the binary runs
 * under `DEV`, where `dev_only` keeps them on `error.data`; in production TS
 * omits them, and Rust omits them always.
 *
 * Matched by method rather than case: the rule is the dispatcher's, the same
 * on every schema refusal, and Rust is held to sending none (`b: undefined`).
 */
const ts_dev_zod_issues = (method: ReadonlyArray<string>): KnownDivergence => ({
	method,
	tracking_id: 'ts-dev-zod-issues',
	reason: 'TS keeps Zod issues on invalid_params in DEV only; Rust never sends them',
	what_differs: [{ path: 'body.error.data.issues', b: undefined }]
});

/**
 * The TS spine's DEV-only `X-Fuz-Auth-Debug` header on a credential discarded
 * as browser context; never sent in production, never sent by Rust.
 */
const ts_dev_auth_debug_header: KnownDivergence = {
	case_name: [
		'valid daemon token + Origin (+ session) → account_purge → 403 credential_type_required ' +
			'(browser-context discard, not honored)',
		'bearer token + Origin → account_verify → 401 (browser-context discard, no replay)'
	],
	tracking_id: 'ts-dev-auth-debug-header',
	reason: 'TS names a browser-context credential discard in a DEV-only header',
	what_differs: [{ path: 'headers.x-fuz-auth-debug', a: true, b: undefined }]
};

/** The admin lists with `limit` / `offset` paging. */
const PAGED_LIST_METHODS = [
	'admin_account_list',
	'audit_log_list',
	'audit_log_role_grant_history',
	'role_grant_offer_history'
];

/** Divergences the main conformance arrays show. */
export const differential_known_divergences: ReadonlyArray<KnownDivergence> = [
	ts_dev_zod_issues([
		...PAGED_LIST_METHODS,
		'account_token_create',
		'account_verify',
		'actor_lookup',
		'cell_list',
		'cell_field_list',
		'cell_item_list'
	]),
	ts_dev_auth_debug_header
];

/**
 * Divergences the main conformance arrays show over the WebSocket leg: the
 * HTTP ledger minus the header row, since a frame carries no headers.
 */
export const differential_ws_known_divergences: ReadonlyArray<KnownDivergence> =
	differential_known_divergences.filter((d) => d !== ts_dev_auth_debug_header);

/** Divergences the participation cases show. */
export const differential_participation_known_divergences: ReadonlyArray<KnownDivergence> = [
	ts_dev_zod_issues(['role_grant_assign', 'role_grant_offer_create'])
];
