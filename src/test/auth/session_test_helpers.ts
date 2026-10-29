/**
 * Shared setup for `session_cookie.{create,parse,process}.test.ts` and
 * `session_middleware.{,lifecycle.db}.test.ts`.
 *
 * @module
 */

import { create_keyring, type Keyring } from '#lib/auth/keyring.ts';
import type { SessionOptions } from '#lib/auth/session_cookie.ts';

export const TEST_KEY = 'a'.repeat(32);
export const OLD_KEY = 'b'.repeat(32);
export const TEST_IDENTITY = 'user-123';

/**
 * Build a keyring for a test, throwing with the refusal reasons when `key` is
 * not a valid keys value.
 */
export const create_test_keyring = (key: string = TEST_KEY): Keyring => {
	const result = create_keyring(key);
	if (!result.ok) throw new Error(`test keyring refused: ${result.errors.join('; ')}`);
	return result.keyring;
};

export const test_session_options: SessionOptions<string> = {
	cookie_name: 'test_session',
	encode_identity: (id) => id,
	decode_identity: (payload) => payload || null
};
