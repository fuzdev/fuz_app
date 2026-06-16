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
import {Logger} from '@fuzdev/fuz_util/log.ts';

import {
	normalize_ip,
	parse_proxy_entry,
	is_trusted_ip,
	resolve_client_ip,
	validate_ip_strict,
	create_proxy_middleware,
	create_proxy_middleware_spec,
	type ParsedProxy,
} from '$lib/http/proxy.ts';
import {get_client_ip} from '$lib/http/client_ip.ts';

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

	test('canonicalizes equivalent IPv6 forms to one key (delegates to canonicalize_ip)', () => {
		// Pins the delegation contract: `normalize_ip` is wired through
		// `canonicalize_ip` from `ip_canonical.ts`, which collapses every
		// RFC 5952-equivalent form into a single string. Without this
		// canonicalization, an attacker who controls XFF and transits a
		// trusted proxy could rotate `::1` / `::01` / `0:0:0:0:0:0:0:1` to
		// get a fresh per-IP rate-limit bucket per form. Reverting the
		// `normalize_ip = (ip) => canonicalize_ip(ip)` delegation back to
		// the old `lowercase + ::ffff: strip` shape would break THIS test
		// but pass every test above (which only exercise the IPv4-mapped
		// + lowercase contracts the old shape already satisfied).
		assert.strictEqual(normalize_ip('::0001'), '::1');
		assert.strictEqual(normalize_ip('0:0:0:0:0:0:0:1'), '::1');
		assert.strictEqual(normalize_ip('0000:0000:0000:0000:0000:0000:0000:0001'), '::1');
		assert.strictEqual(normalize_ip('2001:0db8::0001'), '2001:db8::1');
		assert.strictEqual(normalize_ip('2001:0:0:0:0:0:0:1'), '2001::1');
	});
});

// --- validate_ip_strict ---

describe('validate_ip_strict', () => {
	test('accepts well-formed IPv4', () => {
		assert.strictEqual(validate_ip_strict('127.0.0.1'), 'IPv4');
		assert.strictEqual(validate_ip_strict('203.0.113.1'), 'IPv4');
	});

	test('accepts well-formed IPv6', () => {
		assert.strictEqual(validate_ip_strict('::1'), 'IPv6');
		assert.strictEqual(validate_ip_strict('2001:db8::1'), 'IPv6');
		assert.strictEqual(validate_ip_strict('1:2:3:4:5:6:7:8'), 'IPv6');
	});

	test('rejects non-IP garbage', () => {
		assert.strictEqual(validate_ip_strict('not-an-ip'), undefined);
		assert.strictEqual(validate_ip_strict(''), undefined);
		assert.strictEqual(validate_ip_strict('garbage'), undefined);
	});

	test('rejects colon-injected garbage that distinctRemoteAddr misclassifies', () => {
		// distinctRemoteAddr returns 'IPv6' for these because of the colons.
		// validate_ip_strict round-trips through convertIPv6ToBinary, which
		// throws on these — caught and returned as undefined.
		assert.strictEqual(validate_ip_strict('attacker:controlled'), undefined);
		assert.strictEqual(validate_ip_strict('host:port'), undefined);
		assert.strictEqual(validate_ip_strict('a:b:c'), undefined);
	});

	test('rejects IPv4 with port suffix', () => {
		// Hono mis-classifies this as IPv6 (any-string-with-colons) but the
		// strict round-trip rejects it.
		assert.strictEqual(validate_ip_strict('203.0.113.1:8080'), undefined);
	});

	test('rejects bracketed IPv6 with port (URL host:port form, not bare IP)', () => {
		// Hono's IPv6 parser silently accepts `[::1]:NNNN` and parses it as
		// a malformed-but-binary-valid IPv6 — varying the port produces
		// distinct binary values, so the round-trip alone isn't enough.
		// The IP_LITERAL_CHARS pre-filter rejects the brackets up front.
		assert.strictEqual(validate_ip_strict('[::1]:8080'), undefined);
		assert.strictEqual(validate_ip_strict('[2001:db8::1]:8080'), undefined);
		assert.strictEqual(validate_ip_strict('[::1]:1'), undefined);
		assert.strictEqual(validate_ip_strict('[::1]:65535'), undefined);
	});

	test('rejects IP-literal with embedded whitespace or control bytes', () => {
		// Hono's IPv6 parser silently ignores trailing whitespace / newlines,
		// so `::1`, `::1 `, `::1\n`, `::1\t` would all parse the same and
		// could be rotated as distinct rate-limit keys without the char check.
		assert.strictEqual(validate_ip_strict('::1\n'), undefined);
		assert.strictEqual(validate_ip_strict('::1 '), undefined);
		assert.strictEqual(validate_ip_strict(' ::1'), undefined);
		assert.strictEqual(validate_ip_strict('127.0.0.1\t'), undefined);
	});

	test('accepts valid IPv4 and IPv6 forms (no false negatives)', () => {
		// Sanity check that the char-set + round-trip combination doesn't
		// reject any well-formed bare IP literal.
		assert.strictEqual(validate_ip_strict('0.0.0.0'), 'IPv4');
		assert.strictEqual(validate_ip_strict('255.255.255.255'), 'IPv4');
		assert.strictEqual(validate_ip_strict('::'), 'IPv6');
		assert.strictEqual(validate_ip_strict('FE80::1'), 'IPv6');
		assert.strictEqual(validate_ip_strict('fe80::1'), 'IPv6');
		assert.strictEqual(validate_ip_strict('::ffff:127.0.0.1'), 'IPv6');
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

	test('throws on leading-zero CIDR prefix', () => {
		// `parseInt('08', 10) === 8` but `String(8) === '8'` !== `'08'`, so the
		// integer round-trip check rejects. Pins the contract that exactly one
		// canonical decimal form is accepted — operators who copy-paste an
		// IPv6-shaped prefix written as `/008` (or any leading-zero form) get
		// a loud failure at startup rather than a silent reinterpretation.
		assert.throws(() => parse_proxy_entry('10.0.0.0/08'), /Invalid CIDR prefix \(not an integer\)/);
		assert.throws(() => parse_proxy_entry('::/008'), /Invalid CIDR prefix \(not an integer\)/);
	});

	test('throws on sign-prefixed CIDR prefix', () => {
		// Companion to the leading-zero test above — the same round-trip
		// check rejects `+8` (parseInt strips the sign, String(8) !== '+8').
		// Pins the canonical-form contract beyond the leading-zero shape so a
		// refactor that swapped the round-trip for a looser parse (e.g.
		// `prefix < 0 ? throw : pass`) would surface here.
		assert.throws(() => parse_proxy_entry('10.0.0.0/+8'), /Invalid CIDR prefix \(not an integer\)/);
		assert.throws(() => parse_proxy_entry('::/+8'), /Invalid CIDR prefix \(not an integer\)/);
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

	test('returns false for colon-injected garbage that distinctRemoteAddr misclassifies as IPv6', () => {
		// Hono's distinctRemoteAddr returns 'IPv6' for any string with a
		// colon. The strict validator inside is_trusted_ip catches the
		// convertIPv6ToBinary throw and returns false — without it, IPv6
		// CIDR proxies would surface a 500 from a thrown BigInt error.
		const proxies = [parse_proxy_entry('::1/128')];
		assert.ok(!is_trusted_ip('attacker:controlled', proxies));
		assert.ok(!is_trusted_ip('203.0.113.1:8080', proxies));
	});

	test('does not throw when matching colon-malformed input against IPv6 CIDR proxy', () => {
		// Pre-fix latent bug: convertIPv6ToBinary('203.0.113.1:8080') threw
		// inside is_trusted_ip when an IPv6 CIDR was configured. The strict
		// validator now rejects the entry up front so the throw never reaches
		// the caller.
		const proxies = [parse_proxy_entry('2001:db8::/32')];
		assert.doesNotThrow(() => is_trusted_ip('203.0.113.1:8080', proxies));
		assert.doesNotThrow(() => is_trusted_ip('a:b:c', proxies));
		assert.doesNotThrow(() => is_trusted_ip('host:port', proxies));
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

	test('matches equivalent IPv6 forms after RFC 5952 canonicalization', () => {
		// Security property: `is_trusted_ip` normalizes both the input IP
		// and the proxy config through `normalize_ip` (which now delegates
		// to `canonicalize_ip`) BEFORE comparison. Without canonicalization,
		// an operator who configured `trusted_proxies=::1` would silently
		// fail to recognize a request whose connection IP arrived as
		// `0:0:0:0:0:0:0:1` (an artifact of some socket libraries / OS
		// stacks) — and the same request would skip the XFF resolution
		// branch entirely, letting an attacker who controls XFF spoof the
		// client IP. This test pins the cross-form match in both
		// directions: equivalent forms in the input and equivalent forms
		// in the proxy config both collapse to one comparison.
		const trusted_short = [parse_proxy_entry('::1')];
		assert.ok(is_trusted_ip('::1', trusted_short));
		assert.ok(is_trusted_ip('::0001', trusted_short));
		assert.ok(is_trusted_ip('0:0:0:0:0:0:0:1', trusted_short));
		assert.ok(is_trusted_ip('0000:0000:0000:0000:0000:0000:0000:0001', trusted_short));

		const trusted_full = [parse_proxy_entry('0:0:0:0:0:0:0:1')];
		assert.ok(is_trusted_ip('::1', trusted_full));
		assert.ok(is_trusted_ip('::0001', trusted_full));

		// Non-equivalent forms must still NOT match — canonicalization
		// shouldn't accidentally collapse distinct addresses.
		assert.ok(!is_trusted_ip('::2', trusted_short));
		assert.ok(!is_trusted_ip('0:0:0:0:0:0:0:2', trusted_short));
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

	test('port-suffixed XFF entry is skipped during right-to-left walk', () => {
		// Non-standard proxies may include ports (e.g. 203.0.113.1:8080).
		// Hono's `distinctRemoteAddr` lazily classifies anything-with-colons
		// as IPv6, but `validate_ip_strict` round-trips through
		// `convertIPv*ToBinary` which throws on this entry — so the strict
		// check rejects it. Walk continues past the port-suffixed entry and
		// returns the next untrusted, strictly-valid entry.
		// Walk: 127.0.0.1 (trusted, skip) → 203.0.113.1:8080 (malformed, skip)
		// → 198.51.100.7 (strictly-valid, untrusted) → return.
		const result = resolve_client_ip('198.51.100.7, 203.0.113.1:8080, 127.0.0.1', localhost);
		assert.strictEqual(result, '198.51.100.7');
	});

	test('colon-injection bypass is blocked — attacker:controlled is rejected', () => {
		// Hono's `distinctRemoteAddr` misclassifies `attacker:controlled` as
		// IPv6 (any-string-with-colons). A naive `!distinctRemoteAddr` skip
		// would let this through. The strict round-trip through
		// `convertIPv6ToBinary` throws (NaN→BigInt), so `validate_ip_strict`
		// rejects it and the walk skips. Falls through to the trusted-only
		// branch and returns the trusted proxy as leftmost-valid.
		const result = resolve_client_ip('attacker:controlled, 127.0.0.1', localhost);
		assert.strictEqual(result, '127.0.0.1');
	});

	test('bracketed IPv6 with port is skipped (not a valid IP form here)', () => {
		// `[::1]:8080` and `[2001:db8::1]:8080` are URL-style host:port forms,
		// not valid bare IPs. validate_ip_strict rejects them.
		assert.strictEqual(resolve_client_ip('[::1]:8080, 127.0.0.1', localhost), '127.0.0.1');
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

	test('malformed non-IP entry in chain is skipped', () => {
		// Malformed entry can't be returned as the client IP — that would let
		// an attacker controlling XFF poison the rate-limit key. With only a
		// trusted-proxy entry left after the skip, the walk falls through and
		// returns undefined; the middleware then falls back to the connection IP.
		assert.strictEqual(resolve_client_ip('not-an-ip, 127.0.0.1', localhost), '127.0.0.1');
	});

	test('rightmost malformed entry is skipped, walk continues to untrusted-valid', () => {
		// Companion to the malformed-then-trusted case above: when the
		// rightmost entry fails `validate_ip_strict` but a leftmost entry is
		// strictly-valid + untrusted, the walker skips the garbage and returns
		// the valid entry. Without an explicit case, an attacker-controlled
		// rightmost garbage entry that suppressed the walk (returning undefined
		// or the garbage value) would slip past — but only the multi-entry
		// trusted-malformed-fallback path tests the skip on the trusted side.
		assert.strictEqual(resolve_client_ip('203.0.113.1, garbage', localhost), '203.0.113.1');
		// And with a port-suffix malformed rightmost (the legitimate non-standard
		// proxy case the JSDoc tradeoff documents).
		assert.strictEqual(
			resolve_client_ip('203.0.113.1, 198.51.100.7:8080', localhost),
			'203.0.113.1',
		);
	});

	test('multiple malformed entries are all skipped', () => {
		// Both garbage entries skipped, only 127.0.0.1 remains (trusted) — the
		// "every entry trusted (or malformed)" branch returns the leftmost
		// well-formed entry, which is the trusted proxy itself. Middleware
		// logs a misconfiguration warn on this path.
		assert.strictEqual(resolve_client_ip('garbage, also-bad, 127.0.0.1', localhost), '127.0.0.1');
	});

	test('all-malformed XFF returns undefined (middleware falls back to connection IP)', () => {
		assert.strictEqual(resolve_client_ip('garbage, also-bad', localhost), undefined);
	});

	describe('rate-limit-key-poisoning surface (RFC 5952 canonicalization)', () => {
		// Central security property the canonicalization module addresses:
		// an attacker who controls XFF and transits a trusted proxy must
		// not be able to rotate equivalent IPv6 forms to get fresh per-IP
		// rate-limit buckets. The walker's `normalize_ip` pass collapses
		// every equivalent form into a single key, and the returned value
		// (which feeds the rate limiter, audit log, and `client_ip`
		// context var) is always the canonical RFC 5952 string.

		test('equivalent IPv6 forms produce the same returned key', () => {
			// Three forms of `::1` in XFF (single entry, empty trusted list
			// so each is returned directly) must all canonicalize to the
			// same string. Without canonicalization, the rate limiter sees
			// three buckets and an attacker rotates 3x the per-IP budget.
			assert.strictEqual(resolve_client_ip('::1', []), '::1');
			assert.strictEqual(resolve_client_ip('::0001', []), '::1');
			assert.strictEqual(resolve_client_ip('0:0:0:0:0:0:0:1', []), '::1');
			assert.strictEqual(resolve_client_ip('0000:0000:0000:0000:0000:0000:0000:0001', []), '::1');
		});

		test('trusted-match canonicalization during right-to-left walk', () => {
			// XFF: client_ip, trusted_proxy_written_as_full_form
			// Walker walks right-to-left. The full-form trailing entry must
			// canonicalize to `::1` so it matches the trusted entry
			// `parse_proxy_entry('::1')` and gets skipped, exposing the
			// untrusted `::2` as the actual client. Without
			// canonicalization in `is_trusted_ip`, the trailing entry
			// wouldn't match and the walker would return it instead of
			// `::2` — letting an attacker who controls XFF spoof their
			// client IP as the trusted proxy address.
			const trusted = [parse_proxy_entry('::1')];
			assert.strictEqual(resolve_client_ip('::2, 0:0:0:0:0:0:0:1', trusted), '::2');
			assert.strictEqual(resolve_client_ip('::2, ::01', trusted), '::2');
			assert.strictEqual(
				resolve_client_ip('::2, 0000:0000:0000:0000:0000:0000:0000:0001', trusted),
				'::2',
			);
		});

		test('trusted entries written as full-form match shortened input', () => {
			// Mirror direction — the trusted config is full-form, the XFF
			// entry is canonical. parse_proxy_entry already normalizes the
			// config side, but the cross-form match invariant must hold.
			const trusted = [parse_proxy_entry('0:0:0:0:0:0:0:1')];
			assert.strictEqual(resolve_client_ip('::2, ::1', trusted), '::2');
			assert.strictEqual(resolve_client_ip('::2, ::01', trusted), '::2');
		});

		test('non-equivalent forms do not collide', () => {
			// Canonicalization shouldn't accidentally collapse distinct
			// addresses. `::1` and `::2` differ in their final group.
			assert.notStrictEqual(resolve_client_ip('::1', []), resolve_client_ip('::2', []));
			assert.notStrictEqual(resolve_client_ip('::1', []), resolve_client_ip('0:0:0:0:0:0:0:2', []));
		});
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

	test('malformed XFF entry is skipped — attacker cannot poison rate-limit key', async () => {
		// `resolve_client_ip` skips entries that fail `distinctRemoteAddr`
		// during the right-to-left walk so an attacker who controls XFF
		// cannot rotate non-IP strings as fresh per-IP rate-limit buckets.
		// The walk falls through to the leftmost well-formed entry (here
		// the trusted proxy itself, which triggers the "All XFF entries are
		// trusted" misconfiguration warn), and the middleware then exposes
		// `client_ip` as that resolved value.
		//
		// Tradeoff: legitimate non-standard proxies that include ports in
		// XFF entries (e.g. `203.0.113.1:8080`) also fail `distinctRemoteAddr`
		// and lose per-client distinction in rate limiting. nginx + cloud
		// LBs don't include ports — the regression is bounded by operator
		// configuration. See `resolve_client_ip` JSDoc.
		const app = create_test_app(['127.0.0.1']);
		const res = await app.request('/ip', {
			headers: {'X-Forwarded-For': 'attacker-controlled, 127.0.0.1'},
		});
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
