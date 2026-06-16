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

import {DEV} from 'esm-env';
import type {MiddlewareHandler} from 'hono';
import type {Logger} from '@fuzdev/fuz_util/log.ts';

import {AUTH_API_TOKEN_ID_KEY, ACCOUNT_ID_KEY, CREDENTIAL_TYPE_KEY} from '../hono_context.ts';
import {query_validate_api_token} from './api_token_queries.ts';
import type {QueryDeps} from '../db/query_deps.ts';
import {get_client_ip} from '../http/client_ip.ts';
import {rate_limit_exceeded_response, type RateLimiter} from '../rate_limiter.ts';

/**
 * Create middleware that authenticates via bearer token.
 *
 * Soft-fails for invalid, expired, or empty tokens — calls `next()` without
 * setting account identity, letting downstream auth enforcement (the RPC
 * dispatcher's pre-validation / post-authorization auth gates or
 * `require_auth`) return a consistent JSON-RPC or route-level error. This
 * avoids leaking token-specific diagnostics
 * (`invalid_token`, `account_not_found`) that could aid enumeration attacks,
 * and ensures public actions are not blocked by bad credentials.
 *
 * Rejects bearer tokens when an `Origin` or `Referer` header is present —
 * browsers must use cookie auth to reduce attack surface.
 * Auth scheme matching is case-insensitive per RFC 7235.
 * On success, sets `c.var.auth_account_id`, `CREDENTIAL_TYPE_KEY = 'api_token'`,
 * and `AUTH_API_TOKEN_ID_KEY`. Skips when an account is already authenticated
 * (e.g. by session middleware). Acting-actor resolution + `RequestContext`
 * construction are deferred to the dispatcher's authorization phase.
 *
 * Rate limiting (429) is the only hard-fail — it's a throttling concern
 * independent of auth identity.
 *
 * @param deps - query dependencies (pool-level db for middleware)
 * @param ip_rate_limiter - per-IP rate limiter for bearer token attempts (null to disable)
 * @param log - the logger instance
 * @mutates Hono context - sets `ACCOUNT_ID_KEY`, `CREDENTIAL_TYPE_KEY`, and `AUTH_API_TOKEN_ID_KEY` on success
 * @mutates `ip_rate_limiter` - records on attempt; resets on a valid token
 */
export const create_bearer_auth_middleware = (
	deps: QueryDeps,
	ip_rate_limiter: RateLimiter | null,
	log: Logger,
): MiddlewareHandler => {
	return async (c, next): Promise<Response | void> => {
		// Skip if an account is already authenticated (e.g. by session middleware)
		if (c.get(ACCOUNT_ID_KEY) != null) {
			await next();
			return;
		}

		const auth_header = c.req.header('Authorization');
		// Case-insensitive scheme matching per RFC 7235 §2.1 — defense-in-depth:
		// without this, a `bearer` (lowercase) header silently bypasses token
		// validation and browser-context rejection instead of being processed.

		if (!auth_header || auth_header.slice(0, 7).toLowerCase() !== 'bearer ') {
			await next();
			return;
		}

		// Silently discard bearer tokens in browser context — defense-in-depth:
		// checks both Origin and Referer (not just Origin) because some browser
		// requests send only Referer. Uses `!== undefined` so that empty-string
		// headers (e.g. `Origin: ''`) are still treated as browser context.
		// Discards rather than returning 403 so that the RPC dispatcher can still
		// handle public actions or fall through to cookie auth.
		if (c.req.header('Origin') !== undefined || c.req.header('Referer') !== undefined) {
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

		const raw_token = auth_header.slice(7);

		// Empty token body — soft-fail (treat as "no credential").
		// (The Fetch API trims 'Bearer ' to 'Bearer' which skips this middleware entirely,
		// but raw HTTP clients may send 'Bearer ' with an empty token.)
		if (!raw_token) {
			await next();
			return;
		}

		const ip = get_client_ip(c);

		// Per-IP rate limit: record before async DB work to close the TOCTOU
		// window where concurrent requests could all pass check() before any
		// reaches record(). On valid token, reset the counter below.
		if (ip_rate_limiter) {
			const check = ip_rate_limiter.check(ip);
			if (!check.allowed) {
				return rate_limit_exceeded_response(c, check.retry_after);
			}
			ip_rate_limiter.record(ip);
		}

		const api_token = await query_validate_api_token(
			{...deps, log},
			raw_token,
			ip,
			c.var.pending_effects,
		);
		if (!api_token) {
			// Invalid or expired token — soft-fail. Rate limit counter stays
			// incremented (recorded above), correctly penalizing bad attempts.
			log.debug('bearer auth soft-fail: token not found or expired');
			await next();
			return;
		}

		// Valid token — reset rate limit counter
		if (ip_rate_limiter) ip_rate_limiter.reset(ip);

		c.set(ACCOUNT_ID_KEY, api_token.account_id);
		c.set(CREDENTIAL_TYPE_KEY, 'api_token');
		c.set(AUTH_API_TOKEN_ID_KEY, api_token.id);

		await next();
	};
};
