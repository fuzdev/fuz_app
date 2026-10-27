/**
 * Trusted proxy configuration and middleware.
 *
 * Resolves the client IP from `X-Forwarded-For` only when the TCP connection
 * originates from a configured trusted proxy. Without this middleware,
 * `get_client_ip` returns `'unknown'`.
 *
 * @module
 */

import type { Context, MiddlewareHandler } from 'hono';
import { convertIPv4ToBinary, convertIPv6ToBinary, distinctRemoteAddr } from 'hono/utils/ipaddr';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import type { MiddlewareSpec } from './middleware_spec.ts';
import { canonicalize_ip, IP_LITERAL_CHARS } from './ip_canonical.ts';

/**
 * Normalize an IP address for consistent matching and storage.
 *
 * Delegates to `canonicalize_ip` from `http/ip_canonical.ts` — collapses
 * RFC 5952-equivalent IPv6 forms (`::1`, `::0001`, `0:0:0:0:0:0:0:1`)
 * into a single key, emits IPv4-mapped IPv6 in dotted form, and
 * strips the `::ffff:` prefix from dotted IPv4-mapped values so the
 * bucket collapses to plain IPv4.
 *
 * - Lowercases for case-insensitive IPv6 comparison.
 * - Idempotent: calling twice produces the same result.
 * - Safe on non-IP strings: `normalize_ip('unknown')` returns `'unknown'`.
 *   Malformed inputs (`'attacker:controlled'`, `'::1\n'`,
 *   `'203.0.113.1:8080'`) pass through unchanged so downstream
 *   `validate_ip_strict` can still reject them — canonicalization
 *   never erases the malformed-form signal.
 */
export const normalize_ip = (ip: string): string => canonicalize_ip(ip);

/**
 * Configuration for trusted proxy resolution.
 */
export interface ProxyOptions {
	/** Trusted proxy IPs or CIDR ranges (e.g. `'127.0.0.1'`, `'10.0.0.0/8'`, `'::1'`). */
	trusted_proxies: Array<string>;
	/** Extract the raw TCP connection IP from the Hono context. */
	get_connection_ip: (c: Context) => string | undefined;
	/** Optional logger for proxy resolution diagnostics. */
	log?: Logger;
}

/**
 * A parsed proxy entry — either an exact IP or a CIDR range.
 */
export type ParsedProxy =
	| { type: 'ip'; address: string }
	| { type: 'cidr'; network: bigint; prefix: number; address_type: 'IPv4' | 'IPv6' };

/**
 * Parse a trusted proxy entry string into a structured form.
 *
 * Accepts plain IPs (`'127.0.0.1'`, `'::1'`) and CIDR notation (`'10.0.0.0/8'`, `'fe80::/10'`).
 * Plain IPs are normalized (lowercase, IPv4-mapped IPv6 stripped) and validated.
 * CIDR prefixes are validated against address family bounds. A `/0` prefix is
 * refused for either family: it trusts every client as a proxy, so the client's
 * own `X-Forwarded-For` would choose the IP every per-IP limiter keys on.
 *
 * @param entry - IP address or CIDR notation
 * @throws Error on invalid IP, invalid CIDR network, NaN/negative/over-range prefix, or a `/0` prefix
 */
export const parse_proxy_entry = (entry: string): ParsedProxy => {
	const slash_index = entry.indexOf('/');
	if (slash_index === -1) {
		const normalized = normalize_ip(entry);
		if (!distinctRemoteAddr(normalized)) {
			throw new Error(`Invalid proxy IP: ${entry}`);
		}
		return { type: 'ip', address: normalized };
	}
	const network_str = entry.substring(0, slash_index);
	const prefix_str = entry.substring(slash_index + 1);
	const prefix = parseInt(prefix_str, 10);
	if (Number.isNaN(prefix)) {
		throw new Error(`Invalid CIDR prefix (not a number): ${entry}`);
	}
	if (prefix < 0) {
		throw new Error(`Invalid CIDR prefix (negative): ${entry}`);
	}
	if (String(prefix) !== prefix_str) {
		throw new Error(`Invalid CIDR prefix (not an integer): ${entry}`);
	}
	const address_type = distinctRemoteAddr(network_str);
	if (prefix === 0 && (address_type === 'IPv4' || address_type === 'IPv6')) {
		throw new Error(`CIDR prefix 0 trusts every address as a proxy: ${entry}`);
	}
	if (address_type === 'IPv4') {
		if (prefix > 32) {
			throw new Error(`Invalid CIDR prefix for IPv4 (max 32): ${entry}`);
		}
		const network = convertIPv4ToBinary(network_str);
		const host_mask = prefix === 32 ? 0n : (1n << BigInt(32 - prefix)) - 1n;
		if ((network & host_mask) !== 0n) {
			throw new Error(`Non-network-aligned CIDR (host bits set): ${entry}`);
		}
		return { type: 'cidr', network, prefix, address_type };
	}
	if (address_type === 'IPv6') {
		if (prefix > 128) {
			throw new Error(`Invalid CIDR prefix for IPv6 (max 128): ${entry}`);
		}
		const network = convertIPv6ToBinary(network_str);
		const host_mask = prefix === 128 ? 0n : (1n << BigInt(128 - prefix)) - 1n;
		if ((network & host_mask) !== 0n) {
			throw new Error(`Non-network-aligned CIDR (host bits set): ${entry}`);
		}
		return { type: 'cidr', network, prefix, address_type };
	}
	throw new Error(`Invalid proxy CIDR: ${entry}`);
};

/**
 * Check whether an IP falls within a CIDR range.
 *
 * Compares the top `prefix` bits by right-shifting both values.
 */
const cidr_contains = (
	ip_binary: bigint,
	network: bigint,
	prefix: number,
	total_bits: number
): boolean => {
	const shift = BigInt(total_bits - prefix);
	return ip_binary >> shift === network >> shift;
};

/**
 * Strict IP validity check.
 *
 * Defense in depth around Hono's `hono/utils/ipaddr` helpers, which are
 * lax in two ways:
 *
 * 1. `distinctRemoteAddr` classifies anything-with-a-colon as `'IPv6'`,
 *    including `'host:port'`, `'attacker:controlled'`, `'203.0.113.1:8080'`.
 * 2. `convertIPv6ToBinary` silently accepts malformed forms like
 *    `'[::1]:8080'` and `'::1\n'`, parsing them as inconsistent binary
 *    values that would still serve as distinct rate-limit keys for an
 *    attacker rotating the suffix.
 *
 * Strict validation here is two-layered: a character-set pre-filter
 * (`IP_LITERAL_CHARS`), then a round-trip through `convertIPv*ToBinary`
 * to confirm the input parses cleanly. Either layer alone has holes;
 * together they reject every input form we've seen Hono mis-handle.
 *
 * Used as the security primitive for any code path that takes an IP
 * string from an untrusted source (XFF, query params) and uses it as a
 * key (rate limiting, audit subject) or compares it against trusted
 * proxies via CIDR (where the latent throw would otherwise bubble out).
 *
 * @returns the address family on success, `undefined` if the string is
 *          not a strictly-valid IP
 */
export const validate_ip_strict = (ip: string): 'IPv4' | 'IPv6' | undefined => {
	if (!IP_LITERAL_CHARS.test(ip)) return undefined;
	const type = distinctRemoteAddr(ip);
	if (!type) return undefined;
	try {
		if (type === 'IPv4') convertIPv4ToBinary(ip);
		else convertIPv6ToBinary(ip);
		return type;
	} catch {
		return undefined;
	}
};

/**
 * Check whether `ip` matches any entry in the trusted proxy list.
 *
 * Normalizes `ip` before matching (lowercase, IPv4-mapped IPv6 stripped).
 * Uses `validate_ip_strict` to reject malformed input — without strict
 * validation, Hono's lax `distinctRemoteAddr` would let an entry like
 * `'203.0.113.1:8080'` (false-positive `'IPv6'`) reach
 * `convertIPv6ToBinary` in the CIDR-match branch and throw.
 */
export const is_trusted_ip = (ip: string, proxies: Array<ParsedProxy>): boolean => {
	const normalized = normalize_ip(ip);
	const address_type = validate_ip_strict(normalized);
	if (!address_type) return false;

	for (const proxy of proxies) {
		if (proxy.type === 'ip') {
			if (proxy.address === normalized) return true;
			continue;
		}
		// CIDR match — skip mismatched address families
		if (proxy.address_type !== address_type) continue;
		if (address_type === 'IPv4') {
			if (cidr_contains(convertIPv4ToBinary(normalized), proxy.network, proxy.prefix, 32))
				return true;
		} else {
			if (cidr_contains(convertIPv6ToBinary(normalized), proxy.network, proxy.prefix, 128))
				return true;
		}
	}
	return false;
};

/**
 * Resolve the real client IP from an `X-Forwarded-For` header value.
 *
 * Walks right-to-left, skipping trusted proxy entries. The first untrusted
 * entry is the client IP. The walk **stops** at the first entry that fails
 * strict IP validation (`validate_ip_strict`) and returns `undefined`, so the
 * middleware falls back to the connection IP: an entry is only as
 * trustworthy as the hop that wrote it, and everything left of a malformed
 * one was written before any trusted hop vouched for it. If every entry is
 * trusted, returns the leftmost one (likely-misconfigured all-trusted case).
 * Empty entries are dropped before the walk. All entries are normalized
 * before matching and in the returned value.
 *
 * Stopping, not skipping, is the rate-limit-key rule. Returning a malformed
 * entry would let an attacker rotate arbitrary strings (incl.
 * `'attacker:controlled'`, which Hono's lax `distinctRemoteAddr`
 * misclassifies as IPv6) into fresh per-IP rate-limit buckets; skipping it
 * and walking on would hand the key to the entry the client wrote whenever a
 * trusted hop appends a non-bare-IP token (`ip:port`, `[v6]:port`,
 * `unknown`, `unix:`). Tradeoff: behind such a proxy every client collapses
 * to the proxy's connection IP in rate limiting (one bucket for everyone
 * behind it). Standard proxies (nginx's `$remote_addr`, cloud LBs) append
 * bare IPs.
 *
 * @param forwarded_for - the `X-Forwarded-For` header value
 * @param proxies - parsed trusted proxy entries
 * @returns the normalized client IP, or `undefined` if the header is empty or the walk met a malformed entry
 */
export const resolve_client_ip = (
	forwarded_for: string,
	proxies: Array<ParsedProxy>
): string | undefined => {
	const entries: Array<string> = [];
	for (const raw of forwarded_for.split(',')) {
		const trimmed = raw.trim();
		if (trimmed) entries.push(normalize_ip(trimmed));
	}
	if (entries.length === 0) return undefined;

	// Walk from right to left, skipping trusted proxies; stop at a malformed
	// entry. Everything left of it is client-written, so neither it nor any
	// entry past it may pick the per-IP rate-limit key.
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (!validate_ip_strict(entry)) return undefined;
		if (!is_trusted_ip(entry, proxies)) {
			return entry;
		}
	}
	// Every entry was valid and trusted — the leftmost one; the
	// misconfiguration warn in the middleware fires on it.
	return entries[0];
};

/**
 * Create a Hono middleware that resolves the client IP from trusted proxies.
 *
 * Sets `client_ip` on the Hono context for downstream use by `get_client_ip`.
 * All client IPs are normalized (lowercase, IPv4-mapped IPv6 stripped).
 *
 * Resolution logic:
 * 1. No `X-Forwarded-For` → use connection IP directly.
 * 2. `X-Forwarded-For` present but connection is untrusted → ignore header
 *    (spoofed by a direct attacker), use connection IP.
 * 3. `X-Forwarded-For` present and connection is trusted → walk header
 *    right-to-left, strip trusted entries, use first untrusted entry; a
 *    malformed entry stops the walk and the connection IP is used.
 *
 * @param options - trusted proxy configuration
 * @mutates `c.var.client_ip` - set to the resolved (or `'unknown'`) client IP per request
 * @throws Error if any entry in `options.trusted_proxies` is invalid (parsed eagerly via `parse_proxy_entry`)
 */
export const create_proxy_middleware = (options: ProxyOptions): MiddlewareHandler => {
	const parsed_proxies = options.trusted_proxies.map(parse_proxy_entry);
	const { log } = options;

	return async (c, next) => {
		const connection_ip = options.get_connection_ip(c);
		const forwarded_for = c.req.header('x-forwarded-for');

		let client_ip: string;

		if (!forwarded_for) {
			// No proxy header — use connection IP directly
			client_ip = connection_ip ? normalize_ip(connection_ip) : 'unknown';
			if (!connection_ip) {
				log?.warn('Connection IP is undefined — client_ip set to unknown');
			}
		} else if (!connection_ip || !is_trusted_ip(connection_ip, parsed_proxies)) {
			// Header present but connection is untrusted — ignore spoofed header
			client_ip = connection_ip ? normalize_ip(connection_ip) : 'unknown';
			if (connection_ip) {
				log?.debug('XFF ignored — connection from untrusted IP:', connection_ip);
			} else {
				log?.warn('Connection IP is undefined with XFF present — client_ip set to unknown');
			}
		} else {
			// Connection from a trusted proxy — resolve from header
			const resolved = resolve_client_ip(forwarded_for, parsed_proxies);
			if (!resolved) {
				client_ip = normalize_ip(connection_ip);
			} else {
				client_ip = resolved;
				// all XFF entries were trusted — likely misconfiguration
				if (is_trusted_ip(resolved, parsed_proxies)) {
					log?.warn('All XFF entries are trusted — possible misconfiguration:', forwarded_for);
				}
			}
		}

		c.set('client_ip', client_ip);
		await next();
	};
};

/**
 * Create a middleware spec for trusted proxy resolution.
 *
 * Apply before auth middleware so `client_ip` is available for rate limiting.
 *
 * @param options - trusted proxy configuration
 */
export const create_proxy_middleware_spec = (options: ProxyOptions): MiddlewareSpec => ({
	name: 'trusted_proxy',
	path: '*',
	handler: create_proxy_middleware(options)
});
