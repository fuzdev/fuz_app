/**
 * Tests for `http/ip_canonical.ts` — IP address canonicalization.
 *
 * Closes the rate-limit-key-poisoning + audit-log forensics surface where
 * equivalent IPv6 string forms produce distinct keys (`::1` / `::01` /
 * `::0001` / `0:0:0:0:0:0:0:1`). Mirrors the Rust port's test set in
 * `zzz_server::proxy` (landed 2026-05-16) so cross-backend parity holds.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import {
	canonicalize_ip,
	ipv6_bigint_to_canonical,
	IP_LITERAL_CHARS
} from '$lib/http/ip_canonical.ts';

// --- ipv6_bigint_to_canonical — pure helper ---

describe('ipv6_bigint_to_canonical', () => {
	test('emits :: for all-zero address', () => {
		assert.strictEqual(ipv6_bigint_to_canonical(0n), '::');
	});

	test('emits ::1 for the loopback', () => {
		assert.strictEqual(ipv6_bigint_to_canonical(1n), '::1');
	});

	test('lowercases hex per RFC 5952 §4.3', () => {
		// 2001:DB8::ABCD as bits: 0x20010DB8_0000_0000_0000_0000_0000_ABCD
		const bits = (0x2001n << 112n) | (0x0db8n << 96n) | (0xabcdn << 0n);
		assert.strictEqual(ipv6_bigint_to_canonical(bits), '2001:db8::abcd');
	});

	test('drops per-group leading zeros per RFC 5952 §4.1', () => {
		// 2001:0db8::0001 has zero-padding on the second and last group;
		// canonical form drops them.
		const bits = (0x2001n << 112n) | (0x0db8n << 96n) | 0x0001n;
		assert.strictEqual(ipv6_bigint_to_canonical(bits), '2001:db8::1');
	});

	test('compresses longest zero run with :: per RFC 5952 §4.2.1', () => {
		// 2001:0:0:0:0:0:0:1 — 6-group zero run dominates.
		const bits = (0x2001n << 112n) | 1n;
		assert.strictEqual(ipv6_bigint_to_canonical(bits), '2001::1');
	});

	test('longest run wins when runs are unequal length per RFC 5952 §4.2.1', () => {
		// 2001:0:0:1:0:0:0:1 has two zero runs; group 4-6 is length 3, group 1-2
		// is length 2. Longest wins, so :: lands at the 4-6 run. This pins the
		// "longer beats earlier" rule; the equal-length tiebreaker test follows.
		const bits = (0x2001n << 112n) | (0n << 96n) | (0n << 80n) | (1n << 64n) | 1n;
		assert.strictEqual(ipv6_bigint_to_canonical(bits), '2001:0:0:1::1');
	});

	test('on equal-length runs (both length 3), picks the first per RFC 5952 §4.2.3', () => {
		// Layout: groups[0]=1, [1..3]=0, [4]=1, [5..7]=0. Two zero runs each
		// length 3; per RFC 5952 §4.2.3, the first one wins.
		// `1 << 112n` puts a 1 in group[0]; `1 << 48n` puts a 1 in group[4]
		// (each group is 16 bits, big-endian).
		const bits = (1n << 112n) | (1n << 48n);
		assert.strictEqual(ipv6_bigint_to_canonical(bits), '1::1:0:0:0');
	});

	test('does not compress a single zero group per RFC 5952 §4.2.2', () => {
		// 2001:db8:0:1:1:1:1:1 — single zero group at position 2 must stay
		// as `0`, not collapsed with `::`.
		const bits =
			(0x2001n << 112n) |
			(0x0db8n << 96n) |
			(0n << 80n) |
			(1n << 64n) |
			(1n << 48n) |
			(1n << 32n) |
			(1n << 16n) |
			1n;
		assert.strictEqual(ipv6_bigint_to_canonical(bits), '2001:db8:0:1:1:1:1:1');
	});

	test('emits IPv4-mapped in dotted form per RFC 5952 §5', () => {
		// IPv4-mapped IPv6: groups[0..5] = 0, groups[5] = 0xffff, then IPv4.
		// 127.0.0.1 → 0x7f000001 → split into 0x7f00 (group 6) and 0x0001 (group 7).
		const bits = (0xffffn << 32n) | 0x7f000001n;
		assert.strictEqual(ipv6_bigint_to_canonical(bits), '::ffff:127.0.0.1');
	});

	test('IPv4-mapped form uses zeros for zero IPv4 octets', () => {
		// 0.0.0.1 → ::ffff:0.0.0.1
		const bits = (0xffffn << 32n) | 1n;
		assert.strictEqual(ipv6_bigint_to_canonical(bits), '::ffff:0.0.0.1');
	});

	test('IPv4-mapped form covers 255.255.255.255', () => {
		const bits = (0xffffn << 32n) | 0xffffffffn;
		assert.strictEqual(ipv6_bigint_to_canonical(bits), '::ffff:255.255.255.255');
	});

	test('::ffff:0:1 (group[5]=0, not ffff) is NOT IPv4-mapped', () => {
		// Bits: groups[0..5]=0, groups[6]=0xffff, groups[7]=1.
		// Expanded form: 0:0:0:0:0:0:ffff:1 — six-group zero run before
		// `ffff:1`. NOT the IPv4-mapped layout (which puts ffff at groups[5]).
		const bits = (0xffffn << 16n) | 1n;
		assert.strictEqual(ipv6_bigint_to_canonical(bits), '::ffff:1');
	});

	test('compresses trailing zeros', () => {
		// 2001:db8::
		const bits = (0x2001n << 112n) | (0x0db8n << 96n);
		assert.strictEqual(ipv6_bigint_to_canonical(bits), '2001:db8::');
	});

	test('compresses leading zeros', () => {
		// ::1234
		const bits = 0x1234n;
		assert.strictEqual(ipv6_bigint_to_canonical(bits), '::1234');
	});

	test('preserves explicit non-zero groups around a single zero', () => {
		// 1:2:0:3:4:5:6:7 — only one zero group, no `::` compression.
		const bits =
			(1n << 112n) |
			(2n << 96n) |
			(0n << 80n) |
			(3n << 64n) |
			(4n << 48n) |
			(5n << 32n) |
			(6n << 16n) |
			7n;
		assert.strictEqual(ipv6_bigint_to_canonical(bits), '1:2:0:3:4:5:6:7');
	});

	test('handles all-ones address (no zero runs, no `::` compression)', () => {
		// `ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff` — every group non-zero
		// exercises the `best_len < 2` branch where compression is skipped
		// outright. The pre-existing single-zero test only proves single
		// zeros aren't compressed; this proves the no-zero branch.
		const bits = (1n << 128n) - 1n;
		assert.strictEqual(ipv6_bigint_to_canonical(bits), 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
	});

	test('throws RangeError on out-of-range bigints', () => {
		// Contract: silent truncation would mask caller bugs because the
		// extraction loop only consumes the low 128 bits — a caller passing
		// `(1n << 128n) | x` would get back `canonicalize(x)` with no signal.
		assert.throws(() => ipv6_bigint_to_canonical(1n << 128n), RangeError);
		assert.throws(() => ipv6_bigint_to_canonical(-1n), RangeError);
	});
});

// --- IP_LITERAL_CHARS — exported regex ---

describe('IP_LITERAL_CHARS', () => {
	test('accepts hex + dots + colons', () => {
		assert.ok(IP_LITERAL_CHARS.test('127.0.0.1'));
		assert.ok(IP_LITERAL_CHARS.test('::1'));
		assert.ok(IP_LITERAL_CHARS.test('2001:db8::abcd'));
		assert.ok(IP_LITERAL_CHARS.test('::ffff:127.0.0.1'));
		assert.ok(IP_LITERAL_CHARS.test('FE80::1'));
	});

	test('rejects whitespace and control bytes', () => {
		assert.ok(!IP_LITERAL_CHARS.test('::1\n'));
		assert.ok(!IP_LITERAL_CHARS.test('::1 '));
		assert.ok(!IP_LITERAL_CHARS.test(' ::1'));
		assert.ok(!IP_LITERAL_CHARS.test('127.0.0.1\t'));
	});

	test('rejects brackets', () => {
		assert.ok(!IP_LITERAL_CHARS.test('[::1]'));
		assert.ok(!IP_LITERAL_CHARS.test('[::1]:8080'));
	});

	test('rejects letters g-z (non-hex)', () => {
		assert.ok(!IP_LITERAL_CHARS.test('host:port'));
		assert.ok(!IP_LITERAL_CHARS.test('attacker:controlled'));
		assert.ok(!IP_LITERAL_CHARS.test('not-an-ip'));
	});

	test('rejects empty', () => {
		assert.ok(!IP_LITERAL_CHARS.test(''));
	});
});

// --- canonicalize_ip — top-level ---

describe('canonicalize_ip', () => {
	describe('IPv6 canonicalization (RFC 5952)', () => {
		test('collapses zero-padding to canonical form', () => {
			// `normalize_canonicalizes_ipv6_zero_padding` from the Rust port.
			assert.strictEqual(canonicalize_ip('::0001'), '::1');
			assert.strictEqual(canonicalize_ip('2001:0db8::0001'), '2001:db8::1');
		});

		test('collapses full-form to compressed form', () => {
			// `normalize_canonicalizes_full_form_ipv6` from the Rust port.
			assert.strictEqual(canonicalize_ip('0:0:0:0:0:0:0:1'), '::1');
			assert.strictEqual(canonicalize_ip('0:0:0:0:0:0:0:0'), '::');
		});

		test('compresses longest zero run', () => {
			// `normalize_canonicalizes_double_colon_run` from the Rust port.
			assert.strictEqual(canonicalize_ip('2001:0:0:0:0:0:0:1'), '2001::1');
		});

		test('lowercases uppercase hex', () => {
			assert.strictEqual(canonicalize_ip('FE80::1'), 'fe80::1');
			assert.strictEqual(canonicalize_ip('2001:DB8::ABCD'), '2001:db8::abcd');
		});

		test('passes through already-canonical input unchanged', () => {
			assert.strictEqual(canonicalize_ip('::1'), '::1');
			assert.strictEqual(canonicalize_ip('fe80::1'), 'fe80::1');
			assert.strictEqual(canonicalize_ip('2001:db8::abcd'), '2001:db8::abcd');
		});
	});

	describe('IPv4-mapped IPv6 collapse', () => {
		test('strips ::ffff: from dotted IPv4-mapped form', () => {
			assert.strictEqual(canonicalize_ip('::ffff:127.0.0.1'), '127.0.0.1');
			assert.strictEqual(canonicalize_ip('::ffff:10.0.0.1'), '10.0.0.1');
			assert.strictEqual(canonicalize_ip('::ffff:192.168.1.1'), '192.168.1.1');
			// IPv4 boundary — exercises the strip at the high end of the
			// IPv4 space. The pure-helper block above covers this on
			// `ipv6_bigint_to_canonical` directly; this test pins the same
			// invariant on the top-level `canonicalize_ip` path so a
			// refactor that gated the strip on a value-range check (e.g.
			// "only addresses in 127.0.0.0/8 strip") would surface here.
			assert.strictEqual(canonicalize_ip('::ffff:255.255.255.255'), '255.255.255.255');
		});

		test('collapses full-hex IPv4-mapped form to plain IPv4', () => {
			// `normalize_ipv4_mapped_collapse_is_order_safe` — the strip must
			// run AFTER canonicalization because the dotted form is the only
			// form the strip can match.
			// 0:0:0:0:0:ffff:7f00:1 = ::ffff:127.0.0.1 = 127.0.0.1
			assert.strictEqual(canonicalize_ip('0:0:0:0:0:ffff:7f00:1'), '127.0.0.1');
			// 0:0:0:0:0:ffff:0a00:0001 = ::ffff:10.0.0.1 = 10.0.0.1
			assert.strictEqual(canonicalize_ip('0:0:0:0:0:ffff:a00:1'), '10.0.0.1');
		});

		test('IPv4-mapped 0.0.0.0 boundary collapses through both hex and dotted forms', () => {
			// Low boundary of the IPv4 space — both the fully-expanded
			// hex form and the dotted form must canonicalize to the same
			// bare-IPv4 key, otherwise an attacker rotating between
			// `::ffff:0.0.0.0` and `0:0:0:0:0:ffff:0:0` would split the
			// rate-limit bucket by 2.
			assert.strictEqual(canonicalize_ip('0:0:0:0:0:ffff:0:0'), '0.0.0.0');
			assert.strictEqual(canonicalize_ip('::ffff:0.0.0.0'), '0.0.0.0');
			assert.strictEqual(canonicalize_ip('::ffff:0.0.0.1'), '0.0.0.1');
		});

		test('handles uppercase ::FFFF: prefix', () => {
			assert.strictEqual(canonicalize_ip('::FFFF:192.168.1.1'), '192.168.1.1');
		});

		test('collapses uppercase full-hex IPv4-mapped form to plain IPv4', () => {
			// Same as the full-hex collapse test above, but with the
			// uppercase hex form. Confirms the lowercase prelude flows into
			// the IPv6 parser uniformly — without it, `distinctRemoteAddr`
			// might branch differently on case and the strip would miss.
			// 0:0:0:0:0:FFFF:7F00:1 = ::ffff:127.0.0.1 = 127.0.0.1
			assert.strictEqual(canonicalize_ip('0:0:0:0:0:FFFF:7F00:1'), '127.0.0.1');
			assert.strictEqual(canonicalize_ip('0:0:0:0:0:FFFF:0A00:0001'), '10.0.0.1');
		});

		test('does NOT strip ::ffff: from pure-IPv6 with no dotted IPv4 suffix', () => {
			// `::ffff:1` expands to `0:0:0:0:0:0:ffff:1` — six-group zero run
			// before `ffff:1`. group[5] is 0 (not 0xffff), so it's NOT the
			// IPv4-mapped layout and the strip does not apply.
			assert.strictEqual(canonicalize_ip('::ffff:1'), '::ffff:1');
		});
	});

	describe('equivalent forms collapse to one key', () => {
		test('all loopback variants → ::1', () => {
			// `normalize_collapses_equivalent_ipv6_to_same_key` from the Rust port.
			const forms = [
				'::1',
				'::01',
				'::0001',
				'0:0:0:0:0:0:0:1',
				'0000:0000:0000:0000:0000:0000:0000:0001'
			];
			for (const form of forms) {
				assert.strictEqual(
					canonicalize_ip(form),
					'::1',
					`form '${form}' did not canonicalize to ::1`
				);
			}
		});

		test('IPv4-mapped variants → bare IPv4', () => {
			const forms = ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:0001'];
			for (const form of forms) {
				assert.strictEqual(
					canonicalize_ip(form),
					'127.0.0.1',
					`form '${form}' did not canonicalize to 127.0.0.1`
				);
			}
		});

		test('canonical forms produce the same key as their alternates', () => {
			// `normalize_equivalent_to_same_key` from the Rust port.
			assert.strictEqual(canonicalize_ip('::1'), canonicalize_ip('0:0:0:0:0:0:0:1'));
			assert.strictEqual(
				canonicalize_ip('2001:db8::1'),
				canonicalize_ip('2001:0db8:0000:0000:0000:0000:0000:0001')
			);
		});
	});

	describe('idempotency', () => {
		test('canonicalize_ip is idempotent', () => {
			const inputs = [
				'::1',
				'::0001',
				'0:0:0:0:0:0:0:1',
				'FE80::1',
				'::ffff:127.0.0.1',
				'127.0.0.1',
				'not-an-ip',
				'unknown',
				'',
				'::1\n',
				'attacker:controlled',
				'203.0.113.1:8080'
			];
			for (const raw of inputs) {
				const once = canonicalize_ip(raw);
				const twice = canonicalize_ip(once);
				assert.strictEqual(once, twice, `canonicalize_ip not idempotent for '${raw}'`);
			}
		});
	});

	describe('IPv4 passthrough', () => {
		test('passes IPv4 unchanged', () => {
			assert.strictEqual(canonicalize_ip('127.0.0.1'), '127.0.0.1');
			assert.strictEqual(canonicalize_ip('10.0.0.1'), '10.0.0.1');
			assert.strictEqual(canonicalize_ip('255.255.255.255'), '255.255.255.255');
			assert.strictEqual(canonicalize_ip('0.0.0.0'), '0.0.0.0');
		});
	});

	describe('preserves strictly invalid forms (validate_ip_strict gets to reject)', () => {
		test('non-IP strings pass through (only lowercased)', () => {
			// `normalize_preserves_strictly_invalid` from the Rust port — the
			// guarantee is that canonicalize never *erases* the malformed-form
			// signal that the downstream strict validator relies on.
			assert.strictEqual(canonicalize_ip('unknown'), 'unknown');
			assert.strictEqual(canonicalize_ip(''), '');
			assert.strictEqual(canonicalize_ip('not-an-ip'), 'not-an-ip');
		});

		test('colon-injected garbage passes through (char-set rejects)', () => {
			// Hono's distinctRemoteAddr would misclassify these as IPv6;
			// the char-set filter `IP_LITERAL_CHARS` catches the letters
			// g-z first so the parser never sees the malformed input.
			assert.strictEqual(canonicalize_ip('attacker:controlled'), 'attacker:controlled');
			assert.strictEqual(canonicalize_ip('host:port'), 'host:port');
		});

		test('port-suffixed forms pass through (char-set rejects)', () => {
			// 203.0.113.1:8080 contains only [0-9a-fA-F.:], so the char-set
			// accepts it. `distinctRemoteAddr` then classifies it as IPv6
			// (any-string-with-colons), and Hono's `convertIPv6ToBinary`
			// throws on it — caught and the input passes through.
			assert.strictEqual(canonicalize_ip('203.0.113.1:8080'), '203.0.113.1:8080');
		});

		test('bracketed forms pass through (char-set rejects)', () => {
			// Brackets are not in IP_LITERAL_CHARS, so the input passes through
			// unchanged. validate_ip_strict in proxy.ts then rejects them
			// because the lib silently accepts the bracketed form as IPv6.
			assert.strictEqual(canonicalize_ip('[::1]:8080'), '[::1]:8080');
			assert.strictEqual(canonicalize_ip('[2001:db8::1]:8080'), '[2001:db8::1]:8080');
		});

		test('whitespace-bearing forms pass through (char-set rejects)', () => {
			// `\n`, ` `, `\t` are not in IP_LITERAL_CHARS — char-set filter
			// rejects up front so canonicalize doesn't normalize them away.
			assert.strictEqual(canonicalize_ip('::1\n'), '::1\n');
			assert.strictEqual(canonicalize_ip('::1 '), '::1 ');
			assert.strictEqual(canonicalize_ip(' ::1'), ' ::1');
			assert.strictEqual(canonicalize_ip('127.0.0.1\t'), '127.0.0.1\t');
		});

		test('IPv6 zone identifiers pass through (char-set rejects %)', () => {
			// `fe80::1%eth0` is the standard Linux interface-bound form for
			// link-local addresses (RFC 4007). `%` is not in
			// `IP_LITERAL_CHARS`, so the char-set filter rejects up front
			// and the form passes through unchanged (only lowercased) —
			// `validate_ip_strict` then rejects it downstream. The property
			// pinned here is that canonicalize does NOT strip the zone
			// identifier and collapse `fe80::1%eth0` / `fe80::1%eth1` to
			// the same key.
			assert.strictEqual(canonicalize_ip('fe80::1%eth0'), 'fe80::1%eth0');
			assert.strictEqual(canonicalize_ip('FE80::1%ETH0'), 'fe80::1%eth0');
			assert.strictEqual(canonicalize_ip('::1%lo'), '::1%lo');
		});

		test('uppercase-only non-hex letters pass through', () => {
			// Mixed letters outside hex range (g-z, G-Z) — fail char-set,
			// pass through (with lowercased letters in the [a-f] range).
			assert.strictEqual(canonicalize_ip('NOT-AN-IP'), 'not-an-ip');
		});

		test('passes through char-set-valid forms that crash the IPv6 parser', () => {
			// Closes the `catch { return lowered; }` branch in `canonicalize_ip`'s
			// IPv6 arm. The trigger shape is "IPv4-style dotted-quad followed by
			// a colon-suffix" — Hono's `convertIPv6ToBinary` reads the trailing
			// `:NNN` as if it were a hex group's worth of digits, then trips
			// `NaN.toBigInt()` deep in the parser and throws. Without the catch,
			// an attacker who controls XFF could induce a 500 from the proxy
			// middleware by rotating these forms; with the catch, they pass
			// through verbatim and downstream `validate_ip_strict` rejects them
			// at the walker.
			//
			// `'203.0.113.1:8080'` above (the port-suffix passthrough test) is
			// the canonical case; these belt-and-suspenders forms guard against
			// a refactor that narrowed the catch (e.g. matched only on `Error`
			// subtype) and let the throw escape.
			//
			// Pure-shape errors like `'1:2:3:4:5:6:7:8:9'`, `':::'`, `'::ffff:'`,
			// `'1::2::3'` do NOT throw — Hono parses them as garbage bigints —
			// so they're not catch-branch coverage and aren't listed here.
			assert.strictEqual(canonicalize_ip('10.0.0.1:80'), '10.0.0.1:80');
			assert.strictEqual(canonicalize_ip('1.2.3.4:5'), '1.2.3.4:5');
		});

		test('IPv4-shaped but out-of-range octets pass through', () => {
			// JSDoc claim: `'999.999.999.999'` and similar IPv4-shaped malformed
			// inputs pass through unchanged so `validate_ip_strict` can reject
			// them downstream. The char-set filter accepts `[0-9.]`, but Hono's
			// `distinctRemoteAddr` returns `undefined` (not `'IPv4'`) on these
			// — the function falls through past both the IPv4 and IPv6 branches
			// to the final `return lowered`. If Hono ever tightened
			// `distinctRemoteAddr` to throw or to misclassify, this test would
			// surface the change.
			assert.strictEqual(canonicalize_ip('999.999.999.999'), '999.999.999.999');
			assert.strictEqual(canonicalize_ip('300.0.0.1'), '300.0.0.1');
			assert.strictEqual(canonicalize_ip('1.2.3.256'), '1.2.3.256');
			assert.strictEqual(canonicalize_ip('1.2.3.4.5'), '1.2.3.4.5');
		});
	});
});
