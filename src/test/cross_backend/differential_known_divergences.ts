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
 * A declared divergence no case shows yet is recorded here in prose under its
 * tracking id, so it isn't lost. The differential can't check a prose entry,
 * so each names the unit test that turns red when it closes:
 *
 * - `zod-uuid-uppercase-max` — the max UUID in upper or mixed case
 *   (`FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF`). The Rust spine's grammar
 *   (`fuz_http::is_valid_uuid`) takes it, as the fuz_schema `Uuid` twin in
 *   `primitive_schemas_fuz.ts` does; the Zod `Uuid` (`z.uuid()`) takes the
 *   max in lowercase only. Two families diverge on it. A Zod `Uuid` input
 *   field (`cell_get.id`, say): TS answers `-32602` `invalid_params`, Rust
 *   reads an id naming nothing (not found, `-32003`). A REST route declaring
 *   `query: z.strictObject({acting: ActingActor})` (`audit_log_route_schema.ts`,
 *   `http/db_routes.ts`, `server/serve_fact_route.ts`): TS answers 400
 *   `invalid_query_params` ahead of auth, Rust passes the shape check and
 *   answers 401 to an anonymous caller and `actor_not_on_account` to an
 *   authenticated one. The `acting` selector of an action, the status route
 *   and the WS upgrade read by the twin's grammar (`parse_acting`) and agree.
 *   Closes when the built-in specs' inputs and query schemas move to the
 *   fuz_schema twins. No case here exercises it: the table runner sends no
 *   query string, and a case pins one answer on each backend's conformance
 *   leg. The closing tests: for the input family, `CellGetInput` › `the Zod
 *   cell_get input refuses the uppercase max UUID` in
 *   `auth/cell_action_specs.test.ts`; for the query family, `AuditStreamQuery` ›
 *   `the Zod acting query refuses the uppercase max UUID` in
 *   `auth/audit_log_route_schema.test.ts`.
 *
 * @module
 */

import type { KnownDivergence } from '#lib/testing/cross_backend/differential.ts';

/**
 * The TS spine's DEV-only `issues` on `invalid_params`, as `WireIssue`s
 * whichever library the input schema is in: the binary runs under `DEV`,
 * where `dev_only` keeps them on `error.data`; in production TS omits them,
 * and Rust omits them always.
 *
 * Matched by method rather than case: the rule is the dispatcher's, the same
 * on every schema refusal, and Rust is held to sending none (`b: undefined`).
 */
const ts_dev_issues = (method: ReadonlyArray<string>): KnownDivergence => ({
	method,
	tracking_id: 'ts-dev-zod-issues',
	reason: 'TS keeps the validation issues on invalid_params in DEV only; Rust never sends them',
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
	ts_dev_issues([
		...PAGED_LIST_METHODS,
		'account_token_create',
		'account_verify',
		'actor_lookup',
		'actor_search',
		'cell_list',
		'cell_field_list',
		'cell_item_list'
	]),
	ts_dev_auth_debug_header
];

/**
 * Divergences the main conformance arrays show over the WebSocket leg: the
 * HTTP ledger minus the header rows, since a frame carries no headers.
 */
export const differential_ws_known_divergences: ReadonlyArray<KnownDivergence> =
	differential_known_divergences.filter((d) => d !== ts_dev_auth_debug_header);

/** Divergences the participation cases show. */
export const differential_participation_known_divergences: ReadonlyArray<KnownDivergence> = [
	ts_dev_issues(['role_grant_assign', 'role_grant_offer_create'])
];
