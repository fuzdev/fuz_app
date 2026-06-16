/**
 * Shared setup for `session_cookie.{create,parse,process}.test.ts` and
 * `session_middleware.{,lifecycle.db}.test.ts`.
 *
 * @module
 */

import {create_keyring, type Keyring} from '$lib/auth/keyring.ts';
import type {SessionOptions} from '$lib/auth/session_cookie.ts';

export const TEST_KEY = 'a'.repeat(32);
export const OLD_KEY = 'b'.repeat(32);
export const TEST_IDENTITY = 'user-123';

export const create_test_keyring = (): Keyring => create_keyring(TEST_KEY)!;

export const test_session_options: SessionOptions<string> = {
	cookie_name: 'test_session',
	context_key: 'auth_session_id',
	encode_identity: (id) => id,
	decode_identity: (payload) => payload || null,
};
