/**
 * The named-projection registry: every `public` table the full spine
 * migrates, mapped to its `*_COLUMNS` const or listed as a reasoned exemption.
 * ./column_projections.db.test.ts asserts both halves — each const names
 * exactly its live table's columns, and the two lists together are exactly
 * the live table set — so adding a table forces a const-or-exemption decision
 * (the `spine_method_coverage` shape, for columns). Not itself a test file.
 *
 * @module
 */

import { ACCOUNT_COLUMNS, ACTOR_COLUMNS } from '$lib/auth/account_queries.ts';
import { API_TOKEN_COLUMNS } from '$lib/auth/api_token_queries.ts';
import { APP_SETTINGS_COLUMNS } from '$lib/auth/app_settings_queries.ts';
import { AUDIT_LOG_COLUMNS } from '$lib/auth/audit_log_queries.ts';
import { AUTH_SESSION_COLUMNS } from '$lib/auth/session_queries.ts';
import { INVITE_COLUMNS } from '$lib/auth/invite_queries.ts';
import { ROLE_GRANT_COLUMNS } from '$lib/auth/role_grant_queries.ts';
import { ROLE_GRANT_OFFER_COLUMNS } from '$lib/auth/role_grant_offer_ddl.ts';
import { CELL_COLUMNS } from '$lib/db/cell_queries.ts';
import { CELL_GRANT_COLUMNS } from '$lib/db/cell_grant_queries.ts';
import { CELL_FIELD_COLUMNS } from '$lib/db/cell_field_queries.ts';
import { CELL_ITEM_COLUMNS } from '$lib/db/cell_item_queries.ts';
import { FACT_COLUMNS } from '$lib/db/fact_queries.ts';

/** Table → the exported const every read of that table projects through. */
export const column_projections: Record<string, ReadonlyArray<string>> = {
	account: ACCOUNT_COLUMNS,
	actor: ACTOR_COLUMNS,
	api_token: API_TOKEN_COLUMNS,
	app_settings: APP_SETTINGS_COLUMNS,
	audit_log: AUDIT_LOG_COLUMNS,
	auth_session: AUTH_SESSION_COLUMNS,
	invite: INVITE_COLUMNS,
	role_grant: ROLE_GRANT_COLUMNS,
	role_grant_offer: ROLE_GRANT_OFFER_COLUMNS,
	cell: CELL_COLUMNS,
	cell_grant: CELL_GRANT_COLUMNS,
	cell_field: CELL_FIELD_COLUMNS,
	cell_item: CELL_ITEM_COLUMNS,
	fact: FACT_COLUMNS
};

/**
 * Tables with no row-shaped read, and so no const — each with the reason.
 * A table that starts hydrating rows moves out of here into
 * `column_projections`.
 */
export const column_projection_exempt_tables: Record<string, string> = {
	schema_version: 'migration tracker — framework bookkeeping read by name/sequence only',
	bootstrap_lock:
		'single-row lock — read as the `bootstrapped` flag and flipped by conditional UPDATE',
	cell_history: 'dormant — present but unwritten and unread until the snapshot lifecycle lands',
	fact_ref: 'edge table — read as `target_hash` lists, never as rows',
	memo: 'reserved for MemoStore — no reads yet'
};
