/**
 * Shared setup for `session_cookie.{create,parse}.test.ts` and
 * `session_middleware.{,lifecycle.db}.test.ts`.
 *
 * @module
 */

import { create_keyring, type Keyring } from '#lib/auth/keyring.ts';

export const TEST_KEY = 'a'.repeat(32);
export const OLD_KEY = 'b'.repeat(32);
export const TEST_IDENTITY = 'user-123';
export const TEST_COOKIE_NAME = 'test_session';

/**
 * Build a keyring for a test, throwing with the refusal reasons when `key` is
 * not a valid keys value.
 */
export const create_test_keyring = (key: string = TEST_KEY): Keyring => {
	const result = create_keyring(key);
	if (!result.ok) throw new Error(`test keyring refused: ${result.errors.join('; ')}`);
	return result.keyring;
};
