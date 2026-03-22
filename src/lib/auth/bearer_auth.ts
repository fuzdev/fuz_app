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
import {
	ERROR_BEARER_REJECTED_BROWSER,
	ERROR_INVALID_TOKEN,
	ERROR_ACCOUNT_NOT_FOUND,
} from '../http/error_schemas.js';

/**
 * Create middleware that authenticates via bearer token.
 *
 * Rejects bearer tokens when an `Origin` or `Referer` header is present —
 * browsers must use cookie auth to reduce attack surface.
 * Auth scheme matching is case-insensitive per RFC 7235.
 * On success, builds the request context (`{ account, actor, permits }`)
 * and sets it on the Hono context. Skips if a request context is already set
 * (e.g. by session middleware).
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

		// Reject bearer tokens in browser context — defense-in-depth:
		// checks both Origin and Referer (not just Origin) because some browser
		// requests send only Referer. Uses `!== undefined` so that empty-string
		// headers (e.g. `Origin: ''`) are still treated as browser context.
		if (c.req.header('Origin') !== undefined || c.req.header('Referer') !== undefined) {
			return c.json({error: ERROR_BEARER_REJECTED_BROWSER}, 403);
		}

		const raw_token = auth_header.slice(7);

		// Reject empty token body before any hashing or DB work.
		// (The Fetch API trims 'Bearer ' to 'Bearer' which skips this middleware entirely,
		// but raw HTTP clients may send 'Bearer ' with an empty token.)
		if (!raw_token) {
			return c.json({error: ERROR_INVALID_TOKEN}, 401);
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
			return c.json({error: ERROR_INVALID_TOKEN}, 401);
		}

		// Valid token — reset rate limit counter
		if (ip_rate_limiter) ip_rate_limiter.reset(ip);

		// Build request context from the token's account
		const ctx = await build_request_context(deps, api_token.account_id);
		if (!ctx) {
			return c.json({error: ERROR_ACCOUNT_NOT_FOUND}, 401);
		}

		c.set(REQUEST_CONTEXT_KEY, ctx);
		c.set(CREDENTIAL_TYPE_KEY, 'api_token');

		await next();
	};
};
