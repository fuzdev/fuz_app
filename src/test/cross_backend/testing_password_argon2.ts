/**
 * Test-only Argon2id password hashing for the TS spine binary — twin of the
 * Rust `testing_spine_stub`'s `fuz_testing::TestingArgon2idHasher`: the
 * production algorithm and PHC encoding at weakened parameters (`m=8,t=1,p=1`),
 * a few milliseconds a hash.
 *
 * The binary hashes as the Rust stub does, so the `password_hash` each spine
 * writes has one shape — the database-state differential compares its
 * parameter prefix — and a login exercises a real Argon2id verify rather
 * than the in-process suites' string compare (`stub_password_deps`).
 * **Never wire into a production server**: it lives under `src/test/`,
 * outside the package build.
 *
 * @module
 */

import { hash, verify } from '@node-rs/argon2';

import type { PasswordHashDeps } from '#lib/auth/password.ts';

/** @node-rs/argon2 `Algorithm.Argon2id` — const enum, cannot import with isolatedModules. */
const ARGON2ID = 2 as const;

/** The Rust `TEST_M_COST` / `TEST_T_COST` / `TEST_P_COST`. */
const TESTING_ARGON2_OPTIONS = {
	algorithm: ARGON2ID,
	memoryCost: 8,
	timeCost: 1,
	parallelism: 1
};

/**
 * Verified against on an account-lookup miss, at the test parameters —
 * byte-identical with the Rust `TESTING_DUMMY_HASH`.
 */
const TESTING_DUMMY_HASH =
	'$argon2id$v=19$m=8,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const verify_password = async (password: string, password_hash: string): Promise<boolean> => {
	try {
		return await verify(password_hash, password);
	} catch {
		return false;
	}
};

/** `PasswordHashDeps` over Argon2id at the test parameters. */
export const testing_argon2_password_deps: PasswordHashDeps = {
	hash_password: (password) => hash(password, TESTING_ARGON2_OPTIONS),
	verify_password,
	verify_dummy: async (password) => {
		await verify_password(password, TESTING_DUMMY_HASH);
		return false;
	}
};
