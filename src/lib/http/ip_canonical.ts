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
 * Canonicalization runs through `canonicalize_ip` which:
 *
 * 1. Lowercases and char-set filters (`IP_LITERAL_CHARS`) — non-IP
 *    strings (`'unknown'`, `'attacker:controlled'`, `'::1\n'`) pass
 *    through unchanged so downstream strict validators can still
 *    reject them.
 * 2. Parses with `parse_ipv4_bits` / `parse_ipv6_bits` — the grammar of
 *    Rust's `IpAddr::from_str`, which the spine parses with.
 * 3. Re-emits the canonical RFC 5952 string (lowercase hex,
 *    longest-zero-run compressed, IPv4-mapped emitted in the dotted
 *    form mandated by RFC 5952 §5).
 * 4. Strips the `::ffff:` prefix from dotted IPv4-mapped forms so the
 *    bucket collapses to plain IPv4 — the strip moves AFTER
 *    canonicalization because the dotted form is the only form the
 *    strip can recognize symmetrically.
 *
 * Mirrors the Rust spine's `fuz_http::normalize_ip`, which uses the same
 * parse-then-canonicalize-then-strip ordering for the same
 * rate-limit-key-poisoning surface.
 *
 * `rate_limit_ip_key` is the bucket key an IP-keyed rate limiter uses: an
 * IPv6 address collapses to its `/64`, the smallest block a host is commonly
 * assigned, so rotating through one's own subnet buys no fresh budget. Only
 * the limiter call sites apply it — the client IP stays the full address
 * everywhere else (audit rows, token `last_used_ip`, `REMOTE_ADDR`).
 *
 * The module imports nothing: the action dispatcher keys its IP limiter
 * through it, so it must not pull the optional `hono` peer.
 *
 * @module
 */

/** A dotted-quad IPv4 address: four decimal octets, 0–255, no leading zeros. */
const IPV4_REGEX =
	/^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

/** One IPv6 group: one to four hex digits. */
const IPV6_GROUP_REGEX = /^[0-9a-fA-F]{1,4}$/;

/**
 * Parse a dotted-quad IPv4 address to its 32-bit value.
 *
 * Four decimal octets, each 0–255 with no leading zeros (`01.2.3.4` is
 * refused, as Rust's `Ipv4Addr::from_str` refuses it).
 *
 * @returns the address as an unsigned 32-bit number, or `null` when `ip` isn't one
 */
export const parse_ipv4_bits = (ip: string): number | null => {
	if (!IPV4_REGEX.test(ip)) return null;
	let bits = 0;
	for (const octet of ip.split('.')) bits = bits * 256 + Number(octet);
	return bits;
};

/**
 * Parse the colon-separated groups on one side of a `::` (or the whole
 * address when there is none), `null` on a malformed one. Only the last group
 * of the address may be a dotted-quad IPv4 tail, which fills two groups.
 */
const parse_ipv6_groups = (part: string, allow_ipv4_tail: boolean): Array<number> | null => {
	if (part === '') return [];
	const pieces = part.split(':');
	const groups: Array<number> = [];
	for (let i = 0; i < pieces.length; i++) {
		const piece = pieces[i]!;
		if (allow_ipv4_tail && i === pieces.length - 1 && piece.includes('.')) {
			const ipv4 = parse_ipv4_bits(piece);
			if (ipv4 === null) return null;
			groups.push(Math.floor(ipv4 / 0x10000), ipv4 % 0x10000);
		} else if (IPV6_GROUP_REGEX.test(piece)) {
			groups.push(parseInt(piece, 16));
		} else {
			return null;
		}
	}
	return groups;
};

/**
 * Parse an IPv6 address to its 128-bit value.
 *
 * The grammar of Rust's `Ipv6Addr::from_str`: eight groups of one to four
 * hex digits (either case), or fewer around a single `::` standing for one or
 * more zero groups, the last two groups optionally written as a dotted-quad
 * IPv4 address. No zone (`%eth0`) — callers strip it first.
 *
 * @returns the address as a `bigint` in `[0, 2^128)`, or `null` when `ip` isn't one
 */
export const parse_ipv6_bits = (ip: string): bigint | null => {
	const halves = ip.split('::');
	let groups: Array<number>;
	if (halves.length === 1) {
		const all = parse_ipv6_groups(ip, true);
		if (all === null || all.length !== 8) return null;
		groups = all;
	} else if (halves.length === 2) {
		const head = parse_ipv6_groups(halves[0]!, false);
		const tail = parse_ipv6_groups(halves[1]!, true);
		if (head === null || tail === null || head.length + tail.length > 7) return null;
		groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
	} else {
		return null;
	}
	let bits = 0n;
	for (const group of groups) bits = (bits << 16n) | BigInt(group);
	return bits;
};

/**
 * Allowed character set for a bare IP literal.
 *
 * Covers the union of IPv4 (digits + `.`), IPv6 (hex digits + `:`), and
 * IPv4-mapped IPv6 forms (`::ffff:127.0.0.1`). Anything outside this
 * set — brackets, whitespace, control bytes, letters g–z — disqualifies
 * the input from parsing.
 *
 * Same regex `http/proxy.ts`'s `validate_ip_strict` uses; exported here so
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
	// letters g-z, and `%` (so a zone) before invoking the parser, so a
	// malformed form passes through for downstream `validate_ip_strict` to
	// reject
	if (!IP_LITERAL_CHARS.test(lowered)) return lowered;

	// IPv4's dotted-decimal form is already canonical — no transform needed.
	// Malformed forms (`999.999.999.999`) fail both parsers and pass through.
	if (parse_ipv4_bits(lowered) !== null) return lowered;
	const bits = parse_ipv6_bits(lowered);
	if (bits === null) return lowered;
	const canonical = ipv6_bigint_to_canonical(bits);
	// Strip `::ffff:` only when the canonical form is dotted IPv4-mapped
	// (`::ffff:X.X.X.X`). Pure IPv6 values that happen to start with
	// `::ffff:` (e.g. `::ffff:1` → `0:0:0:0:0:0:ffff:1`, where group[5] is 0
	// not 0xffff) emit without the dot and are preserved.
	if (canonical.startsWith('::ffff:') && canonical.substring(7).includes('.')) {
		return canonical.substring(7);
	}
	return canonical;
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
 * `parse_ipv6_bits` round-trip.
 *
 * @param bits - the 128-bit IPv6 value as `bigint`. Must satisfy `0n <= bits < 2n ** 128n`;
 *   throws `RangeError` otherwise. Silent truncation would mask caller bugs since the
 *   bit-extraction loop only consumes the low 128 bits.
 * @throws {RangeError} when `bits` is negative or exceeds 128 bits
 */
export const ipv6_bigint_to_canonical = (bits: bigint): string => {
	if (bits < 0n || bits >= 1n << 128n) {
		throw new RangeError(`ipv6_bigint_to_canonical: bits out of [0, 2^128) range: ${bits}`);
	}
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

/** The high 64 bits of an IPv6 address — its `/64` network prefix. */
const IPV6_PREFIX_64_MASK = ((1n << 64n) - 1n) << 64n;

/**
 * The bucket key an IP-keyed rate limiter uses for client IP `ip`.
 *
 * An IPv6 address keys its `/64`: the low 64 bits masked off, rendered in
 * RFC 5952 canonical form with a `/64` suffix (`2001:db8:1:2::/64`; the
 * all-zero prefix is `::/64`). A zone suffix (`%eth0`) is dropped first. An
 * IPv4 address — an IPv4-mapped IPv6 one included — keys its canonical form,
 * with no suffix. Anything that doesn't parse (`'unknown'` among them) is
 * returned unchanged. Twin of the Rust spine's `fuz_http::rate_limit_ip_key`.
 *
 * For limiter keys only: audit rows and every other record of the client
 * keep the full address.
 *
 * @example
 * rate_limit_ip_key('2001:db8:1:2::1')        // → '2001:db8:1:2::/64'
 * rate_limit_ip_key('2001:db8:1:2:8000::')    // → '2001:db8:1:2::/64'
 * rate_limit_ip_key('fe80::1%eth0')           // → 'fe80::/64'
 * rate_limit_ip_key('203.0.113.7')            // → '203.0.113.7'
 * rate_limit_ip_key('unknown')                // → 'unknown'
 */
export const rate_limit_ip_key = (ip: string): string => {
	const zone_at = ip.indexOf('%');
	const canonical = canonicalize_ip(zone_at === -1 ? ip : ip.slice(0, zone_at));
	if (!IP_LITERAL_CHARS.test(canonical)) return ip;
	if (parse_ipv4_bits(canonical) !== null) return canonical;
	const bits = parse_ipv6_bits(canonical);
	if (bits === null) return ip;
	return `${ipv6_bigint_to_canonical(bits & IPV6_PREFIX_64_MASK)}/64`;
};
