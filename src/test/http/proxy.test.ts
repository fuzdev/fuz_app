/**
 * Tests for trusted proxy configuration and middleware.
 *
 * Covers IP normalization, CIDR matching, X-Forwarded-For resolution,
 * and the middleware integration with `get_client_ip`.
 *
 * @module
 */

import {describe, test, assert, vi} from 'vitest';
import {Hono} from 'hono';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {
	normalize_ip,
	parse_proxy_entry,
	is_trusted_ip,
	resolve_client_ip,
	create_proxy_middleware,
	create_proxy_middleware_spec,
	type ParsedProxy,
	get_client_ip,
} from '$lib/http/proxy.js';

// --- normalize_ip ---

describe('normalize_ip', () => {
	test('strips ::ffff: prefix from IPv4-mapped IPv6', () => {
		assert.strictEqual(normalize_ip('::ffff:127.0.0.1'), '127.0.0.1');
	});

	test('strips ::ffff: prefix from any IPv4-mapped address', () => {
		assert.strictEqual(normalize_ip('::ffff:10.0.0.1'), '10.0.0.1');
		assert.strictEqual(normalize_ip('::ffff:192.168.1.1'), '192.168.1.1');
	});

	test('lowercases IPv6 addresses', () => {
		assert.strictEqual(normalize_ip('FE80::1'), 'fe80::1');
		assert.strictEqual(normalize_ip('2001:DB8::ABCD'), '2001:db8::abcd');
	});

	test('does not strip ::ffff: from pure IPv6 (no dot in remainder)', () => {
		// ::ffff:1 is a valid IPv6 address, not an IPv4 mapping
		assert.strictEqual(normalize_ip('::ffff:1'), '::ffff:1');
	});

	test('passes through plain IPv4 unchanged', () => {
		assert.strictEqual(normalize_ip('127.0.0.1'), '127.0.0.1');
		assert.strictEqual(normalize_ip('10.0.0.1'), '10.0.0.1');
	});

	test('passes through plain IPv6 unchanged (already lowercase)', () => {
		assert.strictEqual(normalize_ip('::1'), '::1');
		assert.strictEqual(normalize_ip('fe80::1'), 'fe80::1');
	});

	test('is idempotent', () => {
		const inputs = ['::ffff:127.0.0.1', 'FE80::1', '127.0.0.1', '::1', 'unknown'];
		for (const input of inputs) {
			const once = normalize_ip(input);
			const twice = normalize_ip(once);
			assert.strictEqual(once, twice, `normalize_ip not idempotent for '${input}'`);
		}
	});

	test('handles non-IP strings safely', () => {
		assert.strictEqual(normalize_ip('unknown'), 'unknown');
		assert.strictEqual(normalize_ip(''), '');
		assert.strictEqual(normalize_ip('not-an-ip'), 'not-an-ip');
	});

	test('lowercases uppercase ::FFFF: prefix', () => {
		assert.strictEqual(normalize_ip('::FFFF:192.168.1.1'), '192.168.1.1');
	});
});

// --- parse_proxy_entry ---

describe('parse_proxy_entry', () => {
	test('parses plain IPv4 address', () => {
		const result = parse_proxy_entry('127.0.0.1');
		assert.deepStrictEqual(result, {type: 'ip', address: '127.0.0.1'});
	});

	test('parses plain IPv6 address', () => {
		const result = parse_proxy_entry('::1');
		assert.deepStrictEqual(result, {type: 'ip', address: '::1'});
	});

	test('normalizes plain IP to lowercase', () => {
		const result = parse_proxy_entry('FE80::1');
		assert.deepStrictEqual(result, {type: 'ip', address: 'fe80::1'});
	});

	test('normalizes IPv4-mapped IPv6 to plain IPv4', () => {
		const result = parse_proxy_entry('::ffff:127.0.0.1');
		assert.deepStrictEqual(result, {type: 'ip', address: '127.0.0.1'});
	});

	test('throws on invalid plain IP', () => {
		assert.throws(() => parse_proxy_entry('hello'), /Invalid proxy IP/);
		assert.throws(() => parse_proxy_entry('not-an-ip'), /Invalid proxy IP/);
	});

	test('parses IPv4 CIDR', () => {
		const result = parse_proxy_entry('10.0.0.0/8');
		assert.strictEqual(result.type, 'cidr');
		if (result.type === 'cidr') {
			assert.strictEqual(result.prefix, 8);
			assert.strictEqual(result.address_type, 'IPv4');
		}
	});

	test('parses IPv6 CIDR', () => {
		const result = parse_proxy_entry('fe80::/10');
		assert.strictEqual(result.type, 'cidr');
		if (result.type === 'cidr') {
			assert.strictEqual(result.prefix, 10);
			assert.strictEqual(result.address_type, 'IPv6');
		}
	});

	test('parses /32 as CIDR (not IP)', () => {
		const result = parse_proxy_entry('192.168.1.1/32');
		assert.strictEqual(result.type, 'cidr');
	});

	test('parses IPv6 /128 as CIDR', () => {
		const result = parse_proxy_entry('::1/128');
		assert.strictEqual(result.type, 'cidr');
		if (result.type === 'cidr') {
			assert.strictEqual(result.prefix, 128);
			assert.strictEqual(result.address_type, 'IPv6');
		}
	});

	test('parses IPv6 /0 as CIDR', () => {
		const result = parse_proxy_entry('::/0');
		assert.strictEqual(result.type, 'cidr');
		if (result.type === 'cidr') {
			assert.strictEqual(result.prefix, 0);
			assert.strictEqual(result.address_type, 'IPv6');
		}
	});

	test('throws on non-network-aligned IPv4 CIDR', () => {
		// 10.0.0.5/8 has host bits set — almost certainly a config mistake
		assert.throws(
			() => parse_proxy_entry('10.0.0.5/8'),
			/Non-network-aligned CIDR \(host bits set\)/,
		);
	});

	test('throws on non-network-aligned IPv6 CIDR', () => {
		assert.throws(
			() => parse_proxy_entry('fe80::1/10'),
			/Non-network-aligned CIDR \(host bits set\)/,
		);
	});

	test('throws on IPv4 CIDR prefix > 32', () => {
		assert.throws(
			() => parse_proxy_entry('10.0.0.0/33'),
			/Invalid CIDR prefix for IPv4 \(max 32\)/,
		);
	});

	test('throws on IPv6 CIDR prefix > 128', () => {
		assert.throws(() => parse_proxy_entry('::1/129'), /Invalid CIDR prefix for IPv6 \(max 128\)/);
	});

	test('throws on NaN CIDR prefix', () => {
		assert.throws(() => parse_proxy_entry('10.0.0.0/abc'), /Invalid CIDR prefix \(not a number\)/);
	});

	test('throws on negative CIDR prefix', () => {
		assert.throws(() => parse_proxy_entry('10.0.0.0/-1'), /Invalid CIDR prefix \(negative\)/);
	});

	test('throws on empty CIDR prefix', () => {
		assert.throws(() => parse_proxy_entry('10.0.0.0/'), /Invalid CIDR prefix \(not a number\)/);
	});

	test('throws on invalid CIDR network', () => {
		assert.throws(() => parse_proxy_entry('not-an-ip/8'), /Invalid proxy CIDR/);
	});

	test('throws on empty string', () => {
		assert.throws(() => parse_proxy_entry(''), /Invalid proxy IP/);
	});

	test('throws on float CIDR prefix', () => {
		assert.throws(
			() => parse_proxy_entry('10.0.0.0/8.5'),
			/Invalid CIDR prefix \(not an integer\)/,
		);
	});
});

// --- is_trusted_ip ---

describe('is_trusted_ip', () => {
	test('matches exact IPv4 address', () => {
		const proxies: Array<ParsedProxy> = [{type: 'ip', address: '127.0.0.1'}];
		assert.ok(is_trusted_ip('127.0.0.1', proxies));
		assert.ok(!is_trusted_ip('127.0.0.2', proxies));
	});

	test('matches exact IPv6 address', () => {
		const proxies: Array<ParsedProxy> = [{type: 'ip', address: '::1'}];
		assert.ok(is_trusted_ip('::1', proxies));
		assert.ok(!is_trusted_ip('::2', proxies));
	});

	test('matches IPv4 CIDR /8', () => {
		const proxies = [parse_proxy_entry('10.0.0.0/8')];
		assert.ok(is_trusted_ip('10.0.0.1', proxies));
		assert.ok(is_trusted_ip('10.255.255.255', proxies));
		assert.ok(!is_trusted_ip('11.0.0.1', proxies));
		assert.ok(!is_trusted_ip('9.255.255.255', proxies));
	});

	test('matches IPv4 CIDR /24', () => {
		const proxies = [parse_proxy_entry('192.168.1.0/24')];
		assert.ok(is_trusted_ip('192.168.1.0', proxies));
		assert.ok(is_trusted_ip('192.168.1.255', proxies));
		assert.ok(!is_trusted_ip('192.168.2.0', proxies));
	});

	test('matches IPv4 CIDR /32 (exact)', () => {
		const proxies = [parse_proxy_entry('10.0.0.1/32')];
		assert.ok(is_trusted_ip('10.0.0.1', proxies));
		assert.ok(!is_trusted_ip('10.0.0.2', proxies));
	});

	test('matches IPv4 CIDR /0 (all)', () => {
		const proxies = [parse_proxy_entry('0.0.0.0/0')];
		assert.ok(is_trusted_ip('1.2.3.4', proxies));
		assert.ok(is_trusted_ip('255.255.255.255', proxies));
	});

	test('matches IPv6 CIDR /10', () => {
		const proxies = [parse_proxy_entry('fe80::/10')];
		assert.ok(is_trusted_ip('fe80::1', proxies));
		assert.ok(is_trusted_ip('febf::1', proxies));
		assert.ok(!is_trusted_ip('fec0::1', proxies));
	});

	test('does not cross address families', () => {
		const proxies = [parse_proxy_entry('10.0.0.0/8')];
		// IPv6 address should not match IPv4 CIDR
		assert.ok(!is_trusted_ip('::1', proxies));
	});

	test('matches against multiple proxy entries', () => {
		const proxies = [
			parse_proxy_entry('127.0.0.1'),
			parse_proxy_entry('10.0.0.0/8'),
			parse_proxy_entry('::1'),
		];
		assert.ok(is_trusted_ip('127.0.0.1', proxies));
		assert.ok(is_trusted_ip('10.5.5.5', proxies));
		assert.ok(is_trusted_ip('::1', proxies));
		assert.ok(!is_trusted_ip('192.168.1.1', proxies));
	});

	test('matches IPv6 CIDR /128 (exact)', () => {
		const proxies = [parse_proxy_entry('::1/128')];
		assert.ok(is_trusted_ip('::1', proxies));
		assert.ok(!is_trusted_ip('::2', proxies));
	});

	test('matches IPv6 CIDR /0 (all)', () => {
		const proxies = [parse_proxy_entry('::/0')];
		assert.ok(is_trusted_ip('fe80::1', proxies));
		assert.ok(is_trusted_ip('2001:db8::1', proxies));
		assert.ok(is_trusted_ip('::1', proxies));
	});

	test('IPv4-mapped IPv6 matches plain IPv4 in config', () => {
		const proxies = [parse_proxy_entry('127.0.0.1')];
		assert.ok(is_trusted_ip('::ffff:127.0.0.1', proxies));
	});

	test('IPv4-mapped IPv6 in config matches plain IPv4 input', () => {
		// parse_proxy_entry normalizes ::ffff:127.0.0.1 to 127.0.0.1
		const proxies = [parse_proxy_entry('::ffff:127.0.0.1')];
		assert.ok(is_trusted_ip('127.0.0.1', proxies));
	});

	test('IPv4-mapped IPv6 matches IPv4 CIDR after normalization', () => {
		const proxies = [parse_proxy_entry('10.0.0.0/8')];
		assert.ok(is_trusted_ip('::ffff:10.1.2.3', proxies));
		assert.ok(!is_trusted_ip('::ffff:11.0.0.1', proxies));
	});

	test('IPv6 exact match is case-insensitive', () => {
		const proxies: Array<ParsedProxy> = [{type: 'ip', address: 'fe80::1'}];
		assert.ok(is_trusted_ip('fe80::1', proxies));
		assert.ok(is_trusted_ip('FE80::1', proxies));
		assert.ok(is_trusted_ip('Fe80::1', proxies));
	});

	test('mixed case IPv6 in config matches any case input', () => {
		// parse_proxy_entry normalizes to lowercase
		const proxies = [parse_proxy_entry('FE80::1')];
		assert.ok(is_trusted_ip('fe80::1', proxies));
		assert.ok(is_trusted_ip('FE80::1', proxies));
	});

	test('CIDR /16 matches within range and rejects outside', () => {
		const proxies = [parse_proxy_entry('10.1.0.0/16')];
		assert.ok(is_trusted_ip('10.1.0.1', proxies));
		assert.ok(is_trusted_ip('10.1.255.255', proxies));
		assert.ok(!is_trusted_ip('10.2.0.1', proxies));
	});

	test('returns false for malformed IP', () => {
		const proxies = [parse_proxy_entry('127.0.0.1')];
		assert.ok(!is_trusted_ip('not-an-ip', proxies));
	});

	test('returns false for empty proxy list', () => {
		assert.ok(!is_trusted_ip('127.0.0.1', []));
	});

	test('returns false for empty string IP', () => {
		const proxies = [parse_proxy_entry('127.0.0.1')];
		assert.ok(!is_trusted_ip('', proxies));
	});

	test('IPv4 /0 CIDR does not match IPv6 addresses', () => {
		// 0.0.0.0/0 is "all IPv4" — the cross-family guard must hold even for wildcard prefixes
		const proxies = [parse_proxy_entry('0.0.0.0/0')];
		assert.ok(!is_trusted_ip('::1', proxies));
		assert.ok(!is_trusted_ip('fe80::1', proxies));
	});

	test('IPv6 /0 CIDR does not match IPv4 addresses', () => {
		// ::/0 is "all IPv6" — must not bleed into IPv4 space
		const proxies = [parse_proxy_entry('::/0')];
		assert.ok(!is_trusted_ip('127.0.0.1', proxies));
		assert.ok(!is_trusted_ip('10.0.0.1', proxies));
	});
});

// --- resolve_client_ip ---

describe('resolve_client_ip', () => {
	const localhost = [parse_proxy_entry('127.0.0.1')];
	const multi_trusted = [parse_proxy_entry('127.0.0.1'), parse_proxy_entry('10.0.0.0/8')];

	test('single entry, untrusted — returns it', () => {
		assert.strictEqual(resolve_client_ip('203.0.113.1', localhost), '203.0.113.1');
	});

	test('single entry, trusted — returns it (edge case)', () => {
		assert.strictEqual(resolve_client_ip('127.0.0.1', localhost), '127.0.0.1');
	});

	test('two entries, rightmost trusted — returns leftmost', () => {
		assert.strictEqual(resolve_client_ip('203.0.113.1, 127.0.0.1', localhost), '203.0.113.1');
	});

	test('multi-hop chain, strips trusted proxies', () => {
		// client, cdn (10.x), nginx (127.0.0.1)
		assert.strictEqual(
			resolve_client_ip('203.0.113.1, 10.1.2.3, 127.0.0.1', multi_trusted),
			'203.0.113.1',
		);
	});

	test('multi-hop with untrusted intermediate — stops at first untrusted from right', () => {
		// client, untrusted_proxy, nginx
		const result = resolve_client_ip('spoofed, 198.51.100.1, 127.0.0.1', localhost);
		// 127.0.0.1 is trusted, 198.51.100.1 is not → stop, return it
		assert.strictEqual(result, '198.51.100.1');
	});

	test('all entries trusted — returns leftmost', () => {
		assert.strictEqual(resolve_client_ip('127.0.0.1, 10.0.0.1', multi_trusted), '127.0.0.1');
	});

	test('empty header — returns undefined', () => {
		assert.strictEqual(resolve_client_ip('', localhost), undefined);
	});

	test('whitespace-only entries are skipped', () => {
		assert.strictEqual(resolve_client_ip(' , , 203.0.113.1', localhost), '203.0.113.1');
	});

	test('trims whitespace from entries', () => {
		assert.strictEqual(resolve_client_ip('  203.0.113.1  , 127.0.0.1 ', localhost), '203.0.113.1');
	});

	test('all whitespace-only entries — returns undefined', () => {
		assert.strictEqual(resolve_client_ip(' , , ', localhost), undefined);
	});

	test('port-suffixed XFF entry treated as untrusted', () => {
		// Non-standard proxies may include ports (e.g. 203.0.113.1:8080).
		// The entry fails distinctRemoteAddr → treated as untrusted. Safe, but
		// rate limiting keys on the port-suffixed string. See NOTE in proxy.ts.
		const result = resolve_client_ip('spoofed, 203.0.113.1:8080, 127.0.0.1', localhost);
		// 127.0.0.1 trusted, 203.0.113.1:8080 is not (malformed) → stops there
		assert.strictEqual(result, '203.0.113.1:8080');
	});

	test('normalizes XFF entries with ::ffff: prefix', () => {
		// XFF contains IPv4-mapped form — returned value is normalized
		const result = resolve_client_ip('::ffff:203.0.113.1, 127.0.0.1', localhost);
		assert.strictEqual(result, '203.0.113.1');
	});

	test('normalizes XFF entries to lowercase', () => {
		const proxies = [parse_proxy_entry('::1')];
		const result = resolve_client_ip('FE80::ABCD, ::1', proxies);
		assert.strictEqual(result, 'fe80::abcd');
	});

	test('consecutive commas without spaces are treated as empty segments and skipped', () => {
		assert.strictEqual(resolve_client_ip('203.0.113.1,,127.0.0.1', localhost), '203.0.113.1');
	});

	test('malformed non-IP entry in chain is treated as untrusted', () => {
		// Malformed entry before trusted proxy — treated as untrusted (safe default)
		assert.strictEqual(resolve_client_ip('not-an-ip, 127.0.0.1', localhost), 'not-an-ip');
	});

	test('multiple malformed entries return rightmost untrusted', () => {
		assert.strictEqual(resolve_client_ip('garbage, also-bad, 127.0.0.1', localhost), 'also-bad');
	});

	describe('IPv6 in XFF chains', () => {
		test('resolves IPv6 loopback from XFF', () => {
			const trusted: Array<ParsedProxy> = [{type: 'ip', address: '127.0.0.1'}];
			const result = resolve_client_ip('::1, 203.0.113.50, 127.0.0.1', trusted);
			assert.strictEqual(result, '203.0.113.50');
		});

		test('resolves IPv4-mapped IPv6 in XFF', () => {
			const trusted: Array<ParsedProxy> = [{type: 'ip', address: '127.0.0.1'}];
			const result = resolve_client_ip('::ffff:203.0.113.50', trusted);
			assert.strictEqual(result, '203.0.113.50');
		});

		test('handles full IPv6 address in XFF', () => {
			const trusted: Array<ParsedProxy> = [{type: 'ip', address: '127.0.0.1'}];
			const result = resolve_client_ip('2001:db8::1', trusted);
			assert.strictEqual(result, '2001:db8::1');
		});

		test('handles mixed IPv4 and IPv6 in XFF chain', () => {
			const trusted: Array<ParsedProxy> = [
				{type: 'ip', address: '127.0.0.1'},
				{type: 'ip', address: '10.0.0.1'},
			];
			const result = resolve_client_ip('2001:db8::1, 10.0.0.1', trusted);
			assert.strictEqual(result, '2001:db8::1');
		});
	});
});

// --- create_proxy_middleware (integration) ---

describe('create_proxy_middleware', () => {
	/** Create a test app with proxy middleware and an echo route. */
	const create_test_app = (
		trusted_proxies: Array<string>,
		connection_ip: string | null = '127.0.0.1',
	): Hono => {
		const app = new Hono();
		app.use(
			'*',
			create_proxy_middleware({
				trusted_proxies,
				get_connection_ip: () => connection_ip ?? undefined,
			}),
		);
		app.get('/ip', (c) => c.json({ip: get_client_ip(c)}));
		return app;
	};

	test('trusted connection + X-Forwarded-For → resolves client IP', async () => {
		const app = create_test_app(['127.0.0.1']);
		const res = await app.request('/ip', {headers: {'X-Forwarded-For': '203.0.113.1'}});
		const body = await res.json();
		assert.strictEqual(body.ip, '203.0.113.1');
	});

	test('untrusted connection + X-Forwarded-For → ignores header, uses connection IP', async () => {
		const app = create_test_app(['10.0.0.0/8'], '192.168.1.1');
		const res = await app.request('/ip', {headers: {'X-Forwarded-For': 'spoofed'}});
		const body = await res.json();
		assert.strictEqual(body.ip, '192.168.1.1');
	});

	test('no X-Forwarded-For → uses connection IP', async () => {
		const app = create_test_app(['127.0.0.1']);
		const res = await app.request('/ip');
		const body = await res.json();
		assert.strictEqual(body.ip, '127.0.0.1');
	});

	test('no connection IP available → unknown', async () => {
		const app = create_test_app(['127.0.0.1'], null);
		const res = await app.request('/ip');
		const body = await res.json();
		assert.strictEqual(body.ip, 'unknown');
	});

	test('no connection IP + X-Forwarded-For → ignores header, returns unknown', async () => {
		const app = create_test_app(['127.0.0.1'], null);
		const res = await app.request('/ip', {headers: {'X-Forwarded-For': '203.0.113.1'}});
		const body = await res.json();
		assert.strictEqual(body.ip, 'unknown');
	});

	test('empty trusted_proxies → always uses connection IP', async () => {
		const app = create_test_app([], '192.168.1.1');
		const res = await app.request('/ip', {headers: {'X-Forwarded-For': 'spoofed'}});
		const body = await res.json();
		assert.strictEqual(body.ip, '192.168.1.1');
	});

	test('multi-hop chain with CIDR trusted proxies', async () => {
		const app = create_test_app(['127.0.0.1', '10.0.0.0/8']);
		const res = await app.request('/ip', {
			headers: {'X-Forwarded-For': '203.0.113.1, 10.1.2.3'},
		});
		const body = await res.json();
		assert.strictEqual(body.ip, '203.0.113.1');
	});

	test('different XFF values resolve to distinct client IPs', async () => {
		const app = create_test_app(['127.0.0.1']);

		const res_a = await app.request('/ip', {headers: {'X-Forwarded-For': '10.0.0.1'}});
		const res_b = await app.request('/ip', {headers: {'X-Forwarded-For': '10.0.0.2'}});
		const body_a = await res_a.json();
		const body_b = await res_b.json();
		assert.strictEqual(body_a.ip, '10.0.0.1');
		assert.strictEqual(body_b.ip, '10.0.0.2');
	});

	test('XFF with empty segments in chain', async () => {
		const app = create_test_app(['127.0.0.1']);
		const res = await app.request('/ip', {
			headers: {'X-Forwarded-For': '203.0.113.1, , 127.0.0.1'},
		});
		const body = await res.json();
		assert.strictEqual(body.ip, '203.0.113.1');
	});

	test('all XFF entries trusted — falls back to leftmost, not connection IP', async () => {
		// When XFF contains only trusted entries, resolve_client_ip returns the
		// leftmost entry. The middleware uses that, not the ?? connection_ip fallback.
		const app = create_test_app(['127.0.0.1', '10.0.0.0/8'], '127.0.0.1');
		const res = await app.request('/ip', {
			headers: {'X-Forwarded-For': '10.1.1.1, 10.2.2.2'},
		});
		const body = await res.json();
		assert.strictEqual(body.ip, '10.1.1.1');
	});

	test('IPv6 connection IP with trusted proxy', async () => {
		const app = create_test_app(['::1'], '::1');
		const res = await app.request('/ip', {headers: {'X-Forwarded-For': '203.0.113.1'}});
		const body = await res.json();
		assert.strictEqual(body.ip, '203.0.113.1');
	});

	test('IPv6 connection IP without XFF', async () => {
		const app = create_test_app(['::1'], '::1');
		const res = await app.request('/ip');
		const body = await res.json();
		assert.strictEqual(body.ip, '::1');
	});

	test('XFF resolved IP differs from connection IP', async () => {
		// Verify the resolved XFF IP wins over the connection IP
		const app = create_test_app(['127.0.0.1'], '127.0.0.1');
		const res = await app.request('/ip', {
			headers: {'X-Forwarded-For': '198.51.100.42'},
		});
		const body = await res.json();
		assert.strictEqual(body.ip, '198.51.100.42');
	});

	test('IPv4-mapped IPv6 connection IP is trusted and normalized', async () => {
		// Deno dual-stack: connection reports ::ffff:127.0.0.1, config has 127.0.0.1
		const app = create_test_app(['127.0.0.1'], '::ffff:127.0.0.1');
		const res = await app.request('/ip', {headers: {'X-Forwarded-For': '203.0.113.1'}});
		const body = await res.json();
		assert.strictEqual(body.ip, '203.0.113.1');
	});

	test('connection IP without XFF is normalized', async () => {
		// Even without XFF, the connection IP is normalized in the context
		const app = create_test_app(['127.0.0.1'], '::ffff:127.0.0.1');
		const res = await app.request('/ip');
		const body = await res.json();
		// Normalized: ::ffff:127.0.0.1 → 127.0.0.1
		assert.strictEqual(body.ip, '127.0.0.1');
	});

	test('untrusted connection IP is still normalized', async () => {
		const app = create_test_app(['10.0.0.0/8'], '::ffff:192.168.1.1');
		const res = await app.request('/ip', {headers: {'X-Forwarded-For': 'spoofed'}});
		const body = await res.json();
		// Untrusted, so XFF ignored. Connection IP normalized.
		assert.strictEqual(body.ip, '192.168.1.1');
	});

	test('IPv6 CIDR trusted proxy resolves XFF client IP', async () => {
		const app = create_test_app(['fe80::/10'], 'fe80::1');
		const res = await app.request('/ip', {headers: {'X-Forwarded-For': '203.0.113.1'}});
		const body = await res.json();
		assert.strictEqual(body.ip, '203.0.113.1');
	});

	test('IPv6 client IP in XFF chain is resolved correctly', async () => {
		const app = create_test_app(['127.0.0.1']);
		const res = await app.request('/ip', {
			headers: {'X-Forwarded-For': '2001:db8::1, 127.0.0.1'},
		});
		const body = await res.json();
		assert.strictEqual(body.ip, '2001:db8::1');
	});

	test('empty X-Forwarded-For header value falls back to connection IP', async () => {
		// An empty string is falsy — middleware treats it as "no header present"
		const app = create_test_app(['127.0.0.1']);
		const res = await app.request('/ip', {headers: {'X-Forwarded-For': ''}});
		const body = await res.json();
		assert.strictEqual(body.ip, '127.0.0.1');
	});

	test('handles multiple XFF headers (Hono concatenation)', async () => {
		const app = new Hono();
		const middleware = create_proxy_middleware({
			trusted_proxies: ['127.0.0.1'],
			get_connection_ip: () => '127.0.0.1',
		});
		app.use('/*', middleware);
		app.get('/test', (c) => c.json({ip: get_client_ip(c)}));

		// Hono concatenates multiple same-name headers with ", "
		// Result: "10.0.0.1, 203.0.113.50" — rightmost-first walk resolves to 203.0.113.50
		// (which is untrusted, so it becomes the client IP)
		const res = await app.request('/test', {
			headers: new Headers([
				['X-Forwarded-For', '10.0.0.1'],
				['X-Forwarded-For', '203.0.113.50'],
			]),
		});
		const body = await res.json();
		// the rightmost untrusted IP should be the resolved client
		assert.strictEqual(body.ip, '203.0.113.50');
	});
});

// --- create_proxy_middleware_spec ---

describe('create_proxy_middleware_spec', () => {
	test('returns a valid MiddlewareSpec', () => {
		const spec = create_proxy_middleware_spec({
			trusted_proxies: ['127.0.0.1'],
			get_connection_ip: () => '127.0.0.1',
		});
		assert.strictEqual(spec.name, 'trusted_proxy');
		assert.strictEqual(spec.path, '*');
		assert.ok(typeof spec.handler === 'function');
	});
});

// --- get_client_ip without middleware ---

describe('get_client_ip without proxy middleware', () => {
	test('returns unknown when no middleware sets client_ip', async () => {
		const app = new Hono();
		app.get('/ip', (c) => c.json({ip: get_client_ip(c)}));

		const res = await app.request('/ip', {headers: {'X-Forwarded-For': 'spoofed'}});
		const body = await res.json();
		assert.strictEqual(body.ip, 'unknown');
	});
});

// --- CIDR boundary IPs (table-driven) ---

describe('CIDR boundary IPs', () => {
	const cidr_boundary_cases = [
		{
			name: 'network address (x.x.x.0) is in /24',
			ip: '10.0.0.0',
			cidr: '10.0.0.0/24',
			expected: true,
		},
		{
			name: 'broadcast address (x.x.x.255) is in /24',
			ip: '10.0.0.255',
			cidr: '10.0.0.0/24',
			expected: true,
		},
		{name: 'first address outside /24', ip: '10.0.1.0', cidr: '10.0.0.0/24', expected: false},
		{
			name: 'last address before /24 range',
			ip: '9.255.255.255',
			cidr: '10.0.0.0/24',
			expected: false,
		},
		{name: '0.0.0.0 is in 0.0.0.0/0', ip: '0.0.0.0', cidr: '0.0.0.0/0', expected: true},
		{
			name: '255.255.255.255 is in 0.0.0.0/0',
			ip: '255.255.255.255',
			cidr: '0.0.0.0/0',
			expected: true,
		},
		{name: '/32 matches only the exact IP', ip: '10.0.0.1', cidr: '10.0.0.1/32', expected: true},
		{name: '/32 rejects adjacent IP', ip: '10.0.0.2', cidr: '10.0.0.1/32', expected: false},
	];

	for (const tc of cidr_boundary_cases) {
		test(tc.name, () => {
			const proxies = [parse_proxy_entry(tc.cidr)];
			assert.strictEqual(is_trusted_ip(tc.ip, proxies), tc.expected);
		});
	}
});

// --- IPv4-mapped IPv6 in XFF ---

describe('IPv4-mapped IPv6 in XFF chain', () => {
	test('IPv4-mapped IPv6 XFF entry resolves against IPv4 CIDR', () => {
		const proxies = [parse_proxy_entry('10.0.0.0/8')];
		// ::ffff:10.0.0.1 normalizes to 10.0.0.1, which is in 10.0.0.0/8
		const result = resolve_client_ip('1.2.3.4, ::ffff:10.0.0.1', proxies);
		assert.strictEqual(result, '1.2.3.4');
	});

	test('IPv4-mapped IPv6 XFF entry matches exact IPv4 proxy', () => {
		const proxies = [parse_proxy_entry('10.0.0.1')];
		// ::ffff:10.0.0.1 normalizes to 10.0.0.1 — should match config
		const result = resolve_client_ip('1.2.3.4, ::ffff:10.0.0.1', proxies);
		assert.strictEqual(result, '1.2.3.4');
	});

	test('multi-hop chain with mixed IPv4 and IPv6 proxies', () => {
		// client → IPv6 CDN → IPv4-mapped proxy → IPv4 proxy
		const proxies = [
			parse_proxy_entry('2001:db8::100'), // IPv6 CDN
			parse_proxy_entry('10.0.0.0/8'), // IPv4 internal range
		];
		const result = resolve_client_ip(
			'203.0.113.50, 2001:db8::100, ::ffff:10.0.0.5, 10.0.0.1',
			proxies,
		);
		// right-to-left: 10.0.0.1 trusted (CIDR), ::ffff:10.0.0.5 → 10.0.0.5 trusted (CIDR),
		// 2001:db8::100 trusted (exact), 203.0.113.50 untrusted → client
		assert.strictEqual(result, '203.0.113.50');
	});

	test('multi-hop stops at first untrusted IPv6 entry', () => {
		const proxies = [parse_proxy_entry('10.0.0.1')];
		// client is IPv6, proxy is IPv4 — the IPv6 entry is untrusted
		const result = resolve_client_ip('2001:db8::1, 10.0.0.1', proxies);
		// 10.0.0.1 trusted, 2001:db8::1 untrusted → client
		assert.strictEqual(result, '2001:db8::1');
	});
});

// --- Undefined connection IP ---

describe('undefined connection IP', () => {
	test('with XFF present returns unknown (does not trust XFF)', async () => {
		const app = new Hono();
		app.use(
			'*',
			create_proxy_middleware({
				trusted_proxies: ['10.0.0.1'],
				get_connection_ip: () => undefined as any,
			}),
		);
		app.get('/test', (c) => c.json({ip: c.get('client_ip')}));

		const res = await app.request('/test', {
			headers: {'X-Forwarded-For': '1.2.3.4, 10.0.0.1'},
		});
		const body = await res.json();
		assert.strictEqual(body.ip, 'unknown');
	});

	test('without XFF also returns unknown', async () => {
		const app = new Hono();
		app.use(
			'*',
			create_proxy_middleware({
				trusted_proxies: ['10.0.0.1'],
				get_connection_ip: () => undefined as any,
			}),
		);
		app.get('/test', (c) => c.json({ip: c.get('client_ip')}));

		const res = await app.request('/test');
		const body = await res.json();
		assert.strictEqual(body.ip, 'unknown');
	});
});

// --- Proxy logging ---

describe('proxy middleware logging', () => {
	test('logs debug when XFF ignored due to untrusted connection', async () => {
		const log = new Logger('test', {level: 'debug'});
		const debug_spy = vi.spyOn(log, 'debug');
		const app = new Hono();
		app.use(
			'*',
			create_proxy_middleware({
				trusted_proxies: ['10.0.0.0/8'],
				get_connection_ip: () => '192.168.1.1',
				log,
			}),
		);
		app.get('/test', (c) => c.json({ip: get_client_ip(c)}));

		await app.request('/test', {headers: {'X-Forwarded-For': 'spoofed'}});
		assert.ok(debug_spy.mock.calls.length > 0, 'debug should have been called');
	});

	test('logs warn when all XFF entries are trusted', async () => {
		const log = new Logger('test', {level: 'warn'});
		const warn_spy = vi.spyOn(log, 'warn');
		const app = new Hono();
		app.use(
			'*',
			create_proxy_middleware({
				trusted_proxies: ['127.0.0.1', '10.0.0.0/8'],
				get_connection_ip: () => '127.0.0.1',
				log,
			}),
		);
		app.get('/test', (c) => c.json({ip: get_client_ip(c)}));

		await app.request('/test', {headers: {'X-Forwarded-For': '10.1.1.1, 10.2.2.2'}});
		assert.ok(warn_spy.mock.calls.length > 0, 'warn should have been called');
	});

	test('logs warn when connection IP is undefined', async () => {
		const log = new Logger('test', {level: 'warn'});
		const warn_spy = vi.spyOn(log, 'warn');
		const app = new Hono();
		app.use(
			'*',
			create_proxy_middleware({
				trusted_proxies: ['127.0.0.1'],
				get_connection_ip: () => undefined,
				log,
			}),
		);
		app.get('/test', (c) => c.json({ip: get_client_ip(c)}));

		await app.request('/test');
		assert.ok(warn_spy.mock.calls.length > 0, 'warn should have been called');
	});
});
