/**
 * Keeper credential type guard.
 *
 * Two-part check:
 * 1. Credential type must be `daemon_token` (not session cookie, not API token).
 * 2. Account must hold active keeper permit.
 *
 * Both must pass. A session cookie from the bootstrap account still fails check #1.
 *
 * @module
 */

import type {MiddlewareHandler} from 'hono';

import {get_request_context, has_scoped_role} from './request_context.js';
import {CREDENTIAL_TYPE_KEY} from '../hono_context.js';
import {ROLE_KEEPER} from './role_schema.js';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_KEEPER_REQUIRES_DAEMON_TOKEN,
} from '../http/error_schemas.js';

/**
 * Middleware that requires keeper credentials.
 *
 * Returns 401 if unauthenticated, 403 if credential type is not
 * `daemon_token` or if the keeper role is missing. Uses
 * `has_scoped_role(ctx, ROLE_KEEPER, null)` so only global keeper permits
 * satisfy the gate — symmetric with `require_role` and the dispatcher
 * gates. Keeper's `grant_paths` is `['bootstrap']` (it is unreachable via
 * the admin path), so a scoped keeper permit is outside the supported
 * flow today, but the scope-aware check is defense-in-depth against
 * future drift.
 */
export const require_keeper: MiddlewareHandler = async (c, next): Promise<Response | void> => {
	const ctx = get_request_context(c);
	if (!ctx) {
		return c.json({error: ERROR_AUTHENTICATION_REQUIRED}, 401);
	}

	const credential_type = c.get(CREDENTIAL_TYPE_KEY);
	if (credential_type !== 'daemon_token') {
		return c.json(
			{error: ERROR_KEEPER_REQUIRES_DAEMON_TOKEN, credential_type: credential_type ?? 'none'},
			403,
		);
	}

	if (!has_scoped_role(ctx, ROLE_KEEPER, null)) {
		return c.json({error: ERROR_INSUFFICIENT_PERMISSIONS, required_role: ROLE_KEEPER}, 403);
	}

	await next();
};
