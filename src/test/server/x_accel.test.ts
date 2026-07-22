/**
 * Fail-loud validation of the X-Accel facts nginx location + the
 * make-impossible-states `XAccelConfig` gate.
 *
 * The TS twin of the Rust `fuz_fact_serving` `nginx.rs` unit tests: the bare
 * `validate_facts_internal_location` validator (internal passes; public &
 * missing fail loud) and the `create_x_accel_config` gate — a non-`internal;`
 * or missing facts location can't be turned into an `XAccelConfig`, so the
 * X-Accel serving path is structurally unreachable without the check.
 *
 * @module
 */

import { test, assert, describe } from 'vitest';

import {
	create_x_accel_config,
	validate_facts_internal_location,
	XAccelConfigError
} from '$lib/server/x_accel.ts';

describe('validate_facts_internal_location', () => {
	test('internal facts location passes', () => {
		const config = `
			server {
				location /api/ { proxy_pass http://app; }
				location /_facts/ {
					internal;
					alias /var/facts/;
				}
			}
		`;
		const result = validate_facts_internal_location(config, '/_facts/');
		assert.ok(result.ok, result.errors.join('; '));
		assert.deepEqual(result.errors, []);
	});

	test('public facts location fails loud', () => {
		const config = `
			server {
				location /_facts/ {
					alias /var/facts/;
				}
			}
		`;
		const result = validate_facts_internal_location(config, '/_facts/');
		assert.ok(!result.ok);
		assert.ok(result.errors[0]!.includes('internal'));
	});

	test('missing facts location fails loud', () => {
		const config = 'server { location /api/ { proxy_pass http://app; } }';
		const result = validate_facts_internal_location(config, '/_facts/');
		assert.ok(!result.ok);
		assert.ok(result.errors[0]!.includes('No nginx'));
	});

	test('trailing slashes are normalized on both sides', () => {
		// `location /_facts` (no slash) validated against prefix `/_facts/` (slash)
		// — both sides trim trailing slashes before comparing, so they match.
		const config = `
			server {
				location /_facts {
					internal;
					alias /var/facts/;
				}
			}
		`;
		const result = validate_facts_internal_location(config, '/_facts/');
		assert.ok(result.ok, result.errors.join('; '));
	});

	test('internal directive on a modified (=) location block is detected', () => {
		// The block path is the last whitespace token before the brace, so a
		// modifier (`=`, `^~`, …) doesn't hide the path from the match.
		const config = `
			server {
				location = /_facts/ {
					internal;
					alias /var/facts/;
				}
			}
		`;
		const result = validate_facts_internal_location(config, '/_facts/');
		assert.ok(result.ok, result.errors.join('; '));
	});
});

describe('create_x_accel_config', () => {
	test('an internal location yields a usable config carrying the prefix', () => {
		const config = `
			server {
				location /_facts/ {
					internal;
					alias /var/facts/;
				}
			}
		`;
		const x_accel = create_x_accel_config('/_facts/', config);
		assert.strictEqual(x_accel.redirect_prefix, '/_facts/');
	});

	test('a public location cannot be turned into an XAccelConfig (fail loud)', () => {
		const config = 'server { location /_facts/ { alias /var/facts/; } }';
		// The thrown error names the security failure and carries the validator errors.
		try {
			create_x_accel_config('/_facts/', config);
			assert.fail('expected create_x_accel_config to throw');
		} catch (err) {
			assert.ok(err instanceof XAccelConfigError);
			assert.ok(err.message.includes('internal'));
			assert.ok(err.errors.length > 0);
		}
	});

	test('a missing location cannot be turned into an XAccelConfig (fail loud)', () => {
		const config = 'server { location /api/ { proxy_pass http://app; } }';
		assert.throws(() => create_x_accel_config('/_facts/', config), XAccelConfigError);
	});
});
