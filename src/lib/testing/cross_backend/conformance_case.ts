import '../assert_dev_env.ts';

/**
 * Declarative conformance-case schema for the cross-backend behavioral +
 * security suite.
 *
 * A conformance case is a single request → expected-response assertion,
 * carried as **data**. The case references a `method` (an RPC method name
 * or a REST auth-route suffix); the runner
 * (`describe_conformance_table_tests`) resolves the `input` / `output`
 * schemas from the live action-spec registry / `RouteSpec` — the case
 * never carries a schema. This is the opinionated behavioral/security
 * layer on top of the spec-derived auto-enumeration
 * (`describe_rpc_round_trip_tests` / `describe_rpc_attack_surface_tests`):
 * the same case definition runs in-process (fast, every `gro test`) and
 * cross-process (the conformance gate) against each impl's real auth
 * resolution.
 *
 * The table is for single-request matrices (credential-type ceiling,
 * privilege gates, IDOR masks, enumeration-equivalence, validation).
 * Multi-step flows stay imperative in their own `describe_*` suites,
 * sharing assertion primitives — there is deliberately no declarative
 * setup DSL.
 *
 * @module
 */

import type { JsonrpcErrorCode } from '../../http/jsonrpc.ts';
import type { XfailMarker } from './xfail.ts';
import type { SessionCookieEffect } from './session_cookie_effect.ts';

/**
 * Closed enum of fixture-provisioned principals a case runs `as`. Each
 * value maps to a `TestFixture` accessor (or a seeded `extra_accounts`
 * entry) in the runner's `resolve_conformance_principal` — there is **no** inline
 * credential minting in a case (that would be the setup-DSL trap).
 *
 * - `keeper` — the per-test bootstrapped keeper (holds `ROLE_KEEPER` +
 *   `ROLE_ADMIN`), session credential.
 * - `daemon` — the keeper authenticated via the daemon-token header.
 * - `invalid_daemon` — a *malformed/invalid* `X-Daemon-Token` carried
 *   alongside the keeper's session cookie, over a non-browser (no-Origin)
 *   transport. The middleware soft-fail-discards the invalid daemon token
 *   (matching the Rust spine's `None`), so auth falls through to the session
 *   leg: the request authenticates as the keeper-via-session and a
 *   daemon-gated action then refuses the session credential with
 *   `credential_type_required` — not a hard `invalid_daemon_token` 401. The
 *   no-Origin transport keeps the daemon token on the invalid-token path
 *   rather than the browser-context discard; the session base credential is
 *   what makes the credential-type gate (not the auth gate) the refusing
 *   layer (without it the discard would 401 anonymous).
 * - `daemon_browser` — a *valid* `X-Daemon-Token` carried in a browser
 *   context (default `Origin` present) alongside the keeper's session cookie.
 *   Browsers attach `Origin` automatically; the daemon-token middleware
 *   discards a header-bearing daemon token as browser context (mirroring the
 *   bearer guard and the Rust spine's `is_browser_context`), so the *valid*
 *   token is dropped and auth falls through to the session leg → a daemon-gated
 *   action then refuses the session credential with `credential_type_required`.
 *   Distinct from `invalid_daemon`: here the token is well-formed and current,
 *   so a 403 (not a 400 confirm-guard hit like `daemon`) proves the
 *   browser-context discard fired — a valid daemon token does NOT authenticate
 *   when an `Origin` is present. `Origin` is deliberately NOT suppressed; its
 *   presence is the signal under test.
 * - `token` — the keeper authenticated via a bearer api-token (non-browser
 *   context; the runner suppresses `Origin` so the token isn't discarded).
 * - `bearer_browser` — a *valid* bearer api-token carried in a browser context
 *   (default `Origin` present), fresh jar so NO session rides alongside. The
 *   bearer middleware discards the token as browser context (mirroring the
 *   daemon guard + the Rust spine's `is_browser_context`), so the request
 *   arrives anonymous and an authed action 401s. Proves a stolen bearer cannot
 *   be replayed from a browser — wire-indistinguishable from sending no
 *   credential (the `token` principal is the honored counterpart: it suppresses
 *   `Origin`, so the same token authenticates).
 * - `malformed_bearer` — the keeper's bearer api-token with its last character
 *   dropped, non-browser context, fresh jar. A value that cannot be a token
 *   fails each spine's shape precheck and soft-fails before any database work,
 *   so the request arrives anonymous — wire-indistinguishable from sending no
 *   credential.
 * - `scoped_token` — the keeper authenticated via a bearer api-token minted
 *   with a **narrowed** `TokenScope` (`{kind: 'methods', methods:
 *   [SCOPED_TOKEN_ADMITTED_METHOD]}`), non-browser context. Minted through the
 *   production `account_token_create` path over the keeper's session, not
 *   seeded — `_testing_reset` deliberately seeds a `full` token, and a harness
 *   that narrowed the seed would silently re-scope every other bearer case —
 *   and proven to authenticate as the keeper on `SCOPED_TOKEN_ADMITTED_METHOD`
 *   before any case is sent as it. The scope gate sits between the credential gate and the role gate, so this
 *   principal is what distinguishes `token_scope_required` from the
 *   credential-type and role denials on either side of it.
 * - `anonymous` — no credential, fresh cookie jar.
 * - `fresh_non_admin` — a freshly minted account with no roles, session
 *   credential (via the production invite → signup → login flow).
 * - `role_holder` — a seeded `extra_accounts` principal holding a specific
 *   role; the runner reads it by the username named in
 *   `ConformanceTableOptions.principals.role_holder`.
 * - `wrong_role` — a seeded `extra_accounts` principal holding a role
 *   other than the one a route requires; named via
 *   `ConformanceTableOptions.principals.wrong_role`.
 * - `expired_session` — the keeper account presented via an *expired
 *   server-side session* cookie (minted by `fixture.mint_expired_session()`:
 *   a backdated `auth_session` row behind a still-valid signed cookie
 *   payload, so the authoritative DB-row expiry gate is what refuses it).
 *
 * The dead credentials — each presented alone, on a fresh jar, so the request
 * carries that credential and nothing else; each arrives anonymous, so a row
 * pins the refusal anonymous gets on its target, byte for byte:
 *
 * - `tampered_cookie` — the keeper's session cookie with its MAC corrupted
 *   (the first character of the signature changed, the signature still
 *   well-shaped): present and invalid, so besides refusing it the response
 *   clears the cookie (`expect.set_cookie: 'clear'`).
 * - `wrong_daemon` — a well-shaped daemon token (43 base64url characters) that
 *   is not the server's, with no `Origin`, so it reaches the token compare
 *   rather than the browser-context discard.
 * - `unknown_bearer` — a well-shaped API token (`secret_fuz_token_` + 43
 *   base64url characters) no row matches, with no `Origin`.
 * - `revoked_session` — a session cookie that verifies, whose `auth_session`
 *   row has been revoked (`fixture.mint_revoked_session()`). The cookie alone
 *   shows nothing wrong, so it is not cleared.
 * - `revoked_token` — an API token that was minted and then revoked
 *   (`fixture.mint_revoked_token()`), with no `Origin`.
 * - `expired_token` — an API token whose row is past its `expires_at`
 *   (`fixture.mint_expired_token()`), with no `Origin`.
 */
export type ConformancePrincipal =
	| 'keeper'
	| 'daemon'
	| 'invalid_daemon'
	| 'daemon_browser'
	| 'token'
	| 'bearer_browser'
	| 'malformed_bearer'
	| 'scoped_token'
	| 'anonymous'
	| 'fresh_non_admin'
	| 'role_holder'
	| 'wrong_role'
	| 'expired_session'
	| 'tampered_cookie'
	| 'wrong_daemon'
	| 'unknown_bearer'
	| 'revoked_session'
	| 'revoked_token'
	| 'expired_token';

/**
 * The single RPC method the `scoped_token` principal's narrowed token admits.
 *
 * Part of the principal's contract, so the runner (which mints the token) and
 * the cases (which assert the denials) agree on one value. `account_verify` is
 * the minimal `credential_types: any` read on the spine: it clears the
 * credential gate a bearer must pass first, and holds no role gate that could
 * shadow the scope denial — so a case naming any *other* method isolates the
 * scope gate and nothing else.
 *
 * It is also the method the principal's liveness proof sends
 * (`assert_credential_authenticates` calls `account_verify_action_spec`), so
 * the narrowed token can be proven live only while the two are one method.
 */
export const SCOPED_TOKEN_ADMITTED_METHOD = 'account_verify';

/**
 * Which actor the runner writes into a case's `params.acting` at run time.
 *
 * An actor id exists only once a fixture has seeded it, so a case names the
 * actor by its relation to the fixture and the runner fills in the id:
 *
 * - `principal` — the actor of the account the principal's credential names:
 *   the keeper's bootstrap actor for the keeper-credential principals
 *   (`keeper`, `daemon`, `token`, `scoped_token`, …), the account's one actor
 *   for `fresh_non_admin` / `role_holder` / `wrong_role`. Binding it makes a
 *   row hold whether the account has one actor or several: a single-actor
 *   account resolves the same actor with or without the selector, a
 *   multi-actor one needs it.
 * - `extra_actor` — the keeper's first seeded extra actor
 *   (`fixture.extra_actors[0]`); the fixture must declare `extra_actors`.
 *   With a keeper-credential principal, the request acts as a sibling actor
 *   on the keeper's own account that holds none of the keeper's roles.
 * - `keeper_actor` — the keeper's bootstrap actor whatever the principal, so
 *   a principal on another account names a real actor that is not its own.
 *
 * Unavailable for principals that present no account (`anonymous`,
 * `bearer_browser`, `malformed_bearer`, and the dead credentials
 * `tampered_cookie` … `expired_token`) — the runner throws.
 */
export type ConformanceActingBinding = 'principal' | 'extra_actor' | 'keeper_actor';

/** The request a conformance case issues. */
export interface ConformanceCaseRequest {
	/**
	 * RPC method name (e.g. `admin_account_list`) or a REST auth-route suffix
	 * (e.g. `/login`). A leading `/` selects the REST branch; otherwise the
	 * runner resolves the RPC action from the spec registry.
	 */
	method: string;
	/** Request params / body. Omit for nullary methods. */
	params?: unknown;
	/**
	 * RPC params as raw JSON text, sent verbatim in place of `params` — for a
	 * spelling `JSON.stringify` loses (`5.0`, `1e1`, `-0`). Exclusive with
	 * `params` and `acting`; RPC methods only.
	 */
	params_json?: string;
	as: ConformancePrincipal;
	/**
	 * Bind `params.acting` at run time to the named actor
	 * (`ConformanceActingBinding`). Params must be an object or omitted, and
	 * must not carry `acting` themselves.
	 */
	acting?: ConformanceActingBinding;
	/** HTTP verb. Defaults to POST; use GET for `side_effects: false` reads. */
	verb?: 'POST' | 'GET';
}

/** The expected response shape a conformance case asserts. */
export interface ConformanceCaseExpectation {
	/** Expected HTTP status code. */
	status: number;
	/**
	 * The JSON-RPC `error.code` an RPC error row must carry, on the HTTP and WS
	 * legs alike. Omitted, it is the code the spine maps `status` back to
	 * (`http_status_to_jsonrpc_error_code` — `invalid_params` for `400`,
	 * `not_found` for `404`, `rate_limited` for `429`). That mapping is
	 * many-to-one, so a refusal under another code sharing its status
	 * (`invalid_request` or `parse_error` at `400`, `method_not_found` at
	 * `404`, a consumer code `register_jsonrpc_error_code` declared) names its
	 * code here. RPC rows only: a REST row setting it is refused at collection.
	 */
	error_code?: JsonrpcErrorCode;
	/**
	 * Expected error reason — pass the IMPORTED `ERROR_*` constant from
	 * `http/error_schemas.ts`, never a string literal. Asserted against the RPC
	 * `error.data.reason` or the REST flat-body `error` field. `null` pins the
	 * reason absent: an RPC error carrying no `data.reason` (a handler's bare
	 * `forbidden`). A REST error body always names its code in `error`, so a REST
	 * row pins that code instead; `null` there is refused at collection.
	 * Omitted, the reason is not asserted.
	 */
	error_reason?: string | null;
	/**
	 * What the response does to the session cookie (`SessionCookieEffect`), read
	 * off its `Set-Cookie` lines for the session cookie's name. Omitted means
	 * `'none'` — no line for it — so every row that does not name an effect pins
	 * that it sets and clears nothing. HTTP legs only: a row naming `'clear'`,
	 * `'set'` or `'clear_then_set'` is no WS case (`is_ws_conformance_case`).
	 * A row whose status is not 2xx can't name `'set'` or `'clear_then_set'`:
	 * the collection refuses it, since no refusal may mint a session cookie.
	 */
	set_cookie?: SessionCookieEffect;
	/**
	 * Specific field-value assertions on the success `result` (2xx) or the
	 * error `error.data` (non-2xx). Each key must deep-equal the corresponding
	 * response field.
	 */
	fields?: Record<string, unknown>;
	/**
	 * Sensitive field names that must NOT appear ANYWHERE (at any depth) in the
	 * normalized response body — the negative-space twin of `fields`. Each name
	 * is searched recursively through the success `result` / error envelope, so
	 * a secret column (`password_hash`, `token_hash`) that leaks at any nesting
	 * level (top-level, inside a list element) fails the case. Pins "this secret
	 * never serializes" on BOTH spines — a serialization regression would
	 * otherwise leak identically and silently on each. Non-vacuous only when the
	 * body is known non-empty (e.g. a list that always contains the caller);
	 * note that in the case.
	 */
	absent_fields?: Array<string>;
	/**
	 * Per-header expectations on the response. Each key is a header name
	 * (case-insensitive); a string value asserts the header is present and
	 * equals it exactly, `null` asserts the header is ABSENT. Independent of
	 * this, the runner enforces an unconditional no-fingerprint invariant on
	 * EVERY response (`Server` / `X-Powered-By` / `WWW-Authenticate` must stay
	 * absent on both spines), so a case only needs `headers` to pin a header
	 * beyond that always-on floor.
	 */
	headers?: Record<string, string | null>;
	/**
	 * Tags this case as a member of an indistinguishability group. After all
	 * cases run, the runner asserts every member of a group produced a
	 * BYTE-IDENTICAL normalized response (`{status, body}`) — checked per impl.
	 * This promotes a masked pair (found-but-unauthorized ≡ not-found,
	 * wrong-password ≡ account-not-found) from "same status + reason" to
	 * "wire-indistinguishable", and holds BOTH impls to it: a prober hitting
	 * either spine cannot tell the members apart. A group needs >= 2 members; a
	 * member may still set `fields`. The negative-space twin of the positive
	 * `output`-schema parity the runner already asserts.
	 */
	equivalence_group?: string;
}

/**
 * A single conformance case. `name` is the assertion; the optional
 * free-text `note` is printed in the test label / failure output. A
 * security case's `note` should reference a **public** fuz_app doc
 * property (`security.md` / `architecture.md` / module TSDoc), since the
 * table ships in a public package — not an internal planning doc. The note
 * is documentation, not a gate: it stays free-text by design because a
 * non-empty-string check never catches a *wrong* citation — the citation
 * is verified in review.
 */
export interface ConformanceCase {
	/** The assertion, used as the test label. */
	name: string;
	request: ConformanceCaseRequest;
	expect: ConformanceCaseExpectation;
	/** Free-text note printed in the label / failure output. */
	note?: string;
	/**
	 * Marks the case a deferred-by-design gap. The runner routes it through
	 * `xfail_until` instead of a normal `test` — visible (distinct from pass),
	 * specific (red on any failure but the one `fails_with` names), and
	 * self-cleaning (flips red when the impl starts passing, forcing the
	 * marker's removal). Use for declared gaps (e.g. facts), never for
	 * in-scope gaps (those fail loud as a red `test`).
	 */
	xfail?: XfailMarker;
}
