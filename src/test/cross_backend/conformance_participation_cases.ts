/**
 * Declarative conformance cases for **role-gated participation** — the
 * cross-backend proof that an app-defined role (`participant`,
 * `grant_paths: ['admin']`) is conferred identically on both spines.
 *
 * Single-request matrix (the conformance table's home); the multi-step
 * *success* paths (assign-lands, offer→accept-lands — they need a real
 * recipient account) live in the imperative escape-hatch suite
 * `describe_role_grant_participation_cross_tests`.
 *
 * Three properties, each pinned by single requests that resolve before any
 * recipient lookup (so a `NIL_UUID` account is enough):
 *
 * - **(a) grantability** — `role_grant_assign` of `participant` passes the
 *   admin-grant-path gate and dies *past* it at account-resolution → 404,
 *   while a non-grantable role (`keeper`, or an unregistered name) is refused
 *   *at* the gate → 403 `role_not_web_grantable`. The 404-vs-403 split is the
 *   proof the gate admits the widened app role on both spines.
 * - **(b) admin-only conferral** — a non-admin *holder* of `participant`
 *   (and a fresh non-admin) cannot offer it → 403
 *   `role_grant_offer_not_authorized`. No holder-propagation
 *   (participation-gates.md Decision 6).
 * - **(c) `role_grant_assign` is admin-only** — a non-admin holder / fresh
 *   non-admin is refused at the dispatcher → 403 `insufficient_permissions`;
 *   anonymous → 401.
 *
 * Derived from the participation-gates design (Decisions 6–7) — referenced
 * by intent, not embedded here.
 *
 * @module
 */

import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_ROLE_NOT_WEB_GRANTABLE,
} from '$lib/http/error_schemas.ts';
import {
	ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH,
	ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED,
	ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE,
} from '$lib/auth/role_grant_offer_action_specs.ts';
import {ROLE_KEEPER} from '$lib/auth/role_schema.ts';
import {SPINE_PARTICIPANT_ROLE} from '$lib/testing/cross_backend/spine_surface_constants.ts';
import type {ConformanceCase} from '$lib/testing/cross_backend/conformance_case.ts';

/**
 * `extra_accounts` username the participation suite seeds holding
 * `SPINE_PARTICIPANT_ROLE` — the `role_holder` principal. The wiring names it
 * via `principals.role_holder` and declares the seed at setup.
 */
export const PARTICIPATION_HOLDER_USERNAME = 'participation_holder';

/** A well-formed UUID that never names a real account — exercises the past-the-gate arm. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** A distinct well-formed (v4-shaped) UUID for an actor that never belongs to `NIL_UUID`. */
const STRANGER_ACTOR_UUID = '11111111-1111-4111-8111-111111111111';

/** A role string deliberately absent from the registry. */
const UNREGISTERED_ROLE = 'not_a_registered_role';

export const conformance_participation_cases: ReadonlyArray<ConformanceCase> = [
	// -- (a) grantability ----------------------------------------------------
	{
		name: 'admin assign of participant passes the grant-path gate (404 past it)',
		request: {
			method: 'role_grant_assign',
			as: 'keeper',
			params: {to_account_id: NIL_UUID, role: SPINE_PARTICIPANT_ROLE},
		},
		// Past the admin-grant-path gate (participant IS admin-grantable on both
		// spines), the handler resolves the target actor and 404s on the
		// nonexistent account — proving the gate admitted the app role. Pairs
		// with the keeper/unregistered 403 cases below: same nil account,
		// grantable role → 404, non-grantable role → 403.
		expect: {status: 404},
		note: 'app-defined role is admin-grantable on both spines (gate-pass, account-404)',
	},
	{
		name: 'admin assign with a foreign to_actor_id is refused (actor-account mismatch)',
		request: {
			method: 'role_grant_assign',
			as: 'keeper',
			params: {
				to_account_id: NIL_UUID,
				to_actor_id: STRANGER_ACTOR_UUID,
				role: SPINE_PARTICIPANT_ROLE,
			},
		},
		// A named `to_actor_id` must belong to `to_account_id`; one that doesn't
		// (here, any actor against the empty nil account) is rejected before the
		// write — the target-resolution validation arm, identical on both spines.
		expect: {status: 400, error_reason: ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH},
		note: 'to_actor_id must belong to to_account_id (assign target resolution)',
	},
	{
		name: 'admin assign of a non-grantable role (keeper) refused at the gate',
		request: {
			method: 'role_grant_assign',
			as: 'keeper',
			params: {to_account_id: NIL_UUID, role: ROLE_KEEPER},
		},
		// keeper carries the bootstrap grant path only — never web-grantable, so
		// the gate refuses before account resolution (contrast the 404 above).
		expect: {status: 403, error_reason: ERROR_ROLE_NOT_WEB_GRANTABLE},
		note: 'bootstrap-only role is not web-assignable on either spine',
	},
	{
		name: 'admin assign of an unregistered role refused at the gate',
		request: {
			method: 'role_grant_assign',
			as: 'keeper',
			params: {to_account_id: NIL_UUID, role: UNREGISTERED_ROLE},
		},
		expect: {status: 403, error_reason: ERROR_ROLE_NOT_WEB_GRANTABLE},
		note: 'a role outside the registry is rejected identically on both spines',
	},
	{
		name: 'admin offer of a non-grantable role (keeper) refused at the grant-path gate',
		request: {
			method: 'role_grant_offer_create',
			as: 'keeper',
			params: {to_account_id: NIL_UUID, role: ROLE_KEEPER},
		},
		// The offer verb runs the SAME registry grant-path gate as assign
		// (grantability was widened for both conferral paths); keeper carries no
		// admin grant path, so the offer is refused at the gate too — proving the
		// gate is consistent across offer + assign on both spines. Distinct reason
		// from assign's `role_not_web_grantable` (`role_grant_offer_role_not_grantable`).
		expect: {status: 403, error_reason: ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE},
		note: 'offer grant-path gate matches the assign gate (Seam 1 grantability)',
	},

	// -- (b) admin-only conferral (no holder-propagation) --------------------
	{
		name: 'non-admin holder of participant cannot offer it',
		request: {
			method: 'role_grant_offer_create',
			as: 'role_holder',
			params: {to_account_id: NIL_UUID, role: SPINE_PARTICIPANT_ROLE},
		},
		// Holding `participant` confers no power to confer it — the admin-only
		// default authorizer denies the holder after the grant-path gate passes.
		expect: {status: 403, error_reason: ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED},
		note: 'no holder-propagation — only admins confer (Decision 6)',
	},
	{
		name: 'fresh non-admin cannot offer participant',
		request: {
			method: 'role_grant_offer_create',
			as: 'fresh_non_admin',
			params: {to_account_id: NIL_UUID, role: SPINE_PARTICIPANT_ROLE},
		},
		expect: {status: 403, error_reason: ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED},
		note: 'a no-role account cannot confer the app role on either spine',
	},

	// -- (c) role_grant_assign is admin-only (dispatcher gate) ---------------
	{
		name: 'non-admin holder cannot assign participant (dispatcher admin gate)',
		request: {
			method: 'role_grant_assign',
			as: 'role_holder',
			params: {to_account_id: NIL_UUID, role: SPINE_PARTICIPANT_ROLE},
		},
		// Distinct from the gate-403 above: this is the dispatcher `roles:
		// ['admin']` gate (insufficient_permissions), proving holding the role
		// does not unlock the immediate-assign path.
		expect: {status: 403, error_reason: ERROR_INSUFFICIENT_PERMISSIONS},
		note: 'role_grant_assign is admin-gated at the dispatcher on both spines',
	},
	{
		name: 'fresh non-admin cannot assign participant (dispatcher admin gate)',
		request: {
			method: 'role_grant_assign',
			as: 'fresh_non_admin',
			params: {to_account_id: NIL_UUID, role: SPINE_PARTICIPANT_ROLE},
		},
		expect: {status: 403, error_reason: ERROR_INSUFFICIENT_PERMISSIONS},
		note: 'no-role account refused at the dispatcher on both spines',
	},
	{
		name: 'anonymous cannot assign participant',
		request: {
			method: 'role_grant_assign',
			as: 'anonymous',
			params: {to_account_id: NIL_UUID, role: SPINE_PARTICIPANT_ROLE},
		},
		expect: {status: 401, error_reason: ERROR_AUTHENTICATION_REQUIRED},
		note: 'role_grant_assign rejects an unauthenticated caller on both spines',
	},
];
