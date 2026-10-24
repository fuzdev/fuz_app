/**
 * Bootstrap token-file parity: every backend refuses a token file that is the
 * token plus anything but one trailing LF — CRLF, a second LF, trailing
 * spaces, a leading LF — and accepts the token plus one LF.
 *
 * The answers were gathered by the project's `globalSetup` in the
 * pre-bootstrap window (`bootstrap_token_probe.ts`), since bootstrap is
 * one-shot per backend. The accepted case is the keeper bootstrap itself: the
 * probe leaves the file as the token plus one LF, so a setup that got this far
 * bootstrapped through it.
 *
 * @module
 */

import { assert, describe, inject, test } from 'vitest';

import { ERROR_INVALID_TOKEN } from '#lib/http/error_schemas.ts';

import { BOOTSTRAP_TOKEN_FILE_REFUSED } from './bootstrap_token_probe.ts';
import './cross_test_types.ts';

describe('bootstrap token file', () => {
	const probe = inject('bootstrap_token_probe');

	test('the probe ran every refused spelling', () => {
		assert.deepEqual(
			probe.map((r) => r.label),
			BOOTSTRAP_TOKEN_FILE_REFUSED.map(([label]) => label)
		);
	});

	test.each(BOOTSTRAP_TOKEN_FILE_REFUSED.map(([label]) => label))(
		'refuses a token file with %s',
		(label) => {
			const result = probe.find((r) => r.label === label);
			assert.ok(result, `no probe result for ${label}`);
			assert.strictEqual(result.status, 401, `${label}: status`);
			assert.strictEqual(result.error, ERROR_INVALID_TOKEN, `${label}: error`);
		}
	);
});
