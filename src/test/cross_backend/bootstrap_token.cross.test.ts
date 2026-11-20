/**
 * Bootstrap token-file parity: every backend refuses a token file that is the
 * token plus anything but one trailing LF — CRLF, a second LF, trailing
 * spaces, a leading LF — with the same body and the file left as it was, and
 * accepts the token plus one LF. A bootstrap whose token can't be burned (its
 * directory read-only) answers `500 token_file_undeletable`, rolls back, and
 * leaves the file and the window as they were; the keeper bootstrap that
 * follows burns the file.
 *
 * The answers were gathered by the project's `globalSetup` around the
 * keeper bootstrap (`bootstrap_token_probe.ts`), since bootstrap is one-shot
 * per backend. The accepted case is the keeper bootstrap itself: the probe
 * leaves the file as the token plus one LF, so a setup that got this far
 * bootstrapped through it — which also proves the undeletable attempt rolled
 * the lock and the account back.
 *
 * @module
 */

import { assert, describe, inject, test } from 'vitest';

import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INVALID_TOKEN,
	ERROR_TOKEN_FILE_UNDELETABLE
} from '#lib/http/error_schemas.ts';

import { BOOTSTRAP_TOKEN_FILE_REFUSED } from './bootstrap_token_probe.ts';
import './cross_test_types.ts';

describe('bootstrap token file', () => {
	const probe = inject('bootstrap_token_probe');

	test('the probe ran every refused spelling', () => {
		assert.deepEqual(
			probe.refused.map((r) => r.label),
			BOOTSTRAP_TOKEN_FILE_REFUSED.map(([label]) => label)
		);
	});

	test.each(BOOTSTRAP_TOKEN_FILE_REFUSED.map(([label]) => label))(
		'refuses a token file with %s, leaving it byte for byte',
		(label) => {
			const result = probe.refused.find((r) => r.label === label);
			assert.ok(result, `no probe result for ${label}`);
			assert.strictEqual(result.status, 401, `${label}: status`);
			assert.deepStrictEqual(result.body, { error: ERROR_INVALID_TOKEN }, `${label}: body`);
			assert.isTrue(result.file_intact, `${label}: the refusal left the file as written`);
		}
	);

	test('a token that cannot be burned refuses the bootstrap and leaves everything as it was', () => {
		const { bootstrap, file_intact, status_after } = probe.undeletable;
		assert.strictEqual(bootstrap.status, 500);
		assert.deepStrictEqual(bootstrap.body, { error: ERROR_TOKEN_FILE_UNDELETABLE });
		assert.isTrue(file_intact, 'the token file and its bytes survive');
		assert.strictEqual(status_after.status, 401);
		assert.deepStrictEqual(
			status_after.body,
			{ error: ERROR_AUTHENTICATION_REQUIRED, bootstrap_available: true },
			'the window stays open'
		);
	});

	test('the keeper bootstrap burned the token file', () => {
		assert.isTrue(probe.token_file_gone_after_bootstrap);
	});
});
