/**
 * Daemon token primitives — schema, generation, and validation.
 *
 * Pure auth operations with no I/O or state management.
 * The middleware, rotation, and persistence logic lives in
 * `daemon_token_middleware.ts`.
 *
 * @module
 */

import {z} from 'zod';
import {timingSafeEqual} from 'node:crypto';

import {generate_random_base64url} from '../crypto.js';

/** Daemon token format: 43 base64url characters (256 bits). */
export const DaemonToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid daemon token format');
export type DaemonToken = z.infer<typeof DaemonToken>;

/** The `X-Daemon-Token` header name. */
export const DAEMON_TOKEN_HEADER = 'X-Daemon-Token';

/**
 * Mutable runtime state for daemon token rotation.
 *
 * This is runtime state (not `AppDeps` or `*Options`) — it changes during
 * operation. Created at server startup, passed to the middleware factory.
 */
export interface DaemonTokenState {
	/** Current valid token. */
	current_token: string;
	/** Previous token, still valid during the race window. `null` before first rotation. */
	previous_token: string | null;
	/** When the last rotation occurred. */
	rotated_at: Date;
	/** The account ID of the keeper (resolved at startup, set by `on_bootstrap`). */
	keeper_account_id: string | null;
}

/**
 * Generate a new daemon token (256-bit random, base64url).
 *
 * @returns a 43-character base64url string
 */
export const generate_daemon_token = (): string => {
	return generate_random_base64url();
};

/**
 * Validate a daemon token against the current state.
 *
 * Accepts both the current and previous token (2-token race window).
 * Uses timing-safe comparison.
 *
 * @param provided - the token from the `X-Daemon-Token` header
 * @param state - the daemon token state
 * @returns `true` if the token is valid
 */
export const validate_daemon_token = (provided: string, state: DaemonTokenState): boolean => {
	const provided_buf = Buffer.from(provided);
	const current_buf = Buffer.from(state.current_token);
	if (provided_buf.length === current_buf.length && timingSafeEqual(provided_buf, current_buf)) {
		return true;
	}
	if (state.previous_token !== null) {
		const previous_buf = Buffer.from(state.previous_token);
		if (
			provided_buf.length === previous_buf.length &&
			timingSafeEqual(provided_buf, previous_buf)
		) {
			return true;
		}
	}
	return false;
};
