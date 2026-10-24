/**
 * Argon2id password hashing implementation.
 *
 * Uses `@node-rs/argon2` for native performance with OWASP-recommended parameters.
 * Includes timing attack resistance via `verify_dummy`.
 *
 * Import `argon2_password_deps` for use as `PasswordHashDeps` in `AppDeps`.
 *
 * @module
 */

import { hash, verify } from '@node-rs/argon2';

import type { PasswordHashDeps } from './password.ts';

/** @node-rs/argon2 `Algorithm.Argon2id` — const enum, cannot import with isolatedModules. */
const ARGON2ID = 2 as const;

/**
 * Argon2id options following OWASP recommendations.
 *
 * @see https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
 */
const ARGON2_OPTIONS = {
	algorithm: ARGON2ID,
	memoryCost: 19456, // 19 MiB
	timeCost: 2,
	parallelism: 1
};

/**
 * A fixed Argon2id PHC string with the production parameters, verified against
 * on an account-lookup miss so that path does the same work as a real
 * verification. No password matches it in practice (its digest is all zero
 * bytes). Precomputed, so the first miss costs no hash either. Byte-identical
 * with the Rust `DUMMY_HASH` (`fuz_auth`).
 */
const DUMMY_HASH =
	'$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * Hash a password using Argon2id.
 *
 * @param password - the plaintext password to hash
 * @returns the Argon2id hash string
 */
export const hash_password = async (password: string): Promise<string> => {
	return hash(password, ARGON2_OPTIONS);
};

/**
 * Verify a password against an Argon2id hash.
 *
 * @param password - the plaintext password to verify
 * @param password_hash - the Argon2id hash to verify against
 * @returns `true` if the password matches
 */
export const verify_password = async (
	password: string,
	password_hash: string
): Promise<boolean> => {
	try {
		return await verify(password_hash, password);
	} catch {
		return false;
	}
};

/**
 * Verify a password against a dummy hash for timing attack resistance.
 *
 * Always returns `false`, but takes the same time as a real verification.
 * Call when account lookup fails to prevent timing-based user enumeration.
 *
 * @param password - the plaintext password to "verify"
 * @returns always `false`
 */
export const verify_dummy = async (password: string): Promise<boolean> => {
	await verify_password(password, DUMMY_HASH);
	return false;
};

/**
 * Argon2id implementation of `PasswordHashDeps`.
 *
 * Pass as `password` in `AppDeps` / `CreateAppBackendOptions` for production use.
 */
export const argon2_password_deps: PasswordHashDeps = {
	hash_password,
	verify_password,
	verify_dummy
};
