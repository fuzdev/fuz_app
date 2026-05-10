/**
 * Hono context variable augmentation for fuz_app.
 *
 * Cross-cutting shared vocabulary — defines the Hono `ContextVariableMap`
 * variables used by auth, http, server, and testing modules.
 *
 * Auto-loaded by `server/app_server.ts` (side-effect import) and
 * transitively by auth middleware modules that import `CREDENTIAL_TYPE_KEY`.
 * Consumers don't need a manual import unless bypassing the standard server assembly.
 *
 * @module
 */

import {z} from 'zod';

import type {RequestContext} from './auth/request_context.js';
import {
	CREDENTIAL_TYPE_API_TOKEN,
	CREDENTIAL_TYPE_DAEMON_TOKEN,
	CREDENTIAL_TYPE_SESSION,
} from './auth/credential_type_schema.js';

/**
 * The credential types that can authenticate a request — the closed set
 * of fuz_app builtins. The open registry on top
 * (`create_credential_type_schema(consumer_types)`) is consulted at
 * registry time by `create_role_schema` for `RoleSpec.required_credential_types`
 * validation; the wire-validated `CredentialType` enum here stays
 * narrow because middleware only ever sets one of the three builtins.
 */
export const CREDENTIAL_TYPES = [
	CREDENTIAL_TYPE_SESSION,
	CREDENTIAL_TYPE_API_TOKEN,
	CREDENTIAL_TYPE_DAEMON_TOKEN,
] as const;

/** Credential type — how a request was authenticated. */
export const CredentialType = z.enum(CREDENTIAL_TYPES);
export type CredentialType = z.infer<typeof CredentialType>;

/** Hono context variable name for the credential type. */
export const CREDENTIAL_TYPE_KEY = 'credential_type';

/** Hono context variable name for the authenticated API token id. */
export const AUTH_API_TOKEN_ID_KEY = 'auth_api_token_id';

/**
 * Hono context variable name for the authenticated account id.
 *
 * Set by the auth middleware (session, bearer, or daemon token) on a valid
 * credential. `null` for unauthenticated requests. The route-spec wrapper /
 * RPC dispatcher's authorization phase reads this when resolving the acting
 * actor; account-grain auth guards (`require_auth`) and account-grain handlers
 * read it directly.
 */
export const ACCOUNT_ID_KEY = 'auth_account_id';

/**
 * Hono context variable name for the test-harness pre-baked context flag.
 *
 * Test harnesses (`create_test_app_from_specs`, `create_fake_hono_context`,
 * the WS round-trip `connect()` helper, plus per-test middleware that
 * pre-populates `REQUEST_CONTEXT_KEY`) set this to `true` so
 * `apply_authorization_phase` skips its DB-backed actor resolution and
 * trusts the supplied `RequestContext`. Production middleware never sets
 * this key — only test code does. The flag is the explicit escape hatch
 * that replaced the implicit "is `REQUEST_CONTEXT_KEY` already set?" probe,
 * so that future production code consulting `REQUEST_CONTEXT_KEY` cannot
 * silently bypass the live build.
 */
export const TEST_CONTEXT_PRESET_KEY = 'test_context_preset';

/**
 * Cached parsed JSON request body, keyed by `'cached_request_body'`.
 *
 * Written by `read_raw_acting` (in the dispatcher's authorization
 * phase) when it pre-parses the body to extract the `acting` field;
 * read by `create_input_validation` so the input-validation step does
 * not pay for a second `JSON.parse` on the same Hono-cached body text.
 *
 * Decouples our pipeline from Hono's internal `bodyCache` shape: Hono
 * caches the body *text* (so a second `c.req.json()` call doesn't
 * re-read the request stream), but each call still re-runs
 * `JSON.parse(text)`. Storing the parsed value here saves the second
 * parse and keeps fuz_app from depending on undocumented Hono
 * implementation details.
 *
 * Three states:
 *
 * - Key absent — body has not been pre-parsed yet (the route had no
 *   `acting` to extract, or the request is GET).
 * - `{ok: true, body: unknown}` — pre-parse succeeded; the parsed
 *   value (object, primitive, or array) is in `body`.
 * - `{ok: false}` — pre-parse threw (malformed JSON). The downstream
 *   input-validation step short-circuits with `ERROR_INVALID_JSON_BODY`
 *   instead of re-parsing.
 */
export const CACHED_REQUEST_BODY_KEY = 'cached_request_body';

/** The shape stored under `CACHED_REQUEST_BODY_KEY`. */
export type CachedRequestBody = {ok: true; body: unknown} | {ok: false};

declare module 'hono' {
	interface ContextVariableMap {
		/** Resolved client IP, set by the trusted proxy middleware. */
		client_ip: string;
		auth_session_id: string | null;
		request_context: RequestContext | null;
		validated_input: unknown;
		validated_params: unknown;
		validated_query: unknown;
		/** How the request was authenticated (`'session'`, `'api_token'`, or `'daemon_token'`). */
		credential_type: CredentialType | null;
		/**
		 * Authenticated account id. Set by the session / bearer / daemon-token
		 * middleware on a valid credential; `null` for unauthenticated requests.
		 * The dispatcher's authorization phase resolves the acting actor against
		 * this id; `require_auth` 401s when it is `null`.
		 */
		auth_account_id: string | null;
		/**
		 * blake3 hash of the authenticated session token, or `null` for non-session
		 * credentials. Set by `create_request_context_middleware`. Used to scope
		 * per-session resources (e.g., SSE stream identity for `session_revoke`
		 * disconnection) without re-hashing the cookie in every handler.
		 */
		auth_session_token_hash: string | null;
		/**
		 * `api_token.id` when the request authenticated via `Authorization: Bearer`,
		 * or `null` for session/daemon-token/unauthenticated requests. Set by
		 * `create_bearer_auth_middleware`. Used to scope per-token resources
		 * (e.g., WS connection revocation on `token_revoke`) without re-looking
		 * up the token.
		 */
		auth_api_token_id: string | null;
		/**
		 * Eager fire-and-forget pool writes for this request — audit emits,
		 * session-touch UPDATE, api-token usage tracking. Producers push the
		 * in-flight `Promise<void>` directly. The flush middleware drains via
		 * `flush_pending_effects` after the handler returns. Initialized by
		 * `create_app_server`. In test mode (`await_pending_effects: true`),
		 * every promise resolves before the response returns.
		 */
		pending_effects: Array<Promise<void>>;
		/**
		 * Post-commit thunks pushed via `emit_after_commit(ctx, fn)`. The
		 * flush middleware invokes each thunk after the handler returns —
		 * never inline — so notifications (WS sends, etc.) cannot fire
		 * mid-transaction. Producers do not push raw thunks directly. The
		 * flush owns per-thunk `try/catch` + `log.error` so a directly-pushed
		 * thunk (tests included) cannot escape the safety net.
		 * Initialized by `create_app_server`. In test mode
		 * (`await_pending_effects: true`), every thunk completes before the
		 * response returns.
		 */
		post_commit_effects: Array<() => void | Promise<void>>;
		/**
		 * Set to `true` by test harnesses that pre-populate `request_context`
		 * to bypass the dispatcher's DB-backed actor resolution. Read by
		 * `apply_authorization_phase`. Production middleware never sets this.
		 */
		test_context_preset: boolean;
		/**
		 * Pre-parsed JSON request body cache. Written by `read_raw_acting`
		 * (the dispatcher's `acting` extractor) and read by
		 * `create_input_validation` so the same body is not parsed twice.
		 * See `CACHED_REQUEST_BODY_KEY` for state semantics.
		 */
		cached_request_body: CachedRequestBody;
	}
}
