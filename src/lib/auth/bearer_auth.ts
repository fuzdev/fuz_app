/**
 * Bearer auth middleware for API token authentication.
 *
 * Bearer tokens are rejected when `Origin` or `Referer` headers are present —
 * browsers must use cookie auth. This reduces attack surface: a stolen token
 * cannot be replayed from a browser context (the browser adds `Origin`
 * automatically). The discard is silent on the wire (anti-enumeration); in
 * `DEV` only, the middleware adds an `X-Fuz-Auth-Debug:
 * bearer_discarded_browser_context` response header so tests/tooling can tell
 * "token discarded for browser context" apart from "no credential supplied"
 * without weakening production.
 *
 * Token generation and hashing utilities live in `auth/api_token.ts`.
 *
 * @module
 */

import { DEV } from 'esm-env';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { RESOLVED_AUTH_KEY } from '../hono_context.ts';
import { credential_deadline_after } from './credential_deadline.ts';
import { get_resolved_auth } from './resolved_auth.ts';
import { read_bearer_token } from './credential_headers.ts';
import { query_api_token_touch, query_validate_api_token } from './api_token_queries.ts';
import { query_account_by_id } from './account_queries.ts';
import type { QueryDeps } from '../db/query_deps.ts';
import { get_client_ip } from '../http/client_ip.ts';
import { get_header_lines } from '../http/header_lines.ts';
import { is_browser_context } from '../http/request_headers.ts';

/**
 * Create middleware that authenticates via bearer token.
 *
 * Soft-fails for malformed, invalid, expired, or empty tokens — calls `next()` without
 * setting account identity, letting downstream auth enforcement (the RPC
 * dispatcher's pre-authorization / post-authorization auth gates or
 * `require_auth`) return a consistent JSON-RPC or route-level error. This
 * avoids leaking token-specific diagnostics
 * (`invalid_token`, `account_not_found`) that could aid enumeration attacks,
 * and ensures public actions are not blocked by bad credentials.
 *
 * Discards bearer tokens when an `Origin` or `Referer` header is present —
 * `next()` with no identity, as for a bad token — so browsers must use cookie
 * auth, reducing attack surface.
 * The token is read by `read_bearer_token`: one `Authorization` line, the
 * scheme in any case (RFC 7235), one space, an `is_api_token_shaped` value. A
 * header that reads no token — sent twice included — soft-fails before the
 * database is touched.
 * On success, sets the `api_token` arm of `ResolvedAuth` (`RESOLVED_AUTH_KEY`):
 * the account, the token id, its scope, and its deadline. The last leg of the
 * chain, it skips when an earlier one (the daemon token or a session cookie)
 * already resolved the request — before reading the header, so a token sent
 * beside a winning credential is never looked up and its `last_used_at` /
 * `last_used_ip` never move. Acting-actor resolution + `RequestContext`
 * construction are deferred to the dispatcher's authorization phase.
 *
 * There is deliberately **no rate limit on this path**, and no 429 — every
 * failure soft-fails to "no credential". An API token is 32 bytes of CSPRNG
 * output resolved by a blake3 hash lookup, so guessing is bounded by entropy,
 * not by throttling; a limiter here would buy nothing measurable while costing
 * availability (the check/record has to precede the async lookup to close its
 * own TOCTOU window, so concurrent requests bearing a *valid* token race each
 * other into a 429). The Rust spine never had one here; this is the converged
 * shape. See `docs/security.md` §Why bearer auth is not rate limited.
 *
 * @param deps - query dependencies (pool-level db for middleware)
 * @param log - the logger instance
 * @mutates Hono context - sets `RESOLVED_AUTH_KEY` on success
 */
export const create_bearer_auth_middleware = (deps: QueryDeps, log: Logger): MiddlewareHandler => {
	return async (c, next): Promise<Response | void> => {
		// an earlier leg (daemon token, session cookie) already resolved the request
		if (get_resolved_auth(c) !== null) {
			await next();
			return;
		}

		// The header's one shaped token, or nothing (`read_bearer_token`): absent,
		// another scheme, an empty or malformed token, and a header sent as more
		// than one line all read `null` and soft-fail before any database work —
		// no pool checkout, no query — so junk bearers cost nothing to refuse.
		const authorization_lines = get_header_lines(c, 'Authorization');
		const raw_token = read_bearer_token(authorization_lines);
		if (raw_token === null) {
			if (authorization_lines.length > 0) log.debug('bearer auth soft-fail: no token read');
			await next();
			return;
		}

		// Silently discard bearer tokens in browser context (`is_browser_context`
		// — an Origin or Referer line present). Discards rather than returning 403 so that
		// the RPC dispatcher can still handle public actions or fall through to
		// cookie auth.
		if (is_browser_context(get_header_lines(c, 'origin'), get_header_lines(c, 'referer'))) {
			log.debug('bearer auth rejected: browser context (Origin/Referer present)');
			// The discard is silent on the wire by design (a stolen-token probe
			// gets an indistinguishable 401, not a "your token was dropped"
			// signal — anti-enumeration). That same silence makes the contract
			// easy to trip over in tests/tooling, so surface the reason in DEV
			// only: production never emits it, so it leaks nothing to an attacker.
			if (DEV) c.header('X-Fuz-Auth-Debug', 'bearer_discarded_browser_context');
			await next();
			return;
		}

		const api_token = await query_validate_api_token({ ...deps, log }, raw_token);
		if (!api_token) {
			// Invalid or expired token — soft-fail, indistinguishable from
			// sending no credential at all.
			log.debug('bearer auth soft-fail: token not found or expired');
			await next();
			return;
		}
		// a tombstoned account authenticates nothing — its token resolves as no
		// credential, the anonymous caller, as on the Rust spine
		const account = await query_account_by_id(deps, api_token.account_id);
		if (!account) {
			log.debug('bearer auth soft-fail: account not found or deleted');
			await next();
			return;
		}

		// Fire-and-forget usage tracking, once the token has authenticated —
		// after the account check, so a token on a tombstoned account records
		// no use. `ip` feeds `last_used_ip`, not a limiter.
		const touch = query_api_token_touch(deps, api_token.id, get_client_ip(c)).catch((err) => {
			log.error('Failed to update last_used_at:', err);
		});
		c.var.pending_effects?.push(touch);

		c.set(RESOLVED_AUTH_KEY, {
			credential_type: 'api_token',
			account,
			api_token_id: api_token.id,
			// Parsed by the query, which refuses a token whose stored scope is
			// unreadable — there is no default to fall back to.
			scope: api_token.scope,
			// the row's expiry, read on the database clock; none for an eternal token
			credential_deadline: credential_deadline_after([api_token.expires_in_ms])
		});

		await next();
	};
};
