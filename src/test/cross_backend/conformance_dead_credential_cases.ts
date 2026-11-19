/**
 * Dead-credential conformance cases, and the session cookie's positive
 * controls.
 *
 * Each dead credential — a tampered cookie, a daemon token or API token that
 * is not the server's, a revoked session, a revoked or expired API token — is
 * presented alone against an authenticated RPC read and mutation, and the
 * REST routes behind `require_auth` that both spines serve (`GET /verify` is
 * the TS spine's alone — the Rust account router doesn't mount it — so its
 * rows are `conformance_verify_cases.ts`, run on the TS spines only). Each must be refused exactly as sending no credential is: the
 * same 401 and a byte-identical body, so a prober can't tell a dead
 * credential from none, nor one kind of dead credential from another. Every
 * row for a target shares one `equivalence_group` with an `anonymous` row for
 * it — the RPC rows the generated anonymous group
 * (`RPC_AUTH_ANONYMOUS_EQUIVALENCE_GROUP`, so a leg running these runs the
 * generated rows too), whose 401 is already held identical across every
 * method; the REST rows a group per route, beside an `anonymous` row here.
 *
 * The session cookie's effect is pinned on every row (`expect.set_cookie`,
 * omitted meaning none): the tampered cookie is present and fails
 * verification, so its refusal also clears it; the revoked session's cookie
 * still verifies, so nothing clears it; no other dead credential is a cookie.
 * The controls show the axis is not vacuous: a login mints, a logout clears,
 * and a login carrying a tampered cookie clears it and then mints.
 *
 * @module
 */

import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INVALID_CREDENTIALS
} from '#lib/http/error_schemas.ts';
import { DEFAULT_TEST_PASSWORD } from '#lib/testing/test_credentials.ts';
import type {
	ConformanceCase,
	ConformanceCaseRequest,
	ConformancePrincipal
} from '#lib/testing/cross_backend/conformance_case.ts';
import { RPC_AUTH_ANONYMOUS_EQUIVALENCE_GROUP } from '#lib/testing/cross_backend/conformance_rpc_auth.ts';

/** A dead credential: what its refusal does to the session cookie, and why it is refused. */
interface DeadPrincipal {
	readonly as: ConformancePrincipal;
	readonly set_cookie: 'none' | 'clear';
	readonly note: string;
}

const DEAD_PRINCIPALS: ReadonlyArray<DeadPrincipal> = [
	{
		as: 'tampered_cookie',
		set_cookie: 'clear',
		note: 'security.md §Session Security — a session cookie that fails verification is no credential, and the response clears it'
	},
	{
		as: 'wrong_daemon',
		set_cookie: 'none',
		note: "a well-shaped daemon token that is not the server's is discarded, leaving the request as one with no credential"
	},
	{
		as: 'unknown_bearer',
		set_cookie: 'none',
		note: 'a well-shaped API token no row matches is no credential'
	},
	{
		as: 'revoked_session',
		set_cookie: 'none',
		note: 'security.md §Session Security — sessions are server-side; a revoked session no longer authenticates, though its cookie still verifies and so is not cleared'
	},
	{
		as: 'revoked_token',
		set_cookie: 'none',
		note: 'security.md §API Token Security — a revoked API token no longer authenticates'
	},
	{
		as: 'expired_token',
		set_cookie: 'none',
		note: 'security.md §API Token Security — an API token past its expires_at no longer authenticates'
	}
];

/** A target that reads a credential: what is sent, and the group its 401s share. */
export interface DeadCredentialTarget {
	readonly label: string;
	readonly request: Omit<ConformanceCaseRequest, 'as'>;
	readonly equivalence_group: string;
	/**
	 * Whether the rows include an `anonymous` member of the group; the RPC
	 * targets' group already holds the generated anonymous rows.
	 */
	readonly anonymous_row: boolean;
}

/**
 * The rows for one target: every dead credential refused 401 as anonymous is,
 * in one `equivalence_group`, and the target's `anonymous` row when it has one.
 *
 * @param target - the request and the group its 401s share
 */
export const create_dead_credential_rows = (
	target: DeadCredentialTarget
): Array<ConformanceCase> => [
	...(target.anonymous_row
		? [
				{
					name: `anonymous → ${target.label} → 401 (the dead credentials' baseline)`,
					request: { ...target.request, as: 'anonymous' },
					expect: {
						status: 401,
						error_reason: ERROR_AUTHENTICATION_REQUIRED,
						equivalence_group: target.equivalence_group
					}
				} satisfies ConformanceCase
			]
		: []),
	...DEAD_PRINCIPALS.map(({ as, set_cookie, note }): ConformanceCase => ({
		name: `${as} → ${target.label} → 401, as anonymous`,
		request: { ...target.request, as },
		expect: {
			status: 401,
			error_reason: ERROR_AUTHENTICATION_REQUIRED,
			equivalence_group: target.equivalence_group,
			...(set_cookie !== 'none' && { set_cookie })
		},
		note
	}))
];

const DEAD_CREDENTIAL_TARGETS: ReadonlyArray<DeadCredentialTarget> = [
	{
		label: 'account_verify (RPC read)',
		request: { method: 'account_verify' },
		equivalence_group: RPC_AUTH_ANONYMOUS_EQUIVALENCE_GROUP,
		anonymous_row: false
	},
	{
		label: 'account_token_create (RPC mutation)',
		request: {
			method: 'account_token_create',
			params: { scope: { kind: 'full' }, lifetime: { kind: 'eternal' } }
		},
		equivalence_group: RPC_AUTH_ANONYMOUS_EQUIVALENCE_GROUP,
		anonymous_row: false
	},
	{
		label: 'POST /logout',
		request: { method: '/logout' },
		equivalence_group: 'dead_credential_logout_401',
		anonymous_row: true
	},
	{
		label: 'POST /password',
		request: {
			method: '/password',
			params: {
				current_password: DEFAULT_TEST_PASSWORD,
				new_password: 'a-new-password-long-enough'
			}
		},
		equivalence_group: 'dead_credential_password_401',
		anonymous_row: true
	}
];

const dead_credential_rows: ReadonlyArray<ConformanceCase> = DEAD_CREDENTIAL_TARGETS.flatMap(
	create_dead_credential_rows
);

/** The positive controls: the effects the dead rows' `'none'` would otherwise only ever pin absent. */
const session_cookie_control_rows: ReadonlyArray<ConformanceCase> = [
	{
		name: 'keeper login → 200, mints the session cookie',
		request: {
			method: '/login',
			as: 'anonymous',
			params: { username: 'keeper', password: DEFAULT_TEST_PASSWORD }
		},
		expect: { status: 200, set_cookie: 'set' }
	},
	{
		name: 'keeper login carrying a tampered cookie → 200, clears it then mints',
		request: {
			method: '/login',
			as: 'tampered_cookie',
			params: { username: 'keeper', password: DEFAULT_TEST_PASSWORD }
		},
		expect: { status: 200, set_cookie: 'clear_then_set' }
	},
	{
		name: 'login wrong password carrying a tampered cookie → 401 invalid_credentials, clears it and mints nothing',
		request: {
			method: '/login',
			as: 'tampered_cookie',
			params: { username: 'keeper', password: 'wrong-password-not-the-real-one' }
		},
		expect: {
			status: 401,
			error_reason: ERROR_INVALID_CREDENTIALS,
			equivalence_group: 'login_enumeration_shadow',
			set_cookie: 'clear'
		}
	},
	{
		name: 'keeper logout → 200, clears the session cookie',
		request: { method: '/logout', as: 'keeper' },
		expect: { status: 200, set_cookie: 'clear' }
	}
];

export const conformance_dead_credential_cases: ReadonlyArray<ConformanceCase> = [
	...dead_credential_rows,
	...session_cookie_control_rows
];
