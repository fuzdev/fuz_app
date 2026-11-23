import '../assert_dev_env.ts';

/**
 * The conformance principals' credentials: how each `ConformancePrincipal`
 * resolves onto the transport and headers it sends with, read from the
 * per-test `TestFixture` — the table (`describe_conformance_table_tests`)
 * and the suites that send a principal's requests themselves
 * (`describe_rpc_adversarial_cross_tests`). Its own module, apart from the
 * table's WebSocket leg, so a suite resolving principals over HTTP reaches
 * no socket transport.
 *
 * @module
 */

import { DAEMON_TOKEN_HEADER, is_daemon_token_shaped } from '../../auth/daemon_token.ts';
import { API_TOKEN_PREFIX, is_api_token_shaped } from '../../auth/api_token.ts';
import { account_token_create_action_spec } from '../../auth/account_action_specs.ts';
import { find_rpc_action, type resolve_rpc_endpoints_for_setup } from '../rpc_helpers.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
import { SCOPED_TOKEN_ADMITTED_METHOD, type ConformancePrincipal } from './conformance_case.ts';
import { assert_credential_authenticates, type TestFixture } from './setup.ts';
import { mint_narrowed_api_token } from './narrowed_api_token.ts';

/**
 * Names a seeded `extra_accounts` username for the `role_holder` /
 * `wrong_role` principals — the only two that aren't backed by an
 * always-available fixture accessor. Suites exercising those principals
 * declare the matching `extra_accounts` at setup and name them here.
 */
export interface ConformancePrincipalConfig {
	/** `extra_accounts` username for the `role_holder` principal. */
	readonly role_holder?: string;
	/** `extra_accounts` username for the `wrong_role` principal. */
	readonly wrong_role?: string;
}

/** A resolved principal: the transport + headers a case fires through. */
export interface ResolvedConformancePrincipal {
	readonly transport: FetchTransport;
	readonly headers: Record<string, string>;
	/**
	 * Suppress the default `Origin` header on the request. Required for
	 * non-browser credential probes (bearer / daemon) — `bearer_auth`
	 * discards the token when `Origin` / `Referer` is present.
	 */
	readonly suppress_default_origin?: boolean;
	/**
	 * The actor of the account the credential names — what the `principal`
	 * acting binding writes. Absent for principals that present no account.
	 */
	readonly actor_id?: string;
}

/**
 * A deliberately malformed `X-Daemon-Token` value for the `invalid_daemon`
 * principal. Fails the `DaemonToken` schema (not 43 base64url chars), so
 * the daemon-token middleware soft-fail-discards it rather than authenticating
 * — the request falls through with no identity, surfacing
 * `credential_type_required` on a daemon-gated action (matching the Rust
 * spine's `None`). Sent over a no-Origin transport so it lands on the
 * invalid-token path, not the browser-context discard.
 */
const INVALID_DAEMON_TOKEN_VALUE = 'not-a-valid-daemon-token';

/**
 * The `wrong_daemon` principal's token: well-shaped (43 base64url characters),
 * so it passes the shape precheck and is refused by the compare — never the
 * server's, whose tokens are random.
 */
const WRONG_DAEMON_TOKEN_VALUE = 'A'.repeat(43);

/**
 * The `unknown_bearer` principal's token: well-shaped (the prefix and 43
 * base64url characters), so it costs the lookup no row answers.
 */
const UNKNOWN_BEARER_TOKEN_VALUE = `${API_TOKEN_PREFIX}${'A'.repeat(43)}`;

if (!is_daemon_token_shaped(WRONG_DAEMON_TOKEN_VALUE)) {
	throw new Error('conformance: WRONG_DAEMON_TOKEN_VALUE must be daemon-token-shaped');
}
if (!is_api_token_shaped(UNKNOWN_BEARER_TOKEN_VALUE)) {
	throw new Error('conformance: UNKNOWN_BEARER_TOKEN_VALUE must be api-token-shaped');
}

/**
 * The keeper's session cookie with its MAC corrupted: the first character of
 * the signature (after the last `.`) changed, so the signature keeps its
 * shape and the keyring refuses it on the compare, not the shape check.
 */
const tamper_session_cookie = (cookie: string): string => {
	const dot = cookie.lastIndexOf('.');
	const first = cookie[dot + 1];
	if (dot === -1 || first === undefined) {
		throw new Error(`conformance: principal 'tampered_cookie' found no signed session cookie`);
	}
	return `${cookie.slice(0, dot + 1)}${first === 'A' ? 'B' : 'A'}${cookie.slice(dot + 2)}`;
};

/** A dead bearer presented alone: no cookie, no `Origin`, so the token is looked up. */
const as_lone_bearer = (fixture: TestFixture, token: string): ResolvedConformancePrincipal => ({
	transport: fixture.fresh_transport({ origin: null }),
	headers: { authorization: `Bearer ${token}` },
	suppress_default_origin: true
});

/**
 * Mint the `scoped_token` principal's narrowed bearer token over the
 * production `account_token_create` path.
 *
 * Minted rather than seeded, and minted *here* rather than in a case. The
 * seed stays `full` because `_testing_reset`'s api token backs every other
 * bearer principal, and a case that minted its own credential would be the
 * setup-DSL trap the case schema exists to avoid.
 *
 * `account_token_create` is session-only, so this runs over the keeper's
 * session — which also makes the mint itself a live assertion that a narrowed
 * scope is *accepted* at the mint boundary, not merely stored.
 *
 * The token is then proven to authenticate as the keeper, alone, on the method
 * it admits (`assert_credential_authenticates`), so every case sent as the
 * principal rests on a working credential of the expected account: a refusal
 * can only be its scope or its channel, never a token that authenticates as
 * no one or as another account.
 */
const mint_scoped_token = async (
	fixture: TestFixture,
	resolved_rpc_endpoints: ReturnType<typeof resolve_rpc_endpoints_for_setup>
): Promise<string> => {
	const found = find_rpc_action(resolved_rpc_endpoints, account_token_create_action_spec.method);
	if (!found) {
		throw new Error(
			`conformance: principal 'scoped_token' needs '${account_token_create_action_spec.method}' ` +
				`on the surface to mint its narrowed token, but the method is not registered on ` +
				`rpc_endpoints.`
		);
	}
	const admitted = find_rpc_action(resolved_rpc_endpoints, SCOPED_TOKEN_ADMITTED_METHOD);
	if (!admitted) {
		throw new Error(
			`conformance: principal 'scoped_token' needs '${SCOPED_TOKEN_ADMITTED_METHOD}' on the ` +
				`surface to prove its narrowed token live, but the method is not registered on ` +
				`rpc_endpoints.`
		);
	}
	const token = await mint_narrowed_api_token({
		app: fixture.transport,
		rpc_path: found.path,
		session_headers: fixture.create_session_headers(),
		methods: [SCOPED_TOKEN_ADMITTED_METHOD],
		name: 'conformance scoped token'
	});
	await assert_credential_authenticates({
		transport: fixture.fresh_transport({ origin: null }),
		rpc_path: admitted.path,
		headers: { authorization: `Bearer ${token}` },
		account_id: fixture.account.id,
		accessor: 'scoped_token'
	});
	return token;
};

/**
 * Map a `ConformancePrincipal` onto the transport + headers it
 * authenticates with, reading exclusively from the per-test `TestFixture`.
 *
 * The always-available principals resolve from fixture accessors (the dead
 * credentials that need a server-side state — a revoked session or token, an
 * expired token — from the fixture's `mint_*` seams); `role_holder` /
 * `wrong_role` read a seeded `extra_accounts` entry named via
 * `options.principals` (throws a clear setup error when unconfigured);
 * `scoped_token` mints its narrowed credential over the production path.
 * Also used outside the table by suites that send a principal's requests
 * themselves (`describe_rpc_adversarial_cross_tests`).
 *
 * @param fixture - the per-test fixture
 * @param as - the principal
 * @param principals - usernames for `role_holder` / `wrong_role`
 * @param resolved_rpc_endpoints - the endpoints `scoped_token` mints through
 * @returns the transport and headers the principal sends with
 */
export const resolve_conformance_principal = async (
	fixture: TestFixture,
	as: ConformancePrincipal,
	principals?: ConformancePrincipalConfig,
	resolved_rpc_endpoints: ReturnType<typeof resolve_rpc_endpoints_for_setup> = []
): Promise<ResolvedConformancePrincipal> => {
	switch (as) {
		case 'keeper':
			// Keeper carries its session cookie via `create_session_headers`
			// (in-process the transport is stateless; cross-process the jar
			// also holds it — the explicit header is the same value).
			return {
				transport: fixture.transport,
				headers: fixture.create_session_headers(),
				actor_id: fixture.actor.id
			};
		case 'daemon':
			// Daemon-token is a non-browser credential — empty jar + no Origin.
			return {
				transport: fixture.fresh_transport({ origin: null }),
				headers: fixture.create_daemon_token_headers(),
				suppress_default_origin: true,
				actor_id: fixture.actor.id
			};
		case 'invalid_daemon':
			// A malformed `X-Daemon-Token` carried ALONGSIDE the keeper's session
			// cookie, over a non-browser (no-Origin) transport. The invalid daemon
			// token is soft-fail-discarded (matching the Rust spine's `None`), so
			// auth falls through to the session leg: the request authenticates as
			// the keeper-via-session (clearing `require_auth`), then the daemon-gated
			// action's credential-type gate refuses the session credential →
			// `403 credential_type_required`. No-Origin keeps the daemon token on
			// the invalid-token path, NOT the browser-context discard. Without the
			// base credential this would 401 (anonymous) — the session is what makes
			// the *credential-type* gate, not the auth gate, the refusing layer.
			return {
				transport: fixture.fresh_transport({ origin: null }),
				headers: fixture.create_session_headers({
					[DAEMON_TOKEN_HEADER]: INVALID_DAEMON_TOKEN_VALUE
				}),
				suppress_default_origin: true,
				actor_id: fixture.actor.id
			};
		case 'daemon_browser':
			// A VALID `X-Daemon-Token` carried in a browser context (default Origin
			// present) ALONGSIDE the keeper's session cookie. The daemon-token
			// middleware discards a header-bearing daemon token as browser context
			// (mirroring the bearer guard + the Rust spine's `is_browser_context`),
			// so the valid token is dropped and auth falls through to the session
			// leg → keeper-via-session → a daemon-gated action refuses the session
			// credential with `credential_type_required`. Origin is NOT suppressed —
			// its presence is the browser-context signal under test. Unlike the
			// `daemon` principal (no Origin → token honored → reaches the 400 confirm
			// guard), the 403 here proves the valid token was discarded, not honored.
			return {
				transport: fixture.transport,
				headers: fixture.create_session_headers(fixture.create_daemon_token_headers()),
				actor_id: fixture.actor.id
			};
		case 'token':
			// Bearer is discarded in a browser context — empty jar + no Origin.
			return {
				transport: fixture.fresh_transport({ origin: null }),
				headers: fixture.create_bearer_headers(),
				suppress_default_origin: true,
				actor_id: fixture.actor.id
			};
		case 'bearer_browser':
			// A VALID bearer api-token in a browser context (default Origin
			// present), fresh jar so no session rides alongside. The bearer
			// middleware discards a header-bearing token as browser context
			// (mirroring the daemon guard + the Rust spine's `is_browser_context`),
			// so the request arrives anonymous → an authed action 401s. Origin is
			// NOT suppressed (its presence is the browser-context signal) — the
			// inverse of the `token` principal, which suppresses it so the same
			// token is honored. The 401 proves the valid token was discarded, not
			// honored (a non-discarding leg would authenticate → 200).
			return {
				transport: fixture.fresh_transport(),
				headers: fixture.create_bearer_headers()
			};
		case 'malformed_bearer': {
			// The keeper's valid token minus its last character — prefixed, one char
			// short — over the same no-Origin, empty-jar transport as `token`, so the
			// shape precheck (not the browser-context discard) is what refuses it.
			const valid = fixture.create_bearer_headers().authorization;
			if (!valid)
				throw new Error(`conformance: principal 'malformed_bearer' found no bearer header`);
			return {
				transport: fixture.fresh_transport({ origin: null }),
				headers: { authorization: valid.slice(0, -1) },
				suppress_default_origin: true
			};
		}
		case 'scoped_token': {
			// A narrowed bearer, otherwise identical to `token` — empty jar + no
			// Origin, so the credential is honored rather than browser-discarded
			// and the scope gate is what any denial comes from.
			const token = await mint_scoped_token(fixture, resolved_rpc_endpoints);
			return {
				transport: fixture.fresh_transport({ origin: null }),
				headers: { authorization: `Bearer ${token}` },
				suppress_default_origin: true,
				actor_id: fixture.actor.id
			};
		}
		case 'anonymous':
			// Fresh jar so the keeper cookie (cross-process) can't leak in.
			return { transport: fixture.fresh_transport(), headers: {} };
		case 'fresh_non_admin': {
			const account = await fixture.create_account();
			return {
				transport: fixture.fresh_transport(),
				headers: account.create_session_headers(),
				actor_id: account.actor.id
			};
		}
		case 'expired_session': {
			// The keeper presented via an expired server-side session — fresh
			// jar so only the (expired) cookie this seam returns is sent. The
			// minted cookie payload is valid; the backdated `auth_session` row
			// is what the DB-row expiry gate refuses.
			const cookie = await fixture.mint_expired_session();
			return {
				transport: fixture.fresh_transport(),
				headers: { cookie },
				actor_id: fixture.actor.id
			};
		}
		case 'tampered_cookie': {
			// fresh jar, so the tampered cookie is the only one sent
			const { cookie } = fixture.create_session_headers();
			if (!cookie) throw new Error(`conformance: principal 'tampered_cookie' found no cookie`);
			return {
				transport: fixture.fresh_transport(),
				headers: { cookie: tamper_session_cookie(cookie) }
			};
		}
		case 'wrong_daemon':
			// no Origin, so the token reaches the compare, not the browser-context discard
			return {
				transport: fixture.fresh_transport({ origin: null }),
				headers: { [DAEMON_TOKEN_HEADER]: WRONG_DAEMON_TOKEN_VALUE },
				suppress_default_origin: true
			};
		case 'unknown_bearer':
			return as_lone_bearer(fixture, UNKNOWN_BEARER_TOKEN_VALUE);
		case 'revoked_session':
			return {
				transport: fixture.fresh_transport(),
				headers: { cookie: await fixture.mint_revoked_session() }
			};
		case 'revoked_token':
			return as_lone_bearer(fixture, await fixture.mint_revoked_token());
		case 'expired_token':
			return as_lone_bearer(fixture, await fixture.mint_expired_token());
		case 'role_holder':
		case 'wrong_role': {
			const username = principals?.[as];
			if (!username) {
				throw new Error(
					`conformance: principal '${as}' requires options.principals.${as} naming a seeded ` +
						`extra_accounts username (declare the account at setup via extra_accounts).`
				);
			}
			const extra = fixture.extra_accounts[username];
			if (!extra) {
				throw new Error(
					`conformance: extra_accounts['${username}'] not seeded for principal '${as}' — ` +
						`declare it in the suite's extra_accounts option.`
				);
			}
			return {
				transport: fixture.fresh_transport(),
				headers: extra.create_session_headers(),
				actor_id: extra.actor.id
			};
		}
	}
};
