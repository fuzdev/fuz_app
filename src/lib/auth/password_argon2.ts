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

import {hash, verify} from '@node-rs/argon2';

import type {PasswordHashDeps} from './password.js';

/**
 * Argon2id options following OWASP recommendations.
 *
 * @see https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
 */
/** @node-rs/argon2 `Algorithm.Argon2id` — const enum, cannot import with isolatedModules. */
const ARGON2ID = 2 as const;

const ARGON2_OPTIONS = {
	algorithm: ARGON2ID,
	memoryCost: 19456, // 19 MiB
	timeCost: 2,
	parallelism: 1,
};

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
	password_hash: string,
): Promise<boolean> => {
	try {
		return await verify(password_hash, password);
	} catch {
		return false;
	}
};

/** Cached dummy hash for timing attack resistance. */
let dummy_hash: string | null = null;

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
	if (!dummy_hash) {
		dummy_hash = await hash_password('dummy_password_for_timing_resistance');
	}
	await verify_password(password, dummy_hash);
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
	verify_dummy,
};
