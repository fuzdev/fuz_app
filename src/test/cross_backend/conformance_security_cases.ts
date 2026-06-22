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
 * in a public package — no internal-planning refs). Stateful invariants
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
} from '$lib/http/error_schemas.ts';
import {
	ERROR_CANNOT_DELETE_KEEPER,
	ERROR_PURGE_NOT_CONFIRMED,
} from '$lib/auth/admin_action_specs.ts';
import {ERROR_ROLE_GRANT_OFFER_NOT_FOUND} from '$lib/auth/role_grant_offer_action_specs.ts';
import {DEFAULT_TEST_PASSWORD} from '$lib/testing/test_credentials.ts';
import type {ConformanceCase} from '$lib/testing/cross_backend/conformance_case.ts';

/** A well-formed UUID that never names a real row — exercises the not-found / mask paths. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** A password that is never the seeded one, so login always fails on credentials. */
const WRONG_PASSWORD = 'wrong-password-not-the-real-one';

// --- Batch 1: credential-type ceiling ------------------------------
// The one load-bearing invariant validated ONLY against the stub today.
// The keeper credential ceiling: a session / api_token credential, even
// with the keeper role, must NOT reach a keeper-gated route — the
// credential gate fires before the role gate.
//
// The four `account_purge` rejection modes — session, api_token, a discarded
// invalid daemon token, and a discarded browser-context daemon token — share
// the `account_purge_credential_ceiling` equivalence group: the runner asserts
// all four produce a BYTE-IDENTICAL 403 on each spine, so no wrong-credential
// path is a fingerprinting oracle for which credential was sent. The `daemon`
// positive control (no Origin → token honored → 400 confirm guard) is the
// non-vacuous control standing apart from the group.

const credential_ceiling_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'session credential with keeper role → account_purge → 403 credential_type_required',
		request: {method: 'account_purge', as: 'keeper', params: {account_id: NIL_UUID, confirm: true}},
		expect: {
			status: 403,
			error_reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
			fields: {required_credential_types: ['daemon_token']},
			equivalence_group: 'account_purge_credential_ceiling',
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
			equivalence_group: 'account_purge_credential_ceiling',
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
		// Regression: an INVALID/malformed daemon token (no Origin) carried with
		// the keeper's session cookie at a daemon-gated action must soft-fail-
		// discard the daemon token and surface the identical 403
		// credential_type_required on both spines. TS once hard-failed the invalid
		// daemon token with a 401 invalid_daemon_token while the Rust spine
		// returned `None` → fell through to the session leg → 403; this row pins
		// the converged behavior so the divergence can't return undetected. The
		// `invalid_daemon` principal threads the session cookie so the refusing
		// layer is the credential-type gate (403), not the auth gate (401).
		name: 'invalid daemon token (+ session) → account_purge → 403 credential_type_required (soft-fail discard, not 401)',
		request: {
			method: 'account_purge',
			as: 'invalid_daemon',
			params: {account_id: NIL_UUID, confirm: true},
		},
		expect: {
			status: 403,
			error_reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
			fields: {required_credential_types: ['daemon_token']},
			equivalence_group: 'account_purge_credential_ceiling',
		},
		note: 'security.md §Credential Type Hierarchy — an invalid daemon token is discarded; auth falls through to the session, which a keeper-gated action refuses with credential_type_required, never a hard invalid-token 401 that would diverge from the Rust spine',
	},
	{
		// Regression: a VALID daemon token carried in a browser context (Origin
		// present) at a daemon-gated action must be DISCARDED (not honored) on
		// both spines — the daemon-token middleware drops a header-bearing token
		// as browser context, mirroring the bearer guard and the Rust spine's
		// `is_browser_context`. The keeper session cookie rides alongside so auth
		// falls through to the session leg → 403 credential_type_required. The
		// contrast with the `daemon` positive control above (no Origin → token
		// honored → 400 confirm guard) is the proof: the only difference is the
		// Origin header, so a 403 here (vs 400 there) pins that a valid daemon
		// token does NOT authenticate from a browser context. Without the discard
		// the token would clear the credential gate and the spines could diverge.
		name: 'valid daemon token + Origin (+ session) → account_purge → 403 credential_type_required (browser-context discard, not honored)',
		request: {
			method: 'account_purge',
			as: 'daemon_browser',
			params: {account_id: NIL_UUID, confirm: true},
		},
		expect: {
			status: 403,
			error_reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
			fields: {required_credential_types: ['daemon_token']},
			equivalence_group: 'account_purge_credential_ceiling',
		},
		note: 'security.md §Credential Type Hierarchy + §Browser/CLI split — a daemon token is loopback-only and never legitimately carries an Origin, so a header-bearing one is discarded as browser context; auth falls through to the session, which the keeper-gated action refuses with credential_type_required (the valid token is dropped, not honored — the same guard the bearer leg carries, on both spines)',
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
	{
		name: 'api_token (bearer) → /logout → 403 credential_type_required',
		request: {method: '/logout', as: 'token'},
		expect: {
			status: 403,
			error_reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
			fields: {required_credential_types: ['session']},
		},
		note: 'security.md §Credential-channel gating on credential-minting actions — logout is a session-bound operation; a bearer holds no session to end, so it is refused rather than returning a misleading 200 + a phantom logout audit row (gated for forensic fidelity, not lockout)',
	},
	// Browser/CLI split (anti-replay): a VALID bearer token replayed from a
	// browser context (Origin present) must be discarded, so an authed action
	// sees no credential and 401s — wire-INDISTINGUISHABLE from sending nothing.
	// The `browser_bearer_replay` equivalence group pins that byte-identity on
	// each spine: `bearer_browser` (token discarded) and `anonymous` (no token)
	// produce the same 401. The `token` principal elsewhere is the honored
	// counterpart (no Origin → same token authenticates), so a 401 here proves
	// the discard fired rather than the token being invalid. account_verify is
	// the minimal account-required read; it returns 200 to an honored bearer, so
	// the 401 is discriminating.
	{
		name: 'bearer token + Origin → account_verify → 401 (browser-context discard, no replay)',
		request: {method: 'account_verify', as: 'bearer_browser'},
		expect: {status: 401, equivalence_group: 'browser_bearer_replay'},
		note: 'security.md §Browser/CLI split — a stolen API token cannot be replayed from a browser context; the bearer is discarded when Origin/Referer is present, so the request is wire-indistinguishable from anonymous',
	},
	{
		name: 'anonymous → account_verify → 401 (browser-replayed bearer equivalence baseline)',
		request: {method: 'account_verify', as: 'anonymous'},
		expect: {status: 401, equivalence_group: 'browser_bearer_replay'},
		note: 'security.md §Browser/CLI split — the no-credential baseline a browser-replayed bearer must be byte-identical to (the equivalence group asserts both 401s match)',
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
		// identical {401, invalid_credentials}. The `equivalence_group` lifts
		// the byte-identity of the two bodies — previously a TS-internal
		// regression (architecture decision 8) — into the cross-impl gate, so
		// both spines are held to "wire-indistinguishable", not just "same
		// status + reason". (The timing floor stays TS-internal — it is not a
		// wire-observable property the runner can compare.)
		name: 'login existing account wrong password → 401 invalid_credentials',
		request: {
			method: '/login',
			as: 'anonymous',
			params: {username: 'keeper', password: WRONG_PASSWORD},
		},
		expect: {
			status: 401,
			error_reason: ERROR_INVALID_CREDENTIALS,
			equivalence_group: 'login_enumeration_shadow',
		},
		note: 'security.md §Account Enumeration Prevention — wrong-password and account-not-found return an identical 401 invalid_credentials shape',
	},
	{
		name: 'login nonexistent account → 401 invalid_credentials',
		request: {
			method: '/login',
			as: 'anonymous',
			params: {username: 'no_such_account_xyz', password: WRONG_PASSWORD},
		},
		expect: {
			status: 401,
			error_reason: ERROR_INVALID_CREDENTIALS,
			equivalence_group: 'login_enumeration_shadow',
		},
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
		expect: {
			status: 403,
			error_reason: ERROR_NO_MATCHING_INVITE,
			equivalence_group: 'signup_existence_mask',
		},
		note: 'security.md §Signup — account creation is invite-gated; a no-invite signup is refused before account creation proceeds',
	},
	{
		name: 'signup no-invite, existing username → identical 403 (existence masked)',
		request: {
			method: '/signup',
			as: 'anonymous',
			params: {username: 'keeper', password: DEFAULT_TEST_PASSWORD},
		},
		expect: {
			status: 403,
			error_reason: ERROR_NO_MATCHING_INVITE,
			equivalence_group: 'signup_existence_mask',
		},
		note: 'security.md §Signup + §Account Enumeration Prevention — the invite gate masks account existence: an existing username returns the same 403 as a free one',
	},
];

// --- Batch 4: phase ordering (401 before 400) -------------------------
// An unauthenticated caller sending MALFORMED input to an authed surface
// must be refused at the auth phase (401) before input validation (400)
// ever runs — otherwise a parse error leaks the route's input schema /
// shape to an anonymous prober. Pins the dispatcher's 401 → 400 → 403 order
// on both impls. The Rust dispatcher validates input handler-side today, so
// these rows also guard that a future input-validation port can't reorder
// ahead of the auth gate undetected (the malformed params would 400 first).

const phase_order_cases: ReadonlyArray<ConformanceCase> = [
	{
		// `session_id` validates as a 64-hex Blake3Hash; a number is malformed
		// and would 400 if validation ran before auth. As anonymous it must 401.
		name: 'anonymous + malformed params → authed RPC method → 401 (not a 400 schema leak)',
		request: {
			method: 'account_session_revoke',
			as: 'anonymous',
			params: {session_id: 12345},
		},
		expect: {status: 401},
		note: 'security.md §Authorization "Phase ordering hides route shape from unauthenticated callers" — the 401 → 400 → 403 dispatch order: pre-validation auth fires before input validation, so an unauthenticated caller never learns route shape from a parse failure',
	},
	{
		// REST twin: `/password` is account + session gated; a malformed body
		// from an anonymous caller must 401 at require_auth, not 400 at parse.
		name: 'anonymous + malformed body → authed REST /password → 401 (not a 400 schema leak)',
		request: {
			method: '/password',
			as: 'anonymous',
			params: {current_password: 999, new_password: false},
		},
		expect: {status: 401},
		note: 'security.md §Authorization "Phase ordering hides route shape from unauthenticated callers" — require_auth fires before body parsing, so an unauthenticated caller never sees route-shape information from input parse failures',
	},
];

// --- Batch 5: response-header hygiene (no backend fingerprinting) ------
// Neither spine emits Server / X-Powered-By / WWW-Authenticate. The runner
// enforces this as an always-on floor on EVERY case; this row makes the
// property explicit — pinned on a 401, the response most likely to carry a
// WWW-Authenticate challenge — so a regression names this case, and it ties
// the parity gate to the cited security.md property.

const response_header_hygiene_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'anonymous → admin_account_list → 401 emits no backend-fingerprinting headers',
		request: {method: 'admin_account_list', as: 'anonymous'},
		expect: {
			status: 401,
			headers: {server: null, 'x-powered-by': null, 'www-authenticate': null},
		},
		note: 'security.md §Response Headers — the app emits no Server / X-Powered-By / WWW-Authenticate; a 401 carries no auth-scheme challenge a prober could use to fingerprint the backend',
	},
];

// --- Batch: sensitive-field non-disclosure ------------------------------
// The negative-space twin of the output-schema parity: a wire-shape check
// passes green even if a backend leaks a secret column, because the leaked
// field is *additive*. `absent_fields` pins that the credential secrets never
// serialize — on the success bodies authorized callers actually receive, on
// BOTH spines (a regression would otherwise leak identically and silently on
// each). Non-vacuous by construction: the keeper is always a row in its own
// account list, and `_testing_reset` always seeds the keeper an api token, so
// each list carries >= 1 element to search.
const data_exposure_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'admin_account_list (keeper) → 200 never serializes password_hash',
		request: {method: 'admin_account_list', as: 'keeper'},
		expect: {status: 200, absent_fields: ['password_hash']},
		note: 'security.md §Password Hashing — the password hash is never exposed on any account-listing surface; the keeper is always in its own list so the assertion is non-vacuous',
	},
	{
		name: 'account_token_list (keeper) → 200 never serializes token_hash',
		request: {method: 'account_token_list', as: 'keeper'},
		expect: {status: 200, absent_fields: ['token_hash']},
		note: 'security.md §API Token Security — only the blake3 hash is stored and it is never listed; the keeper always holds the seeded api token so the list is non-empty',
	},
];

/**
 * The full declarative security slate, ordered by blast radius
 * (credential ceiling → privilege gates → IDOR masks + enumeration
 * equivalence → phase ordering → response-header hygiene → sensitive-field
 * non-disclosure).
 */
export const conformance_security_cases: ReadonlyArray<ConformanceCase> = [
	...credential_ceiling_cases,
	...privilege_gate_cases,
	...idor_and_enumeration_cases,
	...phase_order_cases,
	...response_header_hygiene_cases,
	...data_exposure_cases,
];
