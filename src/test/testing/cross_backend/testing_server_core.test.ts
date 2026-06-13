/**
 * Unit tests for `is_loopback_host` — the security predicate fencing the
 * test-server binary to loopback.
 *
 * The binary ships deterministic dev secrets (fixed cookie keys + bootstrap
 * token), so binding any network-reachable interface lets anyone who knows
 * those keys forge cookies against it. The predicate is an allowlist (not an
 * `0.0.0.0`/`::` blocklist) precisely so a concrete LAN/public interface IP
 * can't slip through; these cases pin that envelope.
 *
 * @module
 */

import {test, assert, describe} from 'vitest';

import {is_loopback_host} from '$lib/testing/cross_backend/testing_server_core.js';

describe('is_loopback_host', () => {
	test('accepts loopback hosts', () => {
		for (const host of [
			'localhost',
			'127.0.0.1',
			'127.0.0.2', // all of 127.0.0.0/8 is loopback
			'127.255.255.255',
			'::1',
			'[::1]', // bracketed IPv6 literal
		]) {
			assert.ok(is_loopback_host(host), `${host} should be accepted as loopback`);
		}
	});

	test('refuses wildcard bind hosts (the original blocklist set)', () => {
		for (const host of ['0.0.0.0', '::', '[::]']) {
			assert.ok(!is_loopback_host(host), `${host} must be refused`);
		}
	});

	test('refuses concrete non-loopback IPs (the gap an allowlist closes)', () => {
		for (const host of ['192.168.1.50', '10.0.0.1', '172.16.0.1', '8.8.8.8', '0.0.0.1']) {
			assert.ok(!is_loopback_host(host), `${host} is network-reachable and must be refused`);
		}
	});

	test('refuses a DNS name that merely starts with `127.`', () => {
		// The IPv4 arm is a strict dotted-quad match, not a prefix check, so a
		// resolvable name like this can't masquerade as loopback.
		assert.ok(!is_loopback_host('127.evil.example.com'));
	});
});
