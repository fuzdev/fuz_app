import { describe, test, assert, vi } from 'vitest';
import type { Handler } from 'hono';

import {
	ALLOWED_ORIGINS_ERROR_MESSAGES,
	format_allowed_origins_error,
	is_browser_context,
	parse_allowed_origins,
	should_allow_origin,
	verify_request_source
} from '#lib/http/origin.ts';
import { ERROR_FORBIDDEN_ORIGIN } from '#lib/http/error_schemas.ts';

// Test helpers
const create_mock_context = (headers: Record<string, string> = {}) => {
	const next = vi.fn();
	const json = vi.fn((data: unknown, status: number) => ({ data, status }));

	// Convert all header keys to lowercase for case-insensitive lookup
	const normalized_headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		normalized_headers[key.toLowerCase()] = value;
	}

	const c = {
		req: {
			header: (name: string) => normalized_headers[name.toLowerCase()]
		},
		json
	};

	return { c, next, json };
};

/** Parse an allowlist the test knows is valid. */
const parse_origins = (raw: string): Array<RegExp> => {
	const result = parse_allowed_origins(raw);
	if (!result.ok) throw new Error(`invalid allowlist: ${raw}`);
	return result.origins;
};

const test_middleware_allows = async (handler: Handler, headers: Record<string, string>) => {
	const { c, next } = create_mock_context(headers);
	await handler(c as any, next);
	assert.ok(next.mock.calls.length > 0, 'next should have been called');
};

const test_middleware_blocks = async (
	handler: Handler,
	headers: Record<string, string>,
	expected_error: string,
	expected_status = 403
) => {
	const { c, next, json } = create_mock_context(headers);
	const result = await handler(c as any, next);
	assert.strictEqual(next.mock.calls.length, 0, 'next should not have been called');
	assert.deepStrictEqual(json.mock.calls[0], [{ error: expected_error }, expected_status]);
	assert.deepStrictEqual(result, { data: { error: expected_error }, status: expected_status });
};

// The grammar and matcher are pinned row by row in the shared conformance
// table (`origin.conformance.test.ts`); these cases cover the API around it.

describe('parse_allowed_origins', () => {
	test('a valid value yields one matcher per entry', () => {
		const result = parse_allowed_origins(' http://localhost:3000 , https://*.example.com ');
		assert.ok(result.ok);
		assert.strictEqual(result.origins.length, 2);
		assert.ok(result.origins.every((p) => p instanceof RegExp));
	});

	test('a blank value is refused as no_origins, with no position', () => {
		for (const raw of ['', '  ', '\t\n']) {
			const result = parse_allowed_origins(raw);
			assert.ok(!result.ok, raw);
			assert.deepStrictEqual(result.errors, [{ kind: 'no_origins' }]);
		}
	});

	test('every refused entry is reported with its position and text', () => {
		const result = parse_allowed_origins(
			'http://localhost:3000, null ,https://a.example/,,ftp://x'
		);
		assert.ok(!result.ok);
		assert.deepStrictEqual(result.errors, [
			{ kind: 'missing_scheme', index: 2, entry: 'null' },
			{ kind: 'has_path', index: 3, entry: 'https://a.example/' },
			{ kind: 'empty_entry', index: 4, entry: '' },
			{ kind: 'unsupported_scheme', index: 5, entry: 'ftp://x' }
		]);
	});

	test('nothing is normalized: a form a browser would rewrite is refused', () => {
		for (const raw of [
			'https://example.com:443',
			'http://example.com:80',
			'http://[::ffff:127.0.0.1]:3000',
			'http://127.1',
			'https://b\u00fccher.example'
		]) {
			assert.ok(!parse_allowed_origins(raw).ok, raw);
		}
	});
});

describe('format_allowed_origins_error', () => {
	test('names the position, quotes the entry, and gives the reason', () => {
		assert.strictEqual(
			format_allowed_origins_error({ kind: 'has_path', index: 2, entry: 'http://a/' }),
			'entry 2 "http://a/" is refused: an origin ends at the host or port — no path, query, ' +
				'or fragment, and no trailing slash'
		);
	});

	test('a list-level refusal is the reason alone', () => {
		assert.strictEqual(
			format_allowed_origins_error({ kind: 'no_origins' }),
			'no origins supplied — list at least one'
		);
	});

	test('escapes control characters and bounds the excerpt', () => {
		const message = format_allowed_origins_error({
			kind: 'not_printable_ascii',
			index: 1,
			entry: 'http://a\u001b[31m' + 'x'.repeat(500)
		});
		assert.ok(!message.includes('\u001b'), message);
		assert.include(message, '\\u001b');
		assert.isBelow(message.length, 400);
	});

	test('escapes DEL, C1, bidi, and format characters as \\uXXXX', () => {
		const message = format_allowed_origins_error({
			kind: 'not_printable_ascii',
			index: 3,
			entry: 'http://a\u009b31m\u007f\u202e\ufeff b'
		});
		assert.strictEqual(
			message,
			'entry 3 "http://a\\u009b31m\\u007f\\u202e\\ufeff b" is refused: ' +
				ALLOWED_ORIGINS_ERROR_MESSAGES.not_printable_ascii
		);
		assert.match(message, /^[\x20-\x7e]*$/);
	});

	test('escapes the quote and backslash so the entry cannot close its quotes', () => {
		assert.include(
			format_allowed_origins_error({ kind: 'has_path', index: 1, entry: 'http://a/"\\' }),
			'"http://a/\\"\\\\"'
		);
	});
});

describe('should_allow_origin', () => {
	test('returns false for empty patterns', () => {
		assert.strictEqual(should_allow_origin('http://example.com', []), false);
	});

	test('refuses a value that is not visible ASCII, whatever the patterns', () => {
		assert.strictEqual(should_allow_origin('http://caf\u00e9', [/./]), false);
		assert.strictEqual(should_allow_origin('http://a b', [/./]), false);
	});
});

describe('verify_request_source middleware', () => {
	const allowed_patterns = parse_origins(
		'http://localhost:3000,https://*.example.com,http://[::1]:3000,https://[2001:db8::1]:*'
	);
	const middleware = verify_request_source(allowed_patterns);

	describe('origin header', () => {
		test('allows matching origins', async () => {
			await test_middleware_allows(middleware, {
				origin: 'http://localhost:3000'
			});
			await test_middleware_allows(middleware, {
				origin: 'https://sub.example.com'
			});
		});

		test('allows case-insensitive domain matching', async () => {
			await test_middleware_allows(middleware, {
				origin: 'http://LOCALHOST:3000'
			});
			await test_middleware_allows(middleware, {
				origin: 'https://SUB.Example.COM'
			});
			await test_middleware_allows(middleware, {
				origin: 'https://Api.EXAMPLE.com'
			});
		});

		test('blocks non-matching origins', async () => {
			await test_middleware_blocks(
				middleware,
				{ origin: 'http://evil.com' },
				ERROR_FORBIDDEN_ORIGIN
			);
		});

		test('rejects literal "null" Origin header', async () => {
			const null_middleware = verify_request_source(parse_origins('https://example.com'));
			const { c, next, json } = create_mock_context({ Origin: 'null' });
			await null_middleware(c as any, next as any);
			assert.strictEqual(json.mock.calls.length, 1);
			assert.strictEqual(json.mock.calls[0]![1], 403);
		});

		test('allows IPv6 origins', async () => {
			await test_middleware_allows(middleware, {
				origin: 'http://[::1]:3000'
			});
			await test_middleware_allows(middleware, {
				origin: 'https://[2001:db8::1]'
			});
			await test_middleware_allows(middleware, {
				origin: 'https://[2001:db8::1]:8443'
			});
		});

		test('blocks non-matching IPv6 origins', async () => {
			await test_middleware_blocks(
				middleware,
				{ origin: 'http://[::1]:8080' },
				ERROR_FORBIDDEN_ORIGIN
			);
			await test_middleware_blocks(
				middleware,
				{ origin: 'https://[2001:db8::2]:443' },
				ERROR_FORBIDDEN_ORIGIN
			);
		});

		test('allowed origin passes regardless of referer', async () => {
			// Referer is ignored entirely (Origin-only posture); allowed Origin
			// passes whether Referer is allowed, disallowed, or absent.
			await test_middleware_allows(middleware, {
				origin: 'http://localhost:3000',
				referer: 'http://evil.com/page'
			});
		});

		test('rogue origin blocks regardless of referer', async () => {
			// Mirror of the allow-direction test above. Rogue Origin is rejected
			// even when Referer is allowed — Referer never affects the decision.
			await test_middleware_blocks(
				middleware,
				{ origin: 'http://evil.com', referer: 'http://localhost:3000/page' },
				ERROR_FORBIDDEN_ORIGIN
			);
		});
	});

	describe('origin values a browser never sends', () => {
		test('a duplicated Origin, as the runtimes join it, is refused', async () => {
			await test_middleware_blocks(
				middleware,
				{ origin: 'http://localhost:3000, http://localhost:3000' },
				ERROR_FORBIDDEN_ORIGIN
			);
		});

		test('an Origin that is not visible ASCII is refused, not read as absent', async () => {
			await test_middleware_blocks(
				middleware,
				{ origin: 'http://localhost:3000\u00e9' },
				ERROR_FORBIDDEN_ORIGIN
			);
		});
	});

	describe('referer header (Origin-only posture, Referer ignored)', () => {
		// both spines verify request source via Origin
		// only — Fetch spec mandates Origin on every unsafe method, so the
		// Referer arm was inert on modern browsers and only widened the
		// accepted-shape envelope. These tests pin the contract: a request
		// carrying only Referer (allowed OR disallowed) passes through; the
		// middleware never inspects it.
		test('passes through with allowed referer (no origin)', async () => {
			await test_middleware_allows(middleware, {
				referer: 'http://localhost:3000/some/page'
			});
		});

		test('passes through with disallowed referer (no origin)', async () => {
			// Pre-Origin-only this returned 403 forbidden_referer. After the
			// drop, Referer is no longer consulted — token auth is the
			// security control for non-browser callers (which cannot ride
			// an auto-attached session cookie).
			await test_middleware_allows(middleware, {
				referer: 'http://evil.com/page'
			});
		});

		test('passes through with malformed referer (no origin)', async () => {
			await test_middleware_allows(middleware, {
				referer: 'not-a-valid-url'
			});
		});

		test('passes through with IPv6 referer (no origin)', async () => {
			await test_middleware_allows(middleware, {
				referer: 'http://[::2]:3000/page'
			});
		});
	});

	describe('direct access (no headers)', () => {
		test('allows requests with no origin or referer', async () => {
			await test_middleware_allows(middleware, {});
		});

		test('allows requests with other headers but no origin/referer', async () => {
			await test_middleware_allows(middleware, {
				'user-agent': 'curl/7.64.1',
				accept: '*/*'
			});
		});

		test('allows requests with only sec-fetch-site', async () => {
			await test_middleware_allows(middleware, {
				'sec-fetch-site': 'none'
			});
		});

		test('allows cross-site requests when explicitly allowed by origin', async () => {
			await test_middleware_allows(middleware, {
				'sec-fetch-site': 'cross-site',
				origin: 'http://localhost:3000'
			});
		});
	});

	describe('empty allowed patterns', () => {
		const strict_middleware = verify_request_source([]);

		test('blocks all origin requests', async () => {
			await test_middleware_blocks(
				strict_middleware,
				{ origin: 'http://localhost:3000' },
				ERROR_FORBIDDEN_ORIGIN
			);
		});

		test('allows referer requests (Referer ignored under Origin-only posture)', async () => {
			// Even with an empty allowlist that rejects every Origin, a request
			// carrying only Referer passes through — the middleware no longer
			// consults the Referer header at all.
			await test_middleware_allows(strict_middleware, {
				referer: 'http://localhost:3000/page'
			});
		});

		test('still allows direct access (no headers)', async () => {
			await test_middleware_allows(strict_middleware, {});
		});
	});

	describe('header case sensitivity', () => {
		test('headers are case-insensitive', async () => {
			await test_middleware_allows(middleware, {
				Origin: 'http://localhost:3000'
			});
			await test_middleware_allows(middleware, {
				ORIGIN: 'http://localhost:3000'
			});
			await test_middleware_allows(middleware, {
				Referer: 'http://localhost:3000/page'
			});
			await test_middleware_allows(middleware, {
				REFERER: 'http://localhost:3000/page'
			});
		});
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
			headers: { Origin: '' },
			patterns: 'https://example.com',
			expected: 'block',
			expected_error: ERROR_FORBIDDEN_ORIGIN
		},
		{
			name: 'empty Referer header passes through (Referer no longer consulted)',
			headers: { Referer: '' },
			patterns: 'https://example.com',
			expected: 'allow',
			expected_error: ''
		},
		{
			name: 'malformed referer passes through (Referer no longer consulted)',
			headers: { Referer: 'not-a-url-at-all' },
			patterns: 'https://example.com',
			expected: 'allow',
			expected_error: ''
		},
		{
			name: 'referer with no parseable origin passes through (Referer no longer consulted)',
			headers: { Referer: ':::bad:::' },
			patterns: 'https://example.com',
			expected: 'allow',
			expected_error: ''
		},
		{
			name: 'Origin with default HTTPS port 443 does not match portless pattern',
			// URL normalizes https://example.com:443 → https://example.com in the origin
			// but the Origin header value is sent as-is by the client
			headers: { Origin: 'https://example.com:443' },
			patterns: 'https://example.com',
			expected: 'block',
			expected_error: ERROR_FORBIDDEN_ORIGIN
		},
		{
			name: 'Origin with default HTTP port 80 does not match portless pattern',
			headers: { Origin: 'http://example.com:80' },
			patterns: 'http://example.com',
			expected: 'block',
			expected_error: ERROR_FORBIDDEN_ORIGIN
		}
	];

	for (const tc of edge_case_table) {
		test(tc.name, async () => {
			const allowed = parse_origins(tc.patterns);
			const handler = verify_request_source(allowed);

			if (tc.expected === 'block') {
				await test_middleware_blocks(handler, tc.headers, tc.expected_error);
			} else {
				await test_middleware_allows(handler, tc.headers);
			}
		});
	}
});

describe('is_browser_context', () => {
	test('no Origin/Referer → not browser context', () => {
		const { c } = create_mock_context();
		assert.strictEqual(is_browser_context(c as any), false);
	});

	test('Origin present → browser context', () => {
		const { c } = create_mock_context({ Origin: 'https://app.example' });
		assert.strictEqual(is_browser_context(c as any), true);
	});

	test('Referer present → browser context', () => {
		const { c } = create_mock_context({ Referer: 'https://app.example/page' });
		assert.strictEqual(is_browser_context(c as any), true);
	});

	test('both present → browser context', () => {
		const { c } = create_mock_context({
			Origin: 'https://app.example',
			Referer: 'https://app.example/page'
		});
		assert.strictEqual(is_browser_context(c as any), true);
	});

	test('empty-string Origin still counts as browser context (!== undefined)', () => {
		// Mirrors the bearer/daemon-token discard: an abnormal empty Origin is
		// still browser context, never a legitimate loopback credential.
		const { c } = create_mock_context({ Origin: '' });
		assert.strictEqual(is_browser_context(c as any), true);
	});
});
