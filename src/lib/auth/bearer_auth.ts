/**
 * Bearer auth middleware for API token authentication.
 *
 * Bearer tokens are rejected when `Origin` or `Referer` headers are present —
 * browsers must use cookie auth. This reduces attack surface: a stolen token
 * cannot be replayed from a browser context (the browser adds `Origin`
 * automatically).
 *
 * Token generation and hashing utilities live in `auth/api_token.ts`.
 *
 * @module
 */

import type {MiddlewareHandler} from 'hono';
import type {Logger} from '@fuzdev/fuz_util/log.js';

import {REQUEST_CONTEXT_KEY, build_request_context} from './request_context.js';
import {CREDENTIAL_TYPE_KEY} from '../hono_context.js';
import {query_validate_api_token} from './api_token_queries.js';
import type {QueryDeps} from '../db/query_deps.js';
import {get_client_ip} from '../http/proxy.js';
import {rate_limit_exceeded_response, type RateLimiter} from '../rate_limiter.js';

/**
 * Create middleware that authenticates via bearer token.
 *
 * Soft-fails for invalid, expired, or empty tokens — calls `next()` without
 * setting a request context, letting downstream auth enforcement (per-action
 * `check_action_auth` or `require_auth`) return a consistent JSON-RPC or
 * route-level error. This avoids leaking token-specific diagnostics
 * (`invalid_token`, `account_not_found`) that could aid enumeration attacks,
 * and ensures public actions are not blocked by bad credentials.
 *
 * Rejects bearer tokens when an `Origin` or `Referer` header is present —
 * browsers must use cookie auth to reduce attack surface.
 * Auth scheme matching is case-insensitive per RFC 7235.
 * On success, builds the request context (`{ account, actor, permits }`)
 * and sets it on the Hono context. Skips if a request context is already set
 * (e.g. by session middleware).
 *
 * Rate limiting (429) is the only hard-fail — it's a throttling concern
 * independent of auth identity.
 *
 * @param deps - query dependencies (pool-level db for middleware)
 * @param ip_rate_limiter - per-IP rate limiter for bearer token attempts (null to disable)
 * @param log - the logger instance
 */
export const create_bearer_auth_middleware = (
	deps: QueryDeps,
	ip_rate_limiter: RateLimiter | null,
	log: Logger,
): MiddlewareHandler => {
	return async (c, next): Promise<Response | void> => {
		// Skip if already authenticated via session
		if (c.get(REQUEST_CONTEXT_KEY)) {
			await next();
			return;
		}

		const auth_header = c.req.header('Authorization');
		// Case-insensitive scheme matching per RFC 7235 §2.1 — defense-in-depth:
		// without this, a `bearer` (lowercase) header silently bypasses token
		// validation and browser-context rejection instead of being processed.
		// eslint-disable-next-line @typescript-eslint/prefer-optional-chain
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

		// Build request context from the token's account
		const ctx = await build_request_context(deps, api_token.account_id);
		if (!ctx) {
			// Token exists but account/actor missing — soft-fail to avoid
			// leaking account lifecycle information.
			log.debug('bearer auth soft-fail: account or actor not found for token');
			await next();
			return;
		}

		c.set(REQUEST_CONTEXT_KEY, ctx);
		c.set(CREDENTIAL_TYPE_KEY, 'api_token');

		await next();
	};
};
