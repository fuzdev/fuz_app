/**
 * API token generation and hashing utilities.
 *
 * Tokens use the format `secret_fuz_token_<base64url>` and are stored
 * as blake3 hashes. These are pure cryptographic operations with no
 * framework dependency — the bearer auth middleware that validates
 * tokens lives in `bearer_auth.ts`.
 *
 * @module
 */

import {hash_blake3} from '@fuzdev/fuz_util/hash_blake3.js';

import {generate_random_base64url} from '../crypto.js';

/** Prefix for all fuz API tokens (enables secret scanning). */
export const API_TOKEN_PREFIX = 'secret_fuz_token_';

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
export const generate_api_token = (): {token: string; id: string; token_hash: string} => {
	const raw = generate_random_base64url();
	const token = `${API_TOKEN_PREFIX}${raw}`;
	const token_hash = hash_api_token(token);
	const id = `tok_${raw.slice(0, 12)}`;
	return {token, id, token_hash};
};
