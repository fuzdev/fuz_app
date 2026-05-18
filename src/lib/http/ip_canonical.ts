/**
 * IP address canonicalization — collapse equivalent string forms into a
 * single key per RFC 5952 (IPv6) plus the dotted form for IPv4-mapped
 * IPv6 addresses.
 *
 * **Why this exists.** Without canonicalization, the four representations
 * `::1`, `::01`, `::0001`, and `0:0:0:0:0:0:0:1` are the same IPv6 address
 * but produce four distinct strings — so an attacker rotating
 * equivalent forms behind a trusted-passthrough proxy could defeat
 * per-IP rate limiting (each form gets a fresh bucket) and pollute
 * `audit_log.ip` forensics. The collision can extend to IPv4-mapped
 * IPv6 forms (`::ffff:127.0.0.1` vs `0:0:0:0:0:ffff:7f00:1` vs the
 * bare `127.0.0.1`) — three keys for one address.
 *
 * Canonicalization runs through {@link canonicalize_ip} which:
 *
 * 1. Lowercases and char-set filters (`IP_LITERAL_CHARS`) — non-IP
 *    strings (`'unknown'`, `'attacker:controlled'`, `'::1\n'`) pass
 *    through unchanged so downstream strict validators can still
 *    reject them.
 * 2. Parses via Hono's `convertIPv*ToBinary` family.
 * 3. Re-emits the canonical RFC 5952 string (lowercase hex,
 *    longest-zero-run compressed, IPv4-mapped emitted in the dotted
 *    form mandated by RFC 5952 §5).
 * 4. Strips the `::ffff:` prefix from dotted IPv4-mapped forms so the
 *    bucket collapses to plain IPv4 — the strip moves AFTER
 *    canonicalization because the dotted form is the only form the
 *    strip can recognize symmetrically.
 *
 * Mirrors `zzz_server::proxy::normalize_ip` (landed 2026-05-16) which
 * uses the same parse-then-canonicalize-then-strip ordering for the
 * same rate-limit-key-poisoning surface.
 *
 * @module
 */

import {convertIPv6ToBinary, distinctRemoteAddr} from 'hono/utils/ipaddr';

/**
 * Allowed character set for a bare IP literal.
 *
 * Covers the union of IPv4 (digits + `.`), IPv6 (hex digits + `:`), and
 * IPv4-mapped IPv6 forms (`::ffff:127.0.0.1`). Anything outside this
 * set — brackets, whitespace, control bytes, letters g–z — disqualifies
 * the input from parsing.
 *
 * Same regex `proxy.ts`'s `validate_ip_strict` uses; exported here so
 * both modules can share one source of truth.
 */
export const IP_LITERAL_CHARS = /^[0-9a-fA-F.:]+$/;

/**
 * Canonicalize an IP address string.
 *
 * Returns the RFC 5952 canonical form for parseable IPv4 or IPv6
 * input. Returns the input unchanged (only lowercased) when the input
 * is non-IP (`'unknown'`), malformed (`'attacker:controlled'`,
 * `'::1\n'`), or any string the strict char-set filter rejects.
 *
 * **Idempotent.** `canonicalize_ip(canonicalize_ip(x)) === canonicalize_ip(x)`
 * for every input.
 *
 * **Order-safe for IPv4-mapped IPv6.** The `::ffff:` prefix strip
 * runs AFTER the canonical emit because the canonical form of an
 * IPv4-mapped IPv6 address is the dotted form (`::ffff:127.0.0.1`,
 * not `::ffff:7f00:1`). Stripping before canonicalize would miss the
 * full-hex form. Closes the
 * `normalize_ipv4_mapped_collapse_is_order_safe` test from the Rust
 * port.
 *
 * @example
 * canonicalize_ip('::0001')                    // → '::1'
 * canonicalize_ip('0:0:0:0:0:0:0:1')           // → '::1'
 * canonicalize_ip('2001:0DB8::0001')           // → '2001:db8::1'
 * canonicalize_ip('::ffff:127.0.0.1')          // → '127.0.0.1'
 * canonicalize_ip('0:0:0:0:0:ffff:7f00:1')     // → '127.0.0.1'
 * canonicalize_ip('::ffff:1')                  // → '::ffff:1' (NOT IPv4-mapped — group[5] is 0, not ffff)
 * canonicalize_ip('127.0.0.1')                 // → '127.0.0.1'
 * canonicalize_ip('not-an-ip')                 // → 'not-an-ip' (passes through)
 * canonicalize_ip('::1\n')                     // → '::1\n' (fails char-set; passes through)
 * canonicalize_ip('203.0.113.1:8080')          // → '203.0.113.1:8080' (passes through; validate_ip_strict rejects)
 */
export const canonicalize_ip = (ip: string): string => {
	const lowered = ip.toLowerCase();
	// Strict char-set filter — reject brackets, whitespace, control bytes,
	// letters g-z before invoking the parser. Hono's `convertIPv6ToBinary`
	// silently accepts `'::1\n'` and similar; canonicalizing those would
	// erase the malformed form so downstream `validate_ip_strict` could no
	// longer reject it. Pass-through preserves the original string.
	if (!IP_LITERAL_CHARS.test(lowered)) return lowered;

	const family = distinctRemoteAddr(lowered);
	if (family === 'IPv4') {
		// IPv4's dotted-decimal form is already canonical — no transform
		// needed. Malformed forms (`999.999.999.999`) still pass through
		// here; downstream `validate_ip_strict` rejects them via its own
		// round-trip parse.
		return lowered;
	}
	if (family === 'IPv6') {
		try {
			const bits = convertIPv6ToBinary(lowered);
			const canonical = ipv6_bigint_to_canonical(bits);
			// Strip `::ffff:` only when the canonical form is dotted
			// IPv4-mapped (`::ffff:X.X.X.X`). Pure IPv6 values that happen
			// to start with `::ffff:` (e.g. `::ffff:1` → `0:0:0:0:0:0:ffff:1`,
			// where group[5] is 0 not 0xffff) emit without the dot and
			// are preserved.
			if (canonical.startsWith('::ffff:') && canonical.substring(7).includes('.')) {
				return canonical.substring(7);
			}
			return canonical;
		} catch {
			return lowered;
		}
	}
	return lowered;
};

/**
 * Convert a 128-bit IPv6 binary value into its RFC 5952 canonical string form.
 *
 * - IPv4-mapped (groups[0..5] = 0, groups[5] = 0xffff) emits the
 *   `::ffff:a.b.c.d` dotted form per RFC 5952 §5.
 * - Otherwise: lowercase hex with no leading zeros per group (§4.1),
 *   the longest run of consecutive zero groups (≥ 2 groups) is
 *   replaced with `::` (§4.2.1, §4.2.3), and on equal-length runs the
 *   first one wins (§4.2.3). Single-zero groups stay as `0` (§4.2.2).
 *
 * Pure helper exported for the test suite to exercise the
 * canonicalization invariants directly without a full
 * `convertIPv6ToBinary` round-trip.
 *
 * @param bits - the 128-bit IPv6 value as `bigint` (only the low 128 bits are read)
 */
export const ipv6_bigint_to_canonical = (bits: bigint): string => {
	// Split into 8 16-bit groups, big-endian (group[0] is the high-order group).
	const groups: Array<number> = new Array(8);
	let remaining = bits;
	for (let i = 7; i >= 0; i--) {
		groups[i] = Number(remaining & 0xffffn);
		remaining >>= 16n;
	}

	// IPv4-mapped detection: leading 80 bits zero, next 16 bits 0xffff.
	if (
		groups[0] === 0 &&
		groups[1] === 0 &&
		groups[2] === 0 &&
		groups[3] === 0 &&
		groups[4] === 0 &&
		groups[5] === 0xffff
	) {
		const high = groups[6]!;
		const low = groups[7]!;
		const a = (high >> 8) & 0xff;
		const b = high & 0xff;
		const c = (low >> 8) & 0xff;
		const d = low & 0xff;
		return `::ffff:${a}.${b}.${c}.${d}`;
	}

	// Find longest run of consecutive zero groups for `::` compression.
	// RFC 5952 §4.2.1: only compress runs of two or more.
	// RFC 5952 §4.2.3: on ties, compress the first run.
	let best_start = -1;
	let best_len = 0;
	let cur_start = -1;
	let cur_len = 0;
	for (let i = 0; i < 8; i++) {
		if (groups[i] === 0) {
			if (cur_start === -1) cur_start = i;
			cur_len++;
			if (cur_len > best_len) {
				best_start = cur_start;
				best_len = cur_len;
			}
		} else {
			cur_start = -1;
			cur_len = 0;
		}
	}

	const to_hex = (g: number): string => g.toString(16);

	// RFC 5952 §4.2.2 — never compress a single zero group.
	if (best_len < 2) {
		return groups.map(to_hex).join(':');
	}

	const before = groups.slice(0, best_start).map(to_hex).join(':');
	const after = groups
		.slice(best_start + best_len)
		.map(to_hex)
		.join(':');
	return before + '::' + after;
};
