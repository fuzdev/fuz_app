import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the **signed session cookie codec** over real
 * HTTP: which spellings of a correctly signed cookie each spine accepts.
 *
 * The cookie is `${token}:${expires_at}.${signature}`, the signature the padded
 * standard base64 of an HMAC-SHA256 MAC. Both spines must accept exactly one
 * spelling of a given signed payload, or a cookie that one spine refuses would
 * authenticate on the other. The suite holds the test keyring, so it signs
 * payloads itself and sends variants a lenient decoder would take:
 *
 * - **signature spelling** — the last data character bumped so the trailing
 *   bits are non-zero (`atob` decodes the same MAC), and the `=` padding
 *   dropped. Both must be refused.
 * - **`expires_at` spelling** — `+N`, ` N`, `N.0`, and an all-digit value past
 *   `u64::MAX` (the Rust spine parses it as `u64`), each signed with the real
 *   key. All must be refused. A leading-zero `0N` reads as `N` on both, so it
 *   still authenticates — the bound is on the value, not the digit count.
 *
 * The positive controls run first: re-signing the keeper cookie's payload
 * reproduces the cookie byte for byte (the suite's keyring is the backend's),
 * and that cookie authenticates. Authentication is probed with the
 * `account_verify` RPC action. The per-impl unit tests cover each codec
 * directly; this suite is what catches the two drifting apart.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { create_keyring, type Keyring } from '../../auth/keyring.ts';
import { ERROR_AUTHENTICATION_REQUIRED } from '../../http/error_schemas.ts';
import { cross_rpc_call, error_reason } from './cell_cross_helpers.ts';
import type { SetupTest, TestFixture } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';

/** Options for the session cookie codec parity suite. */
export interface SessionCookieCodecCrossTestOptions {
	/** Per-test fixture producer (cross-process). */
	readonly setup_test: SetupTest;
	/** The spine's session cookie name (`handle.config.cookie_name`). */
	readonly cookie_name: string;
	/**
	 * The backend's `SECRET_FUZ_COOKIE_KEYS` value
	 * (`handle.config.env.SECRET_FUZ_COOKIE_KEYS`) — the suite signs with its
	 * primary key.
	 */
	readonly cookie_keys: string;
	/** JSON-RPC endpoint path. Default `SPINE_RPC_PATH`. */
	readonly rpc_path?: string;
}

/** The base64 alphabet, in index order. */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** `u64::MAX + 1`, the smallest all-digit `expires_at` the Rust spine cannot parse. */
const U64_MAX_PLUS_ONE = '18446744073709551616';

/** Split a signed cookie value on its last `.` into payload and signature. */
const split_signed = (signed: string): { payload: string; signature: string } => {
	const dot = signed.lastIndexOf('.');
	assert.ok(dot !== -1, `signed cookie value has no '.' separator: ${signed}`);
	return { payload: signed.slice(0, dot), signature: signed.slice(dot + 1) };
};

/**
 * Bump the signature's last data character (index 42, which carries the MAC's
 * final 4 bits and 2 zero padding bits) to the next base64 character. That sets
 * a padding bit, which `atob` ignores, so the decoded MAC is unchanged.
 */
const bump_trailing_bits = (signature: string): string => {
	const last_data = signature[42]!;
	const index = BASE64_ALPHABET.indexOf(last_data);
	assert.ok(index !== -1 && index % 4 === 0, `unexpected final signature character: ${last_data}`);
	return signature.slice(0, 42) + BASE64_ALPHABET[index + 1]! + signature.slice(43);
};

export const describe_session_cookie_codec_cross_tests = (
	options: SessionCookieCodecCrossTestOptions
): void => {
	const { setup_test, cookie_name, cookie_keys } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	const keyring_result = create_keyring(cookie_keys);
	if (!keyring_result.ok) {
		throw new Error(`cookie_keys is not a valid keyring: ${keyring_result.errors.join('; ')}`);
	}
	const keyring: Keyring = keyring_result.keyring;

	/** The keeper's signed cookie value, with its verified `token` and `expires_at`. */
	const keeper_cookie = async (
		fixture: TestFixture
	): Promise<{ signed: string; token: string; expires_at: string }> => {
		const header = fixture.create_session_headers().cookie;
		assert.ok(header, 'the keeper session headers carry a cookie');
		const prefix = `${cookie_name}=`;
		assert.ok(header.startsWith(prefix), `the keeper cookie is named '${cookie_name}'`);
		const signed = header.slice(prefix.length);
		const verified = await keyring.verify(signed);
		assert.ok(verified, 'the keeper cookie verifies under cookie_keys');
		const sep = verified.value.lastIndexOf(':');
		assert.ok(sep !== -1, 'the keeper cookie payload is `token:expires_at`');
		return {
			signed,
			token: verified.value.slice(0, sep),
			expires_at: verified.value.slice(sep + 1)
		};
	};

	const verify_with = (fixture: TestFixture, signed: string) =>
		cross_rpc_call(fixture.fresh_transport(), rpc_path, 'account_verify', undefined, {
			cookie: `${cookie_name}=${signed}`
		});

	const assert_unauthenticated = async (
		fixture: TestFixture,
		signed: string,
		label: string
	): Promise<void> => {
		const result = await verify_with(fixture, signed);
		assert.strictEqual(result.ok, false, `${label}: must not authenticate`);
		assert.strictEqual(error_reason(result), ERROR_AUTHENTICATION_REQUIRED, label);
	};

	describe('session cookie codec parity', () => {
		test('controls: re-signing the keeper payload reproduces its cookie, which authenticates', async () => {
			const fixture = await setup_test();
			const { signed, token, expires_at } = await keeper_cookie(fixture);
			assert.strictEqual(
				await keyring.sign(`${token}:${expires_at}`),
				signed,
				'the suite keyring signs as the backend does'
			);
			const result = await verify_with(fixture, signed);
			assert.ok(result.ok, `the keeper cookie authenticates: ${JSON.stringify(result.error)}`);
		});

		test('a signature with non-zero trailing bits is refused', async () => {
			const fixture = await setup_test();
			const { payload, signature } = split_signed((await keeper_cookie(fixture)).signed);
			await assert_unauthenticated(
				fixture,
				`${payload}.${bump_trailing_bits(signature)}`,
				'non-zero trailing bits'
			);
		});

		test('an unpadded signature is refused', async () => {
			const fixture = await setup_test();
			const { payload, signature } = split_signed((await keeper_cookie(fixture)).signed);
			assert.ok(signature.endsWith('='), 'the canonical signature is padded');
			await assert_unauthenticated(fixture, `${payload}.${signature.slice(0, -1)}`, 'unpadded');
		});

		test('a non-canonical expires_at is refused even when signed', async () => {
			const fixture = await setup_test();
			const { token, expires_at } = await keeper_cookie(fixture);
			const variants: ReadonlyArray<readonly [string, string]> = [
				['plus sign', `+${expires_at}`],
				['leading space', ` ${expires_at}`],
				['decimal', `${expires_at}.0`],
				['past u64::MAX', U64_MAX_PLUS_ONE]
			];
			for (const [label, value] of variants) {
				const signed = await keyring.sign(`${token}:${value}`);
				await assert_unauthenticated(
					fixture,
					signed,
					`expires_at ${label} (${JSON.stringify(value)})`
				);
			}
		});

		test('a leading-zero expires_at reads as its value and authenticates', async () => {
			const fixture = await setup_test();
			const { token, expires_at } = await keeper_cookie(fixture);
			const signed = await keyring.sign(`${token}:0${expires_at}`);
			const result = await verify_with(fixture, signed);
			assert.ok(result.ok, `a leading zero authenticates: ${JSON.stringify(result.error)}`);
		});
	});
};
