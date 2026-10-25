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

/** The admin lists whose out-of-range pages Rust names in `data.reason`. */
const PAGED_LIST_METHODS = [
	'admin_account_list',
	'audit_log_list',
	'audit_log_role_grant_history',
	'role_grant_offer_history'
];

/**
 * Rust's structured reason on one pagination refusal, TS sending none. Named
 * by case, each with its exact reason, so a reason appearing on another
 * refusal (a non-integer `limit`, which neither spine names) or the TS side
 * adopting one fails rather than hiding under the row.
 */
const rust_pagination_reason = (
	labels: ReadonlyArray<string>,
	reason: string
): KnownDivergence => ({
	case_name: PAGED_LIST_METHODS.flatMap((method) =>
		labels.map((label) => `admin → ${method} ${label} → 400`)
	),
	tracking_id: 'rust-pagination-reason',
	reason: 'Rust names an out-of-range limit or a negative offset in data.reason; TS sends none',
	what_differs: [{ path: 'body.error.data.reason', a: undefined, b: reason }]
});

/** Divergences the main conformance arrays show. */
export const differential_known_divergences: ReadonlyArray<KnownDivergence> = [
	rust_pagination_reason(['{limit: 0}', '{limit: max + 1}'], 'limit_out_of_range'),
	rust_pagination_reason(['{offset: -1}'], 'offset_negative'),
	{
		case_name: [
			'an unknown key',
			'a version',
			'a grandfathered flag',
			'methods on kind full',
			'a null methods on kind full',
			'an over-cap document'
		].map((label) => `session → account_token_create with ${label} in scope → 400`),
		tracking_id: 'rust-token-create-schema-reason',
		reason: 'Rust names a refused scope in data.reason; TS sends none',
		what_differs: [{ path: 'body.error.data.reason', a: undefined, b: 'invalid_token_scope' }]
	},
	ts_dev_zod_issues([...PAGED_LIST_METHODS, 'account_token_create', 'account_verify']),
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
