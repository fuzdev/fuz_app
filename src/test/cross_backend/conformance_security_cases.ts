/**
 * Security-negative conformance cases.
 *
 * The opinionated security matrix on top of the spec-derived
 * auto-enumeration — the refusals / masks / equivalences a wire-shape
 * check passes green on even when behavior is wrong. Each row runs both
 * legs (in-process `gro test` + cross-process gate) against each impl's
 * **real** auth resolution, so the credential ceiling is no longer
 * validated only against the `TEST_CONTEXT_PRESET_KEY` stub.
 *
 * Every `note` cites a **public** `security.md` property (the table ships
 * in a public package — no grimoire refs). Stateful invariants
 * (fail-closed tombstone, last-admin guard, deterministic lifecycle) are
 * imperative and live in `account_lifecycle.cross.test.ts`, not here.
 *
 * @module
 */

import {
	ERROR_CREDENTIAL_TYPE_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_INVALID_CREDENTIALS,
	ERROR_NO_MATCHING_INVITE,
	ERROR_ROLE_GRANT_NOT_FOUND,
} from '$lib/http/error_schemas.js';
import {
	ERROR_CANNOT_DELETE_KEEPER,
	ERROR_PURGE_NOT_CONFIRMED,
} from '$lib/auth/admin_action_specs.js';
import {ERROR_ROLE_GRANT_OFFER_NOT_FOUND} from '$lib/auth/role_grant_offer_action_specs.js';
import {DEFAULT_TEST_PASSWORD} from '$lib/testing/app_server.js';
import type {ConformanceCase} from '$lib/testing/cross_backend/conformance_case.js';

/** A well-formed UUID that never names a real row — exercises the not-found / mask paths. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** A password that is never the seeded one, so login always fails on credentials. */
const WRONG_PASSWORD = 'wrong-password-not-the-real-one';

// --- Batch 1: credential-type ceiling ------------------------------
// The one load-bearing invariant validated ONLY against the stub today.
// The keeper credential ceiling: a session / api_token credential, even
// with the keeper role, must NOT reach a keeper-gated route — the
// credential gate fires before the role gate.

const credential_ceiling_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'session credential with keeper role → account_purge → 403 credential_type_required',
		request: {method: 'account_purge', as: 'keeper', params: {account_id: NIL_UUID, confirm: true}},
		expect: {
			status: 403,
			error_reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
			fields: {required_credential_types: ['daemon_token']},
		},
		note: 'security.md §Credential Type Hierarchy — a session cookie with a keeper role_grant cannot exercise keeper routes; only a daemon token can',
	},
	{
		name: 'api_token credential with keeper role → account_purge → 403 credential_type_required',
		request: {method: 'account_purge', as: 'token', params: {account_id: NIL_UUID, confirm: true}},
		expect: {
			status: 403,
			error_reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
			fields: {required_credential_types: ['daemon_token']},
		},
		note: 'security.md §Credential Type Hierarchy — api_token tops out at admin; keeper requires the daemon-token channel',
	},
	{
		// Positive control: only the daemon credential clears the credential +
		// role gates and reaches the handler, where the confirm guard then
		// fires. Proves the gate is not trivially always-403.
		name: 'daemon token + keeper role → account_purge clears credential+role gates (confirm guard)',
		request: {
			method: 'account_purge',
			as: 'daemon',
			params: {account_id: NIL_UUID, confirm: false},
		},
		expect: {status: 400, error_reason: ERROR_PURGE_NOT_CONFIRMED},
		note: 'security.md §Credential Type Hierarchy — daemon token reaches keeper operations; the 400 confirm guard proves it passed the 403 gates',
	},
	{
		name: 'daemon token → account_token_create → 403 credential_type_required',
		request: {method: 'account_token_create', as: 'daemon', params: {}},
		expect: {
			status: 403,
			error_reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
			fields: {required_credential_types: ['session']},
		},
		note: 'security.md §Credential-channel gating on credential-minting actions — token minting requires a browser-context session, closing bearer/daemon-spawn-bearer persistence',
	},
	{
		name: 'api_token (bearer) → account_token_create → 403 credential_type_required',
		request: {method: 'account_token_create', as: 'token', params: {}},
		expect: {
			status: 403,
			error_reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
			fields: {required_credential_types: ['session']},
		},
		note: 'security.md §Credential-channel gating on credential-minting actions — a leaked bearer cannot mint sibling tokens to outlive revocation',
	},
];

// --- Batch 2: privilege gates (declarative) ---------------------------
// Stateful fail-closed/last-admin cases live in account_lifecycle.cross.test.ts.

const privilege_gate_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'non-admin → account_undelete → 403 insufficient_permissions',
		request: {method: 'account_undelete', as: 'fresh_non_admin', params: {account_id: NIL_UUID}},
		expect: {status: 403, error_reason: ERROR_INSUFFICIENT_PERMISSIONS},
		note: 'security.md §Authorization — reactivation is admin-only (a tombstoned account cannot authenticate, so there is no self path)',
	},
	{
		// Keeper deletes itself: the target holds an active keeper role grant,
		// so the keeper-removal guard refuses before any mutation. No seeding
		// needed — the per-test keeper is its own target.
		name: 'delete keeper-role account → account_delete → 403 cannot_delete_keeper',
		request: {method: 'account_delete', as: 'keeper', params: {}},
		expect: {status: 403, error_reason: ERROR_CANNOT_DELETE_KEEPER},
		note: 'security.md §Authorization "Account-removal target guards" — a keeper-role account is never API-removable; auth + daemon-token resolution both pivot on it',
	},
];

// --- Batch 3: IDOR masks + enumeration equivalence --------------------
// Cell IDOR (404-over-403) is already covered by the cell cross suites;
// these pin the role_grant / offer masks and the login/signup shadows.

const idor_and_enumeration_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'accept nonexistent offer → 404 (existence not disclosed)',
		request: {
			method: 'role_grant_offer_accept',
			as: 'fresh_non_admin',
			params: {offer_id: NIL_UUID},
		},
		expect: {status: 404, error_reason: ERROR_ROLE_GRANT_OFFER_NOT_FOUND},
		note: 'security.md §Authorization "404-over-403 is the general mask" — a missing offer and an offer the caller cannot view are wire-indistinguishable',
	},
	{
		name: 'admin revokes nonexistent role_grant → 404 (existence not disclosed)',
		request: {
			method: 'role_grant_revoke',
			as: 'keeper',
			params: {actor_id: NIL_UUID, role_grant_id: NIL_UUID},
		},
		expect: {status: 404, error_reason: ERROR_ROLE_GRANT_NOT_FOUND},
		note: 'security.md §Authorization "IDOR guard" — the revoke handler returns not_found on a missing or foreign role_grant, never a 403 that would confirm the id',
	},
	{
		// Login shadow: found-wrong-password and not-found converge on an
		// identical {401, invalid_credentials}. Byte-identity + the timing
		// floor stay TS-internal (architecture decision 8); these two rows
		// pin the cross-process structural shadow.
		name: 'login existing account wrong password → 401 invalid_credentials',
		request: {
			method: '/login',
			as: 'anonymous',
			params: {username: 'keeper', password: WRONG_PASSWORD},
		},
		expect: {status: 401, error_reason: ERROR_INVALID_CREDENTIALS},
		note: 'security.md §Account Enumeration Prevention — wrong-password and account-not-found return an identical 401 invalid_credentials shape',
	},
	{
		name: 'login nonexistent account → 401 invalid_credentials',
		request: {
			method: '/login',
			as: 'anonymous',
			params: {username: 'no_such_account_xyz', password: WRONG_PASSWORD},
		},
		expect: {status: 401, error_reason: ERROR_INVALID_CREDENTIALS},
		note: 'security.md §Account Enumeration Prevention — account-not-found is wire-indistinguishable from wrong-password',
	},
	{
		// Signup existence-mask: invite-gating bails with no_matching_invite
		// before any conflict check, so an existing username is masked behind
		// the same 403 a free username gets. An anonymous prober learns
		// nothing about who exists. (The 409 conflict is deliberately not
		// asserted here — it is unreachable for an anonymous, no-invite caller
		// and would itself be an enumeration surface.)
		name: 'signup no-invite, free username → 403 no_matching_invite',
		request: {
			method: '/signup',
			as: 'anonymous',
			params: {username: 'brand_new_account', password: DEFAULT_TEST_PASSWORD},
		},
		expect: {status: 403, error_reason: ERROR_NO_MATCHING_INVITE},
		note: 'security.md §Signup — account creation is invite-gated; a no-invite signup is refused before account creation proceeds',
	},
	{
		name: 'signup no-invite, existing username → identical 403 (existence masked)',
		request: {
			method: '/signup',
			as: 'anonymous',
			params: {username: 'keeper', password: DEFAULT_TEST_PASSWORD},
		},
		expect: {status: 403, error_reason: ERROR_NO_MATCHING_INVITE},
		note: 'security.md §Signup + §Account Enumeration Prevention — the invite gate masks account existence: an existing username returns the same 403 as a free one',
	},
];

/**
 * The full declarative security slate, ordered by blast radius
 * (credential ceiling → privilege gates → IDOR masks + enumeration
 * equivalence).
 */
export const conformance_security_cases: ReadonlyArray<ConformanceCase> = [
	...credential_ceiling_cases,
	...privilege_gate_cases,
	...idor_and_enumeration_cases,
];
