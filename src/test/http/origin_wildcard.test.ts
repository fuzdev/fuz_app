/**
 * Tests for `http/origin_wildcard.ts` — the wildcard shapes classify as the
 * Rust spine's `OriginPattern::wildcard_kind` does (its table, ported), the
 * text is the Rust `origin_wildcard_warning` with no host gate and no note,
 * and `admit_origin_wildcards` refuses or admits as its Rust twin does.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { parse_allowed_origins, type OriginPattern } from '#lib/http/origin.ts';
import {
	admit_origin_wildcards,
	origin_wildcard_kind,
	origin_wildcard_warning,
	type OriginWildcard
} from '#lib/http/origin_wildcard.ts';

const parse = (raw: string): { origins: Array<RegExp>; patterns: Array<OriginPattern> } => {
	const result = parse_allowed_origins(raw);
	if (!result.ok) throw new Error(`${raw}: ${JSON.stringify(result.errors)}`);
	return result;
};

const pattern = (entry: string): OriginPattern => {
	const [first] = parse(entry).patterns;
	assert.ok(first);
	return first;
};

const warning = (entry: string): string => {
	const text = origin_wildcard_warning(pattern(entry));
	assert.ok(text, `${entry} warns`);
	return text;
};

describe('origin_wildcard_kind', () => {
	const partial = { kind: 'partial' } as const;
	const whole = (labels: number) => ({ kind: 'whole', labels }) as const;
	const cases: Array<[string, OriginWildcard | null]> = [
		['http://localhost:5173', null],
		['https://app.example.com', null],
		['http://[::1]:3000', null],
		['http://[2001:db8::1]', null],
		['http://localhost:*', { kind: 'port' }],
		['http://192.168.1.10:*', { kind: 'port' }],
		['http://[::1]:*', { kind: 'port' }],
		['https://*.example.com', { kind: 'host', host: partial }],
		['https://example.*', { kind: 'host', host: partial }],
		['http://app.*.test:5460', { kind: 'host', host: partial }],
		['http://192.168.1.*', { kind: 'host', host: partial }],
		['http://*', { kind: 'host', host: whole(1) }],
		['https://*.*', { kind: 'host', host: whole(2) }],
		['http://*.*.*.*', { kind: 'host', host: whole(4) }],
		['https://*.example.com:*', { kind: 'host_and_port', host: partial }],
		['http://*:*', { kind: 'host_and_port', host: whole(1) }]
	];
	for (const [entry, kind] of cases) {
		test(entry, () => {
			assert.deepStrictEqual(origin_wildcard_kind(pattern(entry)), kind);
		});
	}

	test('the host is the parsed one', () => {
		for (const [entry, host] of [
			['https://*.Example.COM:*', '*.example.com'],
			['http://localhost:5173', 'localhost'],
			['http://[::1]:*', '[::1]'],
			['http://*', '*']
		] as const) {
			assert.strictEqual(pattern(entry).host, host);
		}
	});
});

describe('origin_wildcard_warning', () => {
	test('exact origins carry none', () => {
		for (const entry of [
			'http://localhost:5460',
			'http://127.0.0.1:4460',
			'https://zzz.example.com',
			'http://[::1]:5460',
			'http://[2001:db8::1]'
		]) {
			assert.strictEqual(origin_wildcard_warning(pattern(entry)), null, entry);
		}
	});

	test('the whole text of one warning, as the Rust spine renders it', () => {
		assert.strictEqual(
			warning('https://*.example.com'),
			'host wildcard: a page served from ANY host matching `*.example.com` (each `*` is ' +
				'any one label) is an allowed origin. The server trusts every such page: one that ' +
				'is same-site with the host you log in at carries the session cookie, and with it ' +
				'can call the API and open the WebSocket. Name exact origins unless every such page ' +
				'is trusted'
		);
	});

	test('a port wildcard names the host at any port', () => {
		for (const [entry, host] of [
			['http://localhost:*', 'localhost'],
			['http://192.168.1.10:*', '192.168.1.10'],
			['http://[::1]:*', '[::1]']
		] as const) {
			const text = warning(entry);
			assert.ok(text.startsWith('port wildcard: '), text);
			assert.include(text, `ANY port on \`${host}\` is an allowed origin`);
			assert.notInclude(text, 'ANY host');
		}
	});

	test('a host wildcard names every matching host', () => {
		for (const [entry, host, ports] of [
			['https://*.example.com', '*.example.com', 'from ANY host'],
			['https://example.*', 'example.*', 'from ANY host'],
			['http://app.*.test:5460', 'app.*.test', 'from that port on ANY host'],
			['http://192.168.1.*', '192.168.1.*', 'from ANY host']
		] as const) {
			const text = warning(entry);
			assert.ok(text.startsWith('host wildcard: '), text);
			assert.include(text, `${ports} matching \`${host}\` (each \`*\` is any one label)`);
			assert.notInclude(text, 'ANY port');
		}
	});

	test('a whole-host wildcard says no label is fixed', () => {
		for (const [entry, shape] of [
			['http://*', 'every single-label name, `localhost` included'],
			['https://*.*', 'every hostname of 2 labels'],
			['https://*.*.*', 'every hostname of 3 labels'],
			['http://*.*.*.*', 'every IPv4 address and every four-label hostname']
		] as const) {
			const text = warning(entry);
			assert.ok(text.startsWith('host wildcard: '), text);
			assert.include(text, 'ANY host of that shape');
			assert.include(text, shape);
		}
	});

	test('a host and port wildcard says both', () => {
		for (const [entry, hosts] of [
			['https://*.example.com:*', 'ANY port on ANY host matching `*.example.com`'],
			[
				'http://*:*',
				'ANY port on ANY host of that shape (no label of `*` is fixed: every ' +
					'single-label name, `localhost` included) is an allowed origin'
			]
		] as const) {
			const text = warning(entry);
			assert.ok(text.startsWith('host and port wildcard: '), text);
			assert.include(text, hosts);
		}
	});
});

describe('admit_origin_wildcards', () => {
	const MIXED = 'https://app.example, http://localhost:*, https://*.example.com';

	test('a wildcard is refused without the opt-in, each entry named', () => {
		const result = admit_origin_wildcards(parse(MIXED).origins, false);
		assert.ok(!result.ok);
		assert.ok(
			result.message.startsWith(
				'FUZ_ALLOWED_ORIGINS holds a wildcard entry, refused unless ' +
					'FUZ_ALLOW_ORIGIN_WILDCARDS=true. '
			),
			result.message
		);
		assert.include(
			result.message,
			'`http://localhost:*`: port wildcard: a page served from ANY port on `localhost`'
		);
		assert.include(
			result.message,
			'`https://*.example.com`: host wildcard: a page served from ANY host'
		);
		assert.notInclude(result.message, '`https://app.example`');
	});

	test('a wildcard is admitted with the opt-in, with what each admits', () => {
		const result = admit_origin_wildcards(parse(MIXED).origins, true);
		assert.ok(result.ok);
		assert.deepStrictEqual(result.wildcards, [
			{ entry: 'http://localhost:*', warning: warning('http://localhost:*') },
			{ entry: 'https://*.example.com', warning: warning('https://*.example.com') }
		]);
	});

	test('an exact list passes either way', () => {
		for (const allowed of [false, true]) {
			const result = admit_origin_wildcards(
				parse('https://app.example, http://[::1]:3000').origins,
				allowed
			);
			assert.ok(result.ok);
			assert.deepStrictEqual(result.wildcards, []);
		}
	});

	test('a matcher not built by parse_allowed_origins is refused, flag or not', () => {
		const hand_built = /^http:\/\/localhost(?::\d+)?$/;
		// a copy of a parsed matcher carries no pattern either
		const [parsed] = parse('http://localhost:5173').origins;
		assert.ok(parsed);
		const copied = new RegExp(parsed);
		for (const allowed of [false, true]) {
			const result = admit_origin_wildcards(
				[...parse('https://app.example').origins, hand_built, copied],
				allowed
			);
			assert.ok(!result.ok);
			assert.strictEqual(
				result.message,
				'FUZ_ALLOWED_ORIGINS holds a matcher `parse_allowed_origins` did not build, so its ' +
					"wildcards can't be checked: `/^http:\\/\\/localhost(?::\\d+)?$/`, " +
					'`/^http:\\/\\/localhost:5173$/i`. Build the list with `parse_allowed_origins`.'
			);
		}
	});

	test('the refusal names the list it was given', () => {
		const result = admit_origin_wildcards(
			parse('http://localhost:*').origins,
			false,
			'ws_endpoints allowed_origins for /api/ws'
		);
		assert.ok(!result.ok);
		assert.ok(
			result.message.startsWith('ws_endpoints allowed_origins for /api/ws holds a wildcard entry'),
			result.message
		);
	});

	test('a matcher another fuz_app copy parsed classifies through the realm-global brand', () => {
		const [parsed] = parse('http://localhost:*').origins;
		assert.ok(parsed);
		assert.deepStrictEqual(Object.keys(parsed), [], 'the brand is not enumerable');
		// a second copy of `origin.ts` brands with the same `Symbol.for` key
		const foreign = new RegExp(parsed);
		const brand = Symbol.for('@fuzdev/fuz_app/OriginPattern');
		Object.defineProperty(foreign, brand, {
			value: Object.getOwnPropertyDescriptor(parsed, brand)?.value
		});
		const refused = admit_origin_wildcards([foreign], false);
		assert.ok(!refused.ok);
		assert.include(refused.message, 'holds a wildcard entry');
		const admitted = admit_origin_wildcards([foreign], true);
		assert.ok(admitted.ok);
		assert.deepStrictEqual(
			admitted.wildcards.map((w) => w.entry),
			['http://localhost:*']
		);
	});
});
