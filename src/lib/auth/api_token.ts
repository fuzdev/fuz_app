/**
 * API token generation and hashing utilities.
 *
 * Tokens use the format `secret_fuz_token_<base64url>` and are stored
 * as blake3 hashes. These are pure cryptographic operations with no
 * framework dependency — the bearer auth middleware that validates
 * tokens lives in `auth/bearer_auth.ts`.
 *
 * @module
 */

import { z } from 'zod';
import { hash_blake3 } from '@fuzdev/fuz_util/hash_blake3.ts';

import { generate_random_base64url } from '../crypto.ts';

/** Prefix for all fuz API tokens (enables secret scanning). */
export const API_TOKEN_PREFIX = 'secret_fuz_token_';

/** Random bytes encoded into the raw token body (256 bits). */
export const API_TOKEN_ENTROPY_BYTES = 32;

/** Length of the unpadded base64url body that encodes `API_TOKEN_ENTROPY_BYTES`. */
export const API_TOKEN_BODY_LENGTH = Math.ceil((API_TOKEN_ENTROPY_BYTES * 4) / 3);

/**
 * Regex for a raw API token: `API_TOKEN_PREFIX` plus exactly
 * `API_TOKEN_BODY_LENGTH` base64url characters. Matches the format produced
 * by `generate_api_token`.
 */
export const API_TOKEN_REGEX = new RegExp(
	`^${API_TOKEN_PREFIX}[A-Za-z0-9_-]{${API_TOKEN_BODY_LENGTH}}$`
);

/**
 * Whether `raw` has the shape of a raw API token — the bearer path's precheck,
 * so a value that cannot be a token costs no database work. A `true` says
 * nothing about whether the token exists. Twin of the Rust spine's
 * `is_api_token_shaped`.
 *
 * @param raw - the value from the `Authorization: Bearer` header
 * @returns `true` when `raw` matches `API_TOKEN_REGEX`
 */
export const is_api_token_shaped = (raw: string): boolean => API_TOKEN_REGEX.test(raw);

/**
 * Regex for the public API token id (e.g. `tok_abC0_d-3xyzA`). Twelve
 * base64url characters after the `tok_` prefix. Matches the format produced
 * by `generate_api_token`.
 */
export const API_TOKEN_ID_REGEX = /^tok_[A-Za-z0-9_-]{12}$/;

/** Zod schema for the public API token id. */
export const ApiTokenId = z.string().regex(API_TOKEN_ID_REGEX);
export type ApiTokenId = z.infer<typeof ApiTokenId>;

/**
 * Hash an API token for storage using blake3.
 *
 * @param token - the raw API token
 * @returns hex-encoded blake3 hash
 */
export const hash_api_token = (token: string): string => hash_blake3(token);

/**
 * Generate a new API token with its hash and public id.
 *
 * The raw token is returned exactly once — callers must present it
 * to the user immediately.
 *
 * @returns the raw token, a public id, and the blake3 hash for storage
 */
export const generate_api_token = (): { token: string; id: string; token_hash: string } => {
	const raw = generate_random_base64url(API_TOKEN_ENTROPY_BYTES);
	const token = `${API_TOKEN_PREFIX}${raw}`;
	const token_hash = hash_api_token(token);
	const id = `tok_${raw.slice(0, 12)}`;
	return { token, id, token_hash };
};
