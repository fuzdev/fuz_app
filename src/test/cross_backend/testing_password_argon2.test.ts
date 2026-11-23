/**
 * Tests for `testing_password_argon2.ts` — the TS spine binary's hasher is the
 * twin of the Rust stub's `TestingArgon2idHasher`: a hash either mints, the
 * other verifies. The Rust-minted vector below is a hash the stub wrote at
 * bootstrap; the other direction, a TS-minted hash verified by the stub, runs
 * cross-process in `backend_swap.cross.test.ts` (a login on the stub with a
 * password the TS spine hashed).
 *
 * @module
 */

import { assert, test } from 'vitest';

import { testing_argon2_password_deps } from './testing_password_argon2.ts';

/** The PHC prefix both hashers write: Argon2id, version 19, the test parameters. */
const TESTING_PHC_PREFIX = '$argon2id$v=19$m=8,t=1,p=1$';

/** `RUST_MINTED_PASSWORD` as the Rust `TestingArgon2idHasher` hashed it. */
const RUST_MINTED_HASH =
	'$argon2id$v=19$m=8,t=1,p=1$3/8SFQtwXrC+7N0oofuojg$18vK8JMl4hMv+T7vB+0YtmO8BdsEsLJJInD1VBYLuLw';
const RUST_MINTED_PASSWORD = 'password_test_keeper';

test('a hash the Rust hasher minted verifies', async () => {
	assert.isTrue(
		await testing_argon2_password_deps.verify_password(RUST_MINTED_PASSWORD, RUST_MINTED_HASH)
	);
	assert.isFalse(
		await testing_argon2_password_deps.verify_password('password_test_other', RUST_MINTED_HASH)
	);
});

test('a TS-minted hash carries the Rust prefix, and verifies', async () => {
	const hash = await testing_argon2_password_deps.hash_password(RUST_MINTED_PASSWORD);
	assert.ok(hash.startsWith(TESTING_PHC_PREFIX), hash);
	assert.notStrictEqual(hash, RUST_MINTED_HASH, 'a fresh salt per hash');
	assert.isTrue(await testing_argon2_password_deps.verify_password(RUST_MINTED_PASSWORD, hash));
});
