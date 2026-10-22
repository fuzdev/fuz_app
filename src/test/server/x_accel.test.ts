/**
 * Fail-loud validation of the X-Accel facts nginx location + the
 * make-impossible-states `XAccelConfig` gate.
 *
 * The TS twin of the Rust `fuz_fact_serving` `nginx.rs` unit tests, with
 * mirrored names. Most cases live in `x_accel_corpus.json`, a byte-identical
 * copy of the Rust crate's `tests/fixtures/x_accel_corpus.json`, so the same
 * configs get the same verdicts from both validators.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { test, assert, describe } from 'vitest';

import {
	create_x_accel_config,
	validate_facts_internal_location,
	XAccelConfigError
} from '#lib/server/x_accel.ts';
import { fact_security_header_directives } from '#lib/server/fact_security_headers.ts';

interface CorpusCase {
	name: string;
	prefix: string;
	config: string;
	ok: boolean;
	error?: string;
}

const corpus: { cases: Array<CorpusCase> } = JSON.parse(
	readFileSync(new URL('./x_accel_corpus.json', import.meta.url), 'utf8')
);

describe('validate_facts_internal_location', () => {
	test('corpus verdicts match', () => {
		assert.ok(corpus.cases.length > 0);
		const failures: Array<string> = [];
		for (const c of corpus.cases) {
			const result = validate_facts_internal_location(c.config, c.prefix);
			if (result.ok !== c.ok) {
				failures.push(`${c.name}: expected ok=${c.ok}, got ${JSON.stringify(result.errors)}`);
				continue;
			}
			if (c.error !== undefined && !result.errors.some((e) => e.includes(c.error!))) {
				failures.push(
					`${c.name}: no error contains ${JSON.stringify(c.error)}: ${JSON.stringify(result.errors)}`
				);
			}
		}
		assert.deepEqual(failures, []);
	});

	test('exported directives round trip', () => {
		const config = `server { location ^~ /_facts/ { internal; ${fact_security_header_directives().join(' ')} } }`;
		const result = validate_facts_internal_location(config, '/_facts/');
		assert.ok(result.ok, result.errors.join('; '));
	});

	test('errors name the location and line', () => {
		const config = 'server {\n  location ^~ /_facts/ { internal; }\n  location /_facts/ab/ { }\n}';
		const result = validate_facts_internal_location(config, '/_facts/');
		assert.ok(
			result.errors.some((e) => e.startsWith('`location /_facts/ab/` (line 3) must use `^~`')),
			JSON.stringify(result.errors)
		);
	});

	test('rejects root prefix', () => {
		const result = validate_facts_internal_location('server { }', '/');
		assert.ok(!result.ok);
		assert.ok(result.errors[0]!.includes('absolute path below'));
	});

	test('refuses deep nesting without overflowing', () => {
		// past the cap the parser stops recursing, so even a huge nesting is a clean refusal
		const depth = 100_000;
		const result = validate_facts_internal_location(
			'a {'.repeat(depth) + '}'.repeat(depth),
			'/_facts/'
		);
		assert.ok(!result.ok);
		assert.ok(result.errors[0]!.includes('blocks nested deeper than 64 levels'), result.errors[0]);
	});

	test('the security docs example passes', () => {
		// the facts block docs/security.md recommends must itself validate
		const doc = readFileSync(new URL('../../../docs/security.md', import.meta.url), 'utf8');
		const blocks = [...doc.matchAll(/```nginx\n([\s\S]*?)```/g)].map((m) => m[1]!);
		const facts_blocks = blocks.filter((b) => b.includes('/_facts/'));
		assert.strictEqual(facts_blocks.length, 1, 'expected one facts example block');
		const result = validate_facts_internal_location(`server {\n${facts_blocks[0]}}\n`, '/_facts/');
		assert.ok(result.ok, result.errors.join('; '));
	});
});

const SAFE =
	'server { location ^~ /_facts/ { internal; ' +
	'add_header X-Content-Type-Options "nosniff" always; ' +
	`add_header Content-Security-Policy "default-src 'none'; sandbox" always; } }`;

describe('create_x_accel_config', () => {
	test('x_accel config requires a safe location', () => {
		const x_accel = create_x_accel_config('/_facts/', SAFE);
		assert.strictEqual(x_accel.redirect_prefix, '/_facts/');
	});

	test('x_accel config rejects public location', () => {
		// a public location can't be turned into an XAccelConfig at all
		const config = 'server { location ^~ /_facts/ { alias /var/facts/; } }';
		try {
			create_x_accel_config('/_facts/', config);
			assert.fail('expected create_x_accel_config to throw');
		} catch (err) {
			assert.ok(err instanceof XAccelConfigError);
			assert.ok(err.message.includes('internal'));
			assert.ok(err.errors.length > 0);
		}
	});

	test('x_accel config rejects missing location', () => {
		const config = 'server { location /api/ { proxy_pass http://app; } }';
		assert.throws(() => create_x_accel_config('/_facts/', config), XAccelConfigError);
	});
});
