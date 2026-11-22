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

import { pipe, regex, string, type Infer } from '@fuzdev/fuz_schema/schema.ts';
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

/** Prefix on the public API token id (e.g. `tok_abC0_d-3xyzA`). */
export const API_TOKEN_ID_PREFIX = 'tok_';

/** Length of the public id's body — the raw token body's first characters. */
export const API_TOKEN_ID_BODY_LENGTH = 12;

/**
 * Regex for the public API token id (e.g. `tok_abC0_d-3xyzA`):
 * `API_TOKEN_ID_PREFIX` plus `API_TOKEN_ID_BODY_LENGTH` base64url characters.
 * Matches the format `to_api_token_id` derives.
 */
export const API_TOKEN_ID_REGEX = new RegExp(
	`^${API_TOKEN_ID_PREFIX}[A-Za-z0-9_-]{${API_TOKEN_ID_BODY_LENGTH}}$`
);

/** The public API token id, `API_TOKEN_ID_REGEX`, a `@fuzdev/fuz_schema` schema. */
export const ApiTokenId = pipe(string, regex(API_TOKEN_ID_REGEX));
export type ApiTokenId = Infer<typeof ApiTokenId>;

/**
 * Hash an API token for storage using blake3.
 *
 * @param token - the raw API token
 * @returns hex-encoded blake3 hash
 */
export const hash_api_token = (token: string): string => hash_blake3(token);

/**
 * The public id of a raw API token: `API_TOKEN_ID_PREFIX` and the first
 * `API_TOKEN_ID_BODY_LENGTH` characters of the body after `API_TOKEN_PREFIX`.
 * Both spines derive it the same way, so a token minted by either names the
 * same id on both. Twin of the Rust spine's `generate_api_token` id
 * derivation (`fuz_auth::api_token`).
 *
 * @param token - the whole raw token, `API_TOKEN_PREFIX` included
 * @returns the token's public id
 * @throws Error when `token` is not `is_api_token_shaped` — a caller holds a
 *   minted or prechecked token, so anything else is a bug
 */
export const to_api_token_id = (token: string): ApiTokenId => {
	if (!is_api_token_shaped(token)) throw new Error('to_api_token_id: not an API token');
	return (
		API_TOKEN_ID_PREFIX +
		token.slice(API_TOKEN_PREFIX.length, API_TOKEN_PREFIX.length + API_TOKEN_ID_BODY_LENGTH)
	);
};

/**
 * Generate a new API token with its hash and public id.
 *
 * The raw token is returned exactly once — callers must present it
 * to the user immediately.
 *
 * @returns the raw token, a public id, and the blake3 hash for storage
 */
export const generate_api_token = (): { token: string; id: string; token_hash: string } => {
	const token = `${API_TOKEN_PREFIX}${generate_random_base64url(API_TOKEN_ENTROPY_BYTES)}`;
	return { token, id: to_api_token_id(token), token_hash: hash_api_token(token) };
};
