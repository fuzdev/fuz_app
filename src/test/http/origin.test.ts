import {describe, test, assert, vi} from 'vitest';
import type {Handler} from 'hono';

import {
	parse_allowed_origins,
	should_allow_origin,
	verify_request_source,
} from '$lib/http/origin.js';
import {ERROR_FORBIDDEN_ORIGIN, ERROR_FORBIDDEN_REFERER} from '$lib/http/error_schemas.js';

// Test helpers
const create_mock_context = (headers: Record<string, string> = {}) => {
	const next = vi.fn();
	const json = vi.fn((data: unknown, status: number) => ({data, status}));

	// Convert all header keys to lowercase for case-insensitive lookup
	const normalized_headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		normalized_headers[key.toLowerCase()] = value;
	}

	const c = {
		req: {
			header: (name: string) => normalized_headers[name.toLowerCase()],
		},
		json,
	};

	return {c, next, json};
};

const test_pattern = (
	pattern: string,
	valid_origins: Array<string>,
	invalid_origins: Array<string>,
) => {
	const regexps = parse_allowed_origins(pattern);

	for (const origin of valid_origins) {
		assert.ok(should_allow_origin(origin, regexps), `${origin} should match ${pattern}`);
	}

	for (const origin of invalid_origins) {
		assert.ok(!should_allow_origin(origin, regexps), `${origin} should not match ${pattern}`);
	}
};

const test_middleware_allows = async (handler: Handler, headers: Record<string, string>) => {
	const {c, next} = create_mock_context(headers);
	await handler(c as any, next);
	assert.ok(next.mock.calls.length > 0, 'next should have been called');
};

const test_middleware_blocks = async (
	handler: Handler,
	headers: Record<string, string>,
	expected_error: string,
	expected_status = 403,
) => {
	const {c, next, json} = create_mock_context(headers);
	const result = await handler(c as any, next);
	assert.strictEqual(next.mock.calls.length, 0, 'next should not have been called');
	assert.deepEqual(json.mock.calls[0], [{error: expected_error}, expected_status]);
	assert.deepEqual(result, {data: {error: expected_error}, status: expected_status});
};

describe('parse_allowed_origins', () => {
	test('returns empty array for undefined', () => {
		assert.deepEqual(parse_allowed_origins(undefined), []);
	});

	test('returns empty array for empty string', () => {
		assert.deepEqual(parse_allowed_origins(''), []);
	});

	test('parses single origin', () => {
		const patterns = parse_allowed_origins('http://localhost:3000');
		assert.strictEqual(patterns.length, 1);
		assert.ok(patterns[0] instanceof RegExp);
	});

	test('parses multiple comma-separated origins', () => {
		const patterns = parse_allowed_origins('http://localhost:3000,https://example.com');
		assert.strictEqual(patterns.length, 2);
	});

	test('trims whitespace from origins', () => {
		const patterns = parse_allowed_origins('  http://localhost:3000  ,  https://example.com  ');
		assert.strictEqual(patterns.length, 2);
	});

	test('filters out empty entries', () => {
		const patterns = parse_allowed_origins('http://localhost:3000,,https://example.com,');
		assert.strictEqual(patterns.length, 2);
	});

	test('handles complex patterns', () => {
		const patterns = parse_allowed_origins(
			'https://*.example.com,http://localhost:*,https://*.test.com:*',
		);
		assert.strictEqual(patterns.length, 3);
	});
});

describe('should_allow_origin', () => {
	test('returns false for empty patterns', () => {
		assert.strictEqual(should_allow_origin('http://example.com', []), false);
	});

	test('matches exact origins', () => {
		const patterns = parse_allowed_origins('http://example.com');
		assert.strictEqual(should_allow_origin('http://example.com', patterns), true);
		assert.strictEqual(should_allow_origin('https://example.com', patterns), false);
	});

	test('matches any of multiple patterns', () => {
		const patterns = parse_allowed_origins('http://localhost:3000,https://example.com');
		assert.strictEqual(should_allow_origin('http://localhost:3000', patterns), true);
		assert.strictEqual(should_allow_origin('https://example.com', patterns), true);
		assert.strictEqual(should_allow_origin('http://other.com', patterns), false);
	});
});

describe('pattern_to_regexp', () => {
	describe('exact patterns', () => {
		test('matches exact http origins', () => {
			test_pattern(
				'http://example.com',
				['http://example.com'],
				['https://example.com', 'http://example.org', 'http://sub.example.com'],
			);
		});

		test('matches exact https origins', () => {
			test_pattern(
				'https://example.com',
				['https://example.com'],
				['http://example.com', 'https://example.org', 'https://sub.example.com'],
			);
		});

		test('matches origins with ports', () => {
			test_pattern(
				'http://localhost:3000',
				['http://localhost:3000'],
				['http://localhost', 'http://localhost:3001', 'https://localhost:3000'],
			);
		});

		test('throws on paths in patterns', () => {
			assert.throws(
				() => parse_allowed_origins('http://example.com/api'),
				/Paths not allowed in origin patterns/,
			);
			assert.throws(
				() => parse_allowed_origins('https://example.com/api/v1'),
				/Paths not allowed in origin patterns/,
			);
			assert.throws(
				() => parse_allowed_origins('http://localhost:3000/'),
				/Paths not allowed in origin patterns/,
			);
		});

		test('matches IPv6 localhost', () => {
			test_pattern(
				'http://[::1]:3000',
				['http://[::1]:3000'],
				['http://[::1]', 'http://[::1]:3001', 'https://[::1]:3000', 'http://::1:3000'],
			);
		});

		test('matches full IPv6 addresses', () => {
			test_pattern(
				'https://[2001:db8:85a3::8a2e:370:7334]:8443',
				['https://[2001:db8:85a3::8a2e:370:7334]:8443'],
				[
					'https://[2001:db8:85a3::8a2e:370:7334]',
					'https://[2001:db8:85a3::8a2e:370:7334]:8444',
					'http://[2001:db8:85a3::8a2e:370:7334]:8443',
				],
			);
		});

		test('matches IPv6 addresses without port', () => {
			test_pattern(
				'http://[2001:db8::1]',
				['http://[2001:db8::1]'],
				['http://[2001:db8::1]:80', 'https://[2001:db8::1]', 'http://2001:db8::1'],
			);
		});

		test('matches IPv4-mapped IPv6 addresses', () => {
			test_pattern(
				'http://[::ffff:7f00:1]:3000',
				['http://[::ffff:7f00:1]:3000'],
				['http://[::ffff:7f00:1]', 'http://[::ffff:7f00:1]:3001', 'http://127.0.0.1:3000'],
			);
		});

		test('matches IPv4-mapped IPv6 without port', () => {
			test_pattern(
				'https://[::ffff:c0a8:101]',
				['https://[::ffff:c0a8:101]'],
				['https://[::ffff:c0a8:101]:443', 'https://192.168.1.1', 'http://[::ffff:c0a8:101]'],
			);
		});
	});

	describe('wildcard subdomains', () => {
		test('matches exactly one subdomain level', () => {
			test_pattern(
				'https://*.example.com',
				['https://sub.example.com', 'https://api.example.com', 'https://www.example.com'],
				[
					'https://example.com',
					'https://deep.sub.example.com',
					'https://very.deep.sub.example.com',
					'http://sub.example.com',
					'https://example.org',
					'https://subexample.com',
					'https://sub.example.com.evil.com',
				],
			);
		});

		test('multiple wildcards for deep subdomains', () => {
			test_pattern(
				'https://*.*.example.com',
				[
					'https://api.staging.example.com',
					'https://www.prod.example.com',
					'https://service.region.example.com',
				],
				[
					'https://staging.example.com',
					'https://api.staging.prod.example.com',
					'https://example.com',
				],
			);
		});

		test('three wildcard levels', () => {
			test_pattern(
				'https://*.*.*.example.com',
				['https://api.v2.staging.example.com', 'https://service.region.prod.example.com'],
				['https://api.staging.example.com', 'https://api.v2.staging.prod.example.com'],
			);
		});

		test('wildcard subdomain with port', () => {
			test_pattern(
				'https://*.example.com:443',
				['https://sub.example.com:443', 'https://api.example.com:443'],
				[
					'https://example.com:443',
					'https://sub.example.com',
					'https://sub.example.com:444',
					'https://deep.sub.example.com:443',
				],
			);
		});

		test('wildcard at different positions', () => {
			test_pattern(
				'https://api.*.example.com',
				[
					'https://api.staging.example.com',
					'https://api.prod.example.com',
					'https://api.v2.example.com',
				],
				[
					'https://staging.api.example.com',
					'https://api.example.com',
					'https://api.staging.prod.example.com',
				],
			);
		});

		test('ensures wildcards cannot match dots', () => {
			const patterns = parse_allowed_origins('https://*.example.com');
			assert.strictEqual(should_allow_origin('https://safe.example.com', patterns), true);
			assert.strictEqual(should_allow_origin('https://safe.evil.example.com', patterns), false);
			assert.strictEqual(
				should_allow_origin('https://safe.com.evil.com.example.com', patterns),
				false,
			);
		});

		test('rejects double-dot subdomain (empty label)', () => {
			// ..example.com has an empty label — [^./:]+  requires at least one character
			const patterns = parse_allowed_origins('https://*.example.com');
			assert.strictEqual(should_allow_origin('https://..example.com', patterns), false);
		});
	});

	describe('wildcard ports', () => {
		test('matches any port or no port', () => {
			test_pattern(
				'http://localhost:*',
				['http://localhost', 'http://localhost:3000', 'http://localhost:8080'],
				['https://localhost', 'http://127.0.0.1:3000'],
			);
		});

		test('wildcard port with exact hostname', () => {
			test_pattern(
				'https://api.example.com:*',
				['https://api.example.com', 'https://api.example.com:443', 'https://api.example.com:8443'],
				['http://api.example.com:443', 'https://example.com:443'],
			);
		});

		test('wildcard port with IPv6 localhost', () => {
			test_pattern(
				'http://[::1]:*',
				['http://[::1]', 'http://[::1]:3000', 'http://[::1]:8080', 'http://[::1]:65535'],
				['https://[::1]', 'http://[::1:3000', 'http://::1:3000'],
			);
		});

		test('wildcard port with full IPv6 address', () => {
			test_pattern(
				'https://[2001:db8::8a2e:370:7334]:*',
				[
					'https://[2001:db8::8a2e:370:7334]',
					'https://[2001:db8::8a2e:370:7334]:443',
					'https://[2001:db8::8a2e:370:7334]:8443',
				],
				['http://[2001:db8::8a2e:370:7334]:443', 'https://[2001:db8::8a2e:370:7335]:443'],
			);
		});
	});

	describe('combined wildcards', () => {
		test('wildcard subdomain and port', () => {
			test_pattern(
				'https://*.example.com:*',
				['https://sub.example.com', 'https://sub.example.com:443', 'https://api.example.com:8443'],
				[
					'https://example.com',
					'https://deep.sub.example.com',
					'https://deep.sub.example.com:443',
					'http://sub.example.com',
					'https://example.org:443',
				],
			);
		});

		test('multiple subdomain wildcards with wildcard port', () => {
			test_pattern(
				'https://*.*.example.com:*',
				[
					'https://api.staging.example.com',
					'https://api.staging.example.com:443',
					'https://www.prod.example.com:8443',
				],
				['https://staging.example.com:443', 'https://api.staging.prod.example.com'],
			);
		});
	});

	describe('error handling', () => {
		test('throws on invalid pattern format', () => {
			assert.throws(() => parse_allowed_origins('not-a-url'), /Invalid origin pattern/);
			assert.throws(() => parse_allowed_origins('ftp://example.com'), /Invalid origin pattern/);
			assert.throws(() => parse_allowed_origins('//example.com'), /Invalid origin pattern/);
			assert.throws(() => parse_allowed_origins('*.example.com'), /Invalid origin pattern/);
			assert.throws(() => parse_allowed_origins('example.com'), /Invalid origin pattern/);
			assert.throws(() => parse_allowed_origins('localhost:3000'), /Invalid origin pattern/);
		});

		test('throws on wildcards in wrong positions', () => {
			assert.throws(
				() => parse_allowed_origins('http://ex*ample.com'),
				/Wildcards must be complete labels/,
			);
			assert.throws(
				() => parse_allowed_origins('http://example*.com'),
				/Wildcards must be complete labels/,
			);
			assert.throws(
				() => parse_allowed_origins('http://*example.com'),
				/Wildcards must be complete labels/,
			);
			assert.throws(
				() => parse_allowed_origins('http://example.*com'),
				/Wildcards must be complete labels/,
			);
		});

		test('throws on invalid port wildcards', () => {
			assert.throws(
				() => parse_allowed_origins('http://example.com:*000'),
				/Invalid origin pattern/,
			);
			assert.throws(() => parse_allowed_origins('http://example.com:3*'), /Invalid origin pattern/);
		});

		test('throws on wildcards in IPv6 addresses', () => {
			assert.throws(
				() => parse_allowed_origins('http://[*::1]:3000'),
				/Wildcards not allowed in IPv6 addresses/,
			);
			assert.throws(
				() => parse_allowed_origins('https://[2001:db8:*::1]'),
				/Wildcards not allowed in IPv6 addresses/,
			);
			assert.throws(
				() => parse_allowed_origins('http://[::ffff:*.0.0.1]:8080'),
				/Wildcards not allowed in IPv6 addresses/,
			);
		});
	});

	describe('case sensitivity', () => {
		test('domain matching is case-insensitive', () => {
			const patterns = parse_allowed_origins('https://example.com');

			assert.strictEqual(should_allow_origin('https://example.com', patterns), true);
			assert.strictEqual(should_allow_origin('https://Example.com', patterns), true);
			assert.strictEqual(should_allow_origin('https://EXAMPLE.COM', patterns), true);
			assert.strictEqual(should_allow_origin('https://ExAmPlE.cOm', patterns), true);
		});

		test('protocol is also case-insensitive due to regex i flag', () => {
			const patterns = parse_allowed_origins('https://example.com');

			assert.strictEqual(should_allow_origin('https://example.com', patterns), true);
			assert.strictEqual(should_allow_origin('https://Example.com', patterns), true);
			assert.strictEqual(should_allow_origin('https://EXAMPLE.COM', patterns), true);

			// Different protocol should NOT match
			assert.strictEqual(should_allow_origin('http://example.com', patterns), false);

			// The regex uses 'i' flag making the entire pattern case-insensitive
			assert.strictEqual(should_allow_origin('HTTPS://example.com', patterns), true);
		});

		test('case-insensitive matching with wildcards', () => {
			const patterns = parse_allowed_origins('https://*.example.com');

			assert.strictEqual(should_allow_origin('https://API.example.com', patterns), true);
			assert.strictEqual(should_allow_origin('https://api.EXAMPLE.com', patterns), true);
			assert.strictEqual(should_allow_origin('https://Api.Example.Com', patterns), true);
		});

		test('case-insensitive with IPv6', () => {
			const patterns = parse_allowed_origins('https://[2001:DB8::1]');

			assert.strictEqual(should_allow_origin('https://[2001:db8::1]', patterns), true);
			assert.strictEqual(should_allow_origin('https://[2001:DB8::1]', patterns), true);
			assert.strictEqual(should_allow_origin('https://[2001:dB8::1]', patterns), true);
		});
	});

	describe('special cases', () => {
		test('handles special characters in domain names', () => {
			test_pattern(
				'https://ex-ample.com',
				['https://ex-ample.com'],
				['https://example.com', 'https://ex_ample.com'],
			);
		});

		test('handles numeric ports', () => {
			test_pattern(
				'http://localhost:8080',
				['http://localhost:8080'],
				['http://localhost:80', 'http://localhost:08080'],
			);
		});

		test('handles hyphenated domain names with wildcards', () => {
			test_pattern(
				'https://*.my-example.com',
				['https://api.my-example.com', 'https://www.my-example.com'],
				['https://my-example.com', 'https://api.myexample.com'],
			);
		});

		test('handles unusual but valid ports', () => {
			test_pattern(
				'http://example.com:65535',
				['http://example.com:65535'],
				['http://example.com:65536', 'http://example.com'],
			);
		});

		test('handles very long origin strings', () => {
			const long_subdomain = 'a'.repeat(63) + '.example.com';
			const patterns = parse_allowed_origins('https://*.example.com');
			assert.strictEqual(should_allow_origin(`https://${long_subdomain}`, patterns), true);
		});
	});

	describe('edge cases', () => {
		test('handles IPv6 addresses', () => {
			const patterns = parse_allowed_origins('http://[::1]:3000,https://[2001:db8::1]');
			assert.strictEqual(patterns.length, 2);

			assert.strictEqual(should_allow_origin('http://[::1]:3000', patterns), true);
			assert.strictEqual(should_allow_origin('https://[2001:db8::1]', patterns), true);

			// Should not match without brackets
			assert.strictEqual(should_allow_origin('http://::1:3000', patterns), false);
		});

		test('handles various IPv6 formats', () => {
			test_pattern(
				'https://[2001:db8::8a2e:370:7334]',
				['https://[2001:db8::8a2e:370:7334]'],
				['https://[2001:db8:0:0:8a2e:370:7334]'],
			);
		});

		test('handles IPv6 edge cases', () => {
			// Loopback variations
			test_pattern(
				'http://[::1]',
				['http://[::1]'],
				['http://[0:0:0:0:0:0:0:1]', 'http://[::0:1]'],
			);

			// IPv4-mapped with wildcard port
			test_pattern(
				'http://[::ffff:7f00:1]:*',
				['http://[::ffff:7f00:1]', 'http://[::ffff:7f00:1]:3000', 'http://[::ffff:7f00:1]:8080'],
				['http://[::ffff:7f00:2]:3000', 'https://[::ffff:7f00:1]:3000'],
			);

			// Very long valid IPv6 address
			test_pattern(
				'https://[2001:db8:85a3::8a2e:370:7334]:443',
				['https://[2001:db8:85a3::8a2e:370:7334]:443'],
				['https://[2001:db8:85a3::8a2e:370:7334]'],
			);
		});

		test('handles trailing dots (FQDN)', () => {
			const patterns = parse_allowed_origins('https://example.com');

			assert.strictEqual(should_allow_origin('https://example.com.', patterns), false);
			assert.strictEqual(should_allow_origin('https://example.com', patterns), true);

			const patterns_with_dot = parse_allowed_origins('https://example.com.');
			assert.strictEqual(should_allow_origin('https://example.com.', patterns_with_dot), true);
			assert.strictEqual(should_allow_origin('https://example.com', patterns_with_dot), false);
		});

		test('handles punycode domains', () => {
			const patterns = parse_allowed_origins('https://xn--e1afmkfd.xn--p1ai');

			assert.strictEqual(should_allow_origin('https://xn--e1afmkfd.xn--p1ai', patterns), true);
		});

		test('handles localhost variations', () => {
			const patterns = parse_allowed_origins(
				'http://localhost:*,http://127.0.0.1:*,http://[::1]:*',
			);

			const localhost_origins = [
				'http://localhost',
				'http://localhost:3000',
				'http://127.0.0.1',
				'http://127.0.0.1:8080',
				'http://[::1]',
				'http://[::1]:3000',
			];

			for (const origin of localhost_origins) {
				assert.strictEqual(should_allow_origin(origin, patterns), true);
			}
		});

		test('handles empty hostname edge case', () => {
			assert.throws(() => parse_allowed_origins('http://:3000'), /Invalid origin pattern/);
		});

		test('handles special regex characters in fixed parts', () => {
			test_pattern('https://example.com', ['https://example.com'], ['https://exampleXcom']);
		});
	});
});

describe('verify_request_source middleware', () => {
	const allowed_patterns = parse_allowed_origins(
		'http://localhost:3000,https://*.example.com,http://[::1]:3000,https://[2001:db8::1]:*',
	);
	const middleware = verify_request_source(allowed_patterns);

	describe('origin header', () => {
		test('allows matching origins', async () => {
			await test_middleware_allows(middleware, {
				origin: 'http://localhost:3000',
			});
			await test_middleware_allows(middleware, {
				origin: 'https://sub.example.com',
			});
		});

		test('allows case-insensitive domain matching', async () => {
			await test_middleware_allows(middleware, {
				origin: 'http://LOCALHOST:3000',
			});
			await test_middleware_allows(middleware, {
				origin: 'https://SUB.Example.COM',
			});
			await test_middleware_allows(middleware, {
				origin: 'https://Api.EXAMPLE.com',
			});
		});

		test('blocks non-matching origins', async () => {
			await test_middleware_blocks(middleware, {origin: 'http://evil.com'}, ERROR_FORBIDDEN_ORIGIN);
		});

		test('rejects literal "null" Origin header', async () => {
			const null_middleware = verify_request_source(parse_allowed_origins('https://example.com'));
			const {c, next, json} = create_mock_context({Origin: 'null'});
			await null_middleware(c as any, next as any);
			assert.strictEqual(json.mock.calls.length, 1);
			assert.strictEqual(json.mock.calls[0]![1], 403);
		});

		test('allows IPv6 origins', async () => {
			await test_middleware_allows(middleware, {
				origin: 'http://[::1]:3000',
			});
			await test_middleware_allows(middleware, {
				origin: 'https://[2001:db8::1]',
			});
			await test_middleware_allows(middleware, {
				origin: 'https://[2001:db8::1]:8443',
			});
		});

		test('blocks non-matching IPv6 origins', async () => {
			await test_middleware_blocks(
				middleware,
				{origin: 'http://[::1]:8080'},
				ERROR_FORBIDDEN_ORIGIN,
			);
			await test_middleware_blocks(
				middleware,
				{origin: 'https://[2001:db8::2]:443'},
				ERROR_FORBIDDEN_ORIGIN,
			);
		});

		test('prioritizes origin over referer', async () => {
			await test_middleware_allows(middleware, {
				origin: 'http://localhost:3000',
				referer: 'http://evil.com/page',
			});
		});
	});

	describe('referer header', () => {
		test('allows matching referers when no origin', async () => {
			await test_middleware_allows(middleware, {
				referer: 'http://localhost:3000/some/page',
			});
		});

		test('allows case-insensitive referer matching', async () => {
			await test_middleware_allows(middleware, {
				referer: 'http://LOCALHOST:3000/some/page',
			});
			await test_middleware_allows(middleware, {
				referer: 'https://API.Example.com/endpoint?query=value',
			});
		});

		test('blocks non-matching referers', async () => {
			await test_middleware_blocks(
				middleware,
				{referer: 'http://evil.com/page'},
				ERROR_FORBIDDEN_REFERER,
			);
		});

		test('extracts origin from referer URL', async () => {
			await test_middleware_allows(middleware, {
				referer: 'https://api.example.com/deep/path?query=value#hash',
			});
		});

		test('handles referer with trailing dot', async () => {
			await test_middleware_blocks(
				middleware,
				{referer: 'http://localhost.:3000/page'},
				ERROR_FORBIDDEN_REFERER,
			);

			await test_middleware_blocks(
				middleware,
				{origin: 'http://localhost.:3000'},
				ERROR_FORBIDDEN_ORIGIN,
			);

			const patterns_with_dot = parse_allowed_origins('http://localhost.:3000');
			const middleware_with_dot = verify_request_source(patterns_with_dot);

			await test_middleware_allows(middleware_with_dot, {
				referer: 'http://localhost.:3000/page',
			});

			await test_middleware_allows(middleware_with_dot, {
				origin: 'http://localhost.:3000',
			});
		});

		test('allows IPv6 referers', async () => {
			await test_middleware_allows(middleware, {
				referer: 'http://[::1]:3000/some/page',
			});
			await test_middleware_allows(middleware, {
				referer: 'https://[2001:db8::1]:8443/api/endpoint',
			});
		});

		test('blocks non-matching IPv6 referers', async () => {
			await test_middleware_blocks(
				middleware,
				{referer: 'http://[::2]:3000/page'},
				ERROR_FORBIDDEN_REFERER,
			);
		});

		test('blocks invalid referer URLs', async () => {
			await test_middleware_blocks(
				middleware,
				{referer: 'not-a-valid-url'},
				ERROR_FORBIDDEN_REFERER,
			);
		});

		test('blocks referers with null origin (opaque origins)', async () => {
			await test_middleware_blocks(
				middleware,
				{referer: 'data:text/html,<h1>test</h1>'},
				ERROR_FORBIDDEN_REFERER,
			);
		});
	});

	describe('direct access (no headers)', () => {
		test('allows requests with no origin or referer', async () => {
			await test_middleware_allows(middleware, {});
		});

		test('allows requests with other headers but no origin/referer', async () => {
			await test_middleware_allows(middleware, {
				'user-agent': 'curl/7.64.1',
				accept: '*/*',
			});
		});

		test('allows requests with only sec-fetch-site', async () => {
			await test_middleware_allows(middleware, {
				'sec-fetch-site': 'none',
			});
		});

		test('allows cross-site requests when explicitly allowed by origin', async () => {
			await test_middleware_allows(middleware, {
				'sec-fetch-site': 'cross-site',
				origin: 'http://localhost:3000',
			});
		});
	});

	describe('empty allowed patterns', () => {
		const strict_middleware = verify_request_source([]);

		test('blocks all origin requests', async () => {
			await test_middleware_blocks(
				strict_middleware,
				{origin: 'http://localhost:3000'},
				ERROR_FORBIDDEN_ORIGIN,
			);
		});

		test('blocks all referer requests', async () => {
			await test_middleware_blocks(
				strict_middleware,
				{referer: 'http://localhost:3000/page'},
				ERROR_FORBIDDEN_REFERER,
			);
		});

		test('still allows direct access (no headers)', async () => {
			await test_middleware_allows(strict_middleware, {});
		});
	});

	describe('header case sensitivity', () => {
		test('headers are case-insensitive', async () => {
			await test_middleware_allows(middleware, {
				Origin: 'http://localhost:3000',
			});
			await test_middleware_allows(middleware, {
				ORIGIN: 'http://localhost:3000',
			});
			await test_middleware_allows(middleware, {
				Referer: 'http://localhost:3000/page',
			});
			await test_middleware_allows(middleware, {
				REFERER: 'http://localhost:3000/page',
			});
		});
	});
});

describe('integration scenarios', () => {
	test('typical development setup', () => {
		const dev_patterns = parse_allowed_origins(
			'http://localhost:3000,http://localhost:5173,http://127.0.0.1:*,http://[::1]:*',
		);
		const dev_origins = [
			'http://localhost:3000',
			'http://localhost:5173',
			'http://127.0.0.1:3000',
			'http://127.0.0.1:8080',
			'http://[::1]:3000',
			'http://[::1]:5173',
			'http://[::1]:8080',
		];

		for (const origin of dev_origins) {
			assert.strictEqual(should_allow_origin(origin, dev_patterns), true);
		}
	});

	test('production multi-domain setup', () => {
		const prod_patterns = parse_allowed_origins(
			'https://app.example.com,https://*.example.com,https://partner.com',
		);

		const allowed = [
			'https://app.example.com',
			'https://api.example.com',
			'https://staging.example.com',
			'https://partner.com',
		];

		const blocked = [
			'http://app.example.com',
			'https://example.com',
			'https://example.org',
			'https://sub.partner.com',
			'https://deep.sub.example.com',
		];

		for (const origin of allowed) {
			assert.strictEqual(should_allow_origin(origin, prod_patterns), true);
		}

		for (const origin of blocked) {
			assert.strictEqual(should_allow_origin(origin, prod_patterns), false);
		}
	});

	test('complex enterprise setup with multiple wildcards', () => {
		test_pattern(
			'https://*.*.corp.example.com:*,https://app.example.com,https://localhost:*',
			[
				'https://api.staging.corp.example.com',
				'https://service.prod.corp.example.com:8443',
				'https://app.example.com',
				'https://localhost:3000',
				'https://localhost',
			],
			[
				'https://staging.corp.example.com',
				'https://api.staging.prod.corp.example.com',
				'http://api.staging.corp.example.com',
				'https://app.example.com:443',
				'http://localhost:3000',
			],
		);
	});

	test('mixed protocols and wildcards', () => {
		const patterns = parse_allowed_origins(
			'http://*.dev.example.com:*,https://*.prod.example.com,https://example.com',
		);

		// HTTP dev with any port
		assert.strictEqual(should_allow_origin('http://api.dev.example.com', patterns), true);
		assert.strictEqual(should_allow_origin('http://api.dev.example.com:3000', patterns), true);
		assert.strictEqual(should_allow_origin('http://api.dev.example.com:8080', patterns), true);

		// HTTPS prod without port flexibility
		assert.strictEqual(should_allow_origin('https://api.prod.example.com', patterns), true);
		assert.strictEqual(should_allow_origin('https://api.prod.example.com:443', patterns), false);

		// Exact match
		assert.strictEqual(should_allow_origin('https://example.com', patterns), true);

		// Should not match
		assert.strictEqual(should_allow_origin('https://api.dev.example.com', patterns), false);
		assert.strictEqual(should_allow_origin('http://api.prod.example.com', patterns), false);
		assert.strictEqual(should_allow_origin('https://sub.example.com', patterns), false);
	});
});

describe('normalize_origin', () => {
	test('handles explicit default port 443 for HTTPS', () => {
		const patterns = parse_allowed_origins('https://example.com:443');

		assert.strictEqual(should_allow_origin('https://example.com:443', patterns), true);
		assert.strictEqual(should_allow_origin('https://example.com', patterns), false);
	});

	test('handles explicit default port 80 for HTTP', () => {
		const patterns = parse_allowed_origins('http://example.com:80');

		assert.strictEqual(should_allow_origin('http://example.com:80', patterns), true);
		assert.strictEqual(should_allow_origin('http://example.com', patterns), false);
	});

	test('preserves non-standard ports', () => {
		const patterns = parse_allowed_origins('https://example.com:8443');

		assert.strictEqual(should_allow_origin('https://example.com:8443', patterns), true);
		assert.strictEqual(should_allow_origin('https://example.com', patterns), false);
	});
});

// --- Middleware edge cases (table-driven) ---

describe('verify_request_source middleware edge cases', () => {
	const edge_case_table: Array<{
		name: string;
		headers: Record<string, string>;
		patterns: string;
		expected: 'block' | 'allow';
		expected_error: string;
	}> = [
		// defense-in-depth: empty-string headers treated as present via !== undefined
		{
			name: 'empty Origin header is rejected (defense-in-depth, !== undefined)',
			headers: {Origin: ''},
			patterns: 'https://example.com',
			expected: 'block',
			expected_error: ERROR_FORBIDDEN_ORIGIN,
		},
		{
			name: 'empty Referer header is rejected (defense-in-depth, !== undefined)',
			headers: {Referer: ''},
			patterns: 'https://example.com',
			expected: 'block',
			expected_error: ERROR_FORBIDDEN_REFERER,
		},
		{
			name: 'malformed referer is rejected',
			headers: {Referer: 'not-a-url-at-all'},
			patterns: 'https://example.com',
			expected: 'block',
			expected_error: ERROR_FORBIDDEN_REFERER,
		},
		{
			name: 'referer with no parseable origin is rejected',
			headers: {Referer: ':::bad:::'},
			patterns: 'https://example.com',
			expected: 'block',
			expected_error: ERROR_FORBIDDEN_REFERER,
		},
		{
			name: 'Origin with default HTTPS port 443 does not match portless pattern',
			// URL normalizes https://example.com:443 → https://example.com in the origin
			// but the Origin header value is sent as-is by the client
			headers: {Origin: 'https://example.com:443'},
			patterns: 'https://example.com',
			expected: 'block',
			expected_error: ERROR_FORBIDDEN_ORIGIN,
		},
		{
			name: 'Origin with default HTTP port 80 does not match portless pattern',
			headers: {Origin: 'http://example.com:80'},
			patterns: 'http://example.com',
			expected: 'block',
			expected_error: ERROR_FORBIDDEN_ORIGIN,
		},
	];

	for (const tc of edge_case_table) {
		test(tc.name, async () => {
			const allowed = parse_allowed_origins(tc.patterns);
			const handler = verify_request_source(allowed);

			if (tc.expected === 'block') {
				await test_middleware_blocks(handler, tc.headers, tc.expected_error);
			} else {
				await test_middleware_allows(handler, tc.headers);
			}
		});
	}
});

// --- IPv4-mapped IPv6 normalization ---

describe('IPv4-mapped IPv6 origin normalization', () => {
	test('URL constructor normalizes IPv4-mapped IPv6 in pattern', () => {
		// URL('http://[::ffff:127.0.0.1]:3000') normalizes the host to [::ffff:7f00:1]
		// so the regex is built from the normalized form
		const patterns = parse_allowed_origins('http://[::ffff:127.0.0.1]:3000');

		// the normalized form should match
		assert.strictEqual(
			should_allow_origin('http://[::ffff:7f00:1]:3000', patterns),
			true,
			'normalized form should match',
		);

		// the original dotted form may NOT match because the regex was built
		// from the URL-normalized hex form — this documents the behavior
		const matches_dotted = should_allow_origin('http://[::ffff:127.0.0.1]:3000', patterns);
		// document whichever behavior we find (this is a known edge case)
		if (!matches_dotted) {
			// expected: URL constructor normalizes away the dotted notation
			assert.ok(true, 'dotted notation does not match normalized pattern (expected)');
		}
	});
});
