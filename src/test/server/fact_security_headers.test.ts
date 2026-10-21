/**
 * Pins the fact hardening header constants and their rendered nginx lines.
 *
 * The Rust twin `fuz_fact_serving::fact_security_headers` pins the same
 * literals (`constants_match_the_ts_twin`) — change both together.
 *
 * @module
 */

import { test, assert } from 'vitest';

import {
	FACT_CONTENT_SECURITY_POLICY,
	FACT_SECURITY_HEADERS,
	FACT_X_CONTENT_TYPE_OPTIONS,
	fact_security_header_directives
} from '#lib/server/fact_security_headers.ts';

test('constants match the Rust twin', () => {
	assert.strictEqual(FACT_X_CONTENT_TYPE_OPTIONS, 'nosniff');
	assert.strictEqual(FACT_CONTENT_SECURITY_POLICY, "default-src 'none'; sandbox");
	assert.deepEqual(Object.entries(FACT_SECURITY_HEADERS), [
		['X-Content-Type-Options', 'nosniff'],
		['Content-Security-Policy', "default-src 'none'; sandbox"]
	]);
	assert.deepEqual(fact_security_header_directives(), [
		'add_header X-Content-Type-Options "nosniff" always;',
		`add_header Content-Security-Policy "default-src 'none'; sandbox" always;`
	]);
});
