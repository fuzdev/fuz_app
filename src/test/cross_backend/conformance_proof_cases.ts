/**
 * Runner-proof cases for the declarative conformance table.
 *
 * These are existing **passing** real-resolution negatives/positives
 * expressed as conformance rows, pinning that
 * `describe_conformance_table_tests` drives the same green both in-process
 * (`gro test`) and cross-process (the conformance gate). They deliberately
 * target `admin_account_list` (admin-gated RPC, on every spine surface) to
 * exercise the three runner branches: error-without-reason (401),
 * error-with-reason (403), and success + output validation (200).
 *
 * These validate the runner, not security behavior — the opinionated
 * security matrix (credential ceiling, IDOR masks, enumeration) lives in
 * its own rows.
 *
 * @module
 */

import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
} from '$lib/http/error_schemas.js';
import type {ConformanceCase} from '$lib/testing/cross_backend/conformance_case.js';

export const conformance_proof_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'anonymous → admin_account_list → 401',
		request: {method: 'admin_account_list', as: 'anonymous'},
		// The pre-validation 401 carries `data.reason = authentication_required`
		// on both spines, so the runner asserts the reason, not just the status.
		expect: {status: 401, error_reason: ERROR_AUTHENTICATION_REQUIRED},
		note: 'protected RPC method rejects an unauthenticated caller',
	},
	{
		name: 'fresh non-admin → admin_account_list → 403',
		request: {method: 'admin_account_list', as: 'fresh_non_admin'},
		expect: {status: 403, error_reason: ERROR_INSUFFICIENT_PERMISSIONS},
		note: 'admin-gated RPC method rejects an authenticated non-admin',
	},
	{
		name: 'keeper → admin_account_list → 200',
		request: {method: 'admin_account_list', as: 'keeper'},
		expect: {status: 200},
		note: 'admin holder lists accounts; result validates against admin_account_list output',
	},
];
