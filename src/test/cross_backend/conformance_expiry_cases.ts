/**
 * Expired-credential conformance cases.
 *
 * Promotes the expired-session rejection from in-process-only coverage
 * (which forged a cookie with a backdated *payload* and so only ever
 * exercised the pre-DB `parse_session` gate) to a cross-process assertion
 * against the authoritative server-side **DB-row** expiry gate
 * (`query_session_get_valid` — `WHERE expires_at > NOW()`). The
 * `expired_session` principal mints a backdated `auth_session` row behind a
 * still-valid signed cookie via `_testing_mint_session`, so resolution
 * clears the cookie-payload gate and is refused by the DB-row gate — the
 * one the in-process payload-expiry tests never reached and the one that
 * structurally needs a server-side mint (the cross-process driver has no
 * keyring).
 *
 * Two rows: a read path (RPC `account_verify`) and a mutation path (REST
 * `POST /logout`). The two byte-identical in-process `account_verify`
 * skips collapse into the single read row. The cookie-*payload* gate stays
 * covered by `parse_session`'s own unit tests (pure crypto, no DB — the
 * same TS-internal treatment architecture decision 8 gives the timing
 * floor).
 *
 * Every `note` cites a **public** `security.md` property (the table ships
 * in a public package — no internal-planning refs).
 *
 * @module
 */

import { ERROR_AUTHENTICATION_REQUIRED } from '$lib/http/error_schemas.ts';
import type { ConformanceCase } from '$lib/testing/cross_backend/conformance_case.ts';

export const conformance_expiry_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'expired server-side session → account_verify → 401',
		request: { method: 'account_verify', as: 'expired_session' },
		expect: { status: 401, error_reason: ERROR_AUTHENTICATION_REQUIRED },
		note: 'security.md §Session Security — sessions are server-side and DB-resident; an auth_session row past its expires_at is not authenticated, even when the signed cookie envelope itself is still valid'
	},
	{
		name: 'expired server-side session → POST /logout → 401',
		request: { method: '/logout', as: 'expired_session' },
		// REST 401 — status pins the denial class (the in-process skip this
		// replaces asserted status only).
		expect: { status: 401 },
		note: 'security.md §Session Security — the DB-row expiry gate refuses an expired session on a mutation route too'
	}
];
