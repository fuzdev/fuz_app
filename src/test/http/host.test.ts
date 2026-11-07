/**
 * Tests for `http/host.ts` — the host gate's middleware, its rate-limited
 * refusal warning, and the warning's text. The check's verdicts are the shared
 * conformance table's host rows (`http/origin.conformance.test.ts`).
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { Hono } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	create_host_gate_middleware,
	create_host_refusal_warnings,
	format_host_refusal_warning,
	HOST_REFUSAL_WARN_INTERVAL_MS
} from '#lib/http/host.ts';
import { parse_allowed_origins } from '#lib/http/origin.ts';

const origins = (raw: string): Array<RegExp> => {
	const result = parse_allowed_origins(raw);
	if (!result.ok) throw new Error(raw);
	return result.origins;
};

/** A logger whose `warn` lines land in `warnings`. */
const create_capturing_log = (): { log: Logger; warnings: Array<string> } => {
	const warnings: Array<string> = [];
	const log = new Logger('test', { level: 'off' });
	log.warn = (...args: Array<unknown>) => {
		warnings.push(args.map(String).join(' '));
	};
	return { log, warnings };
};

const create_app = (now: () => number = () => 0) => {
	const { log, warnings } = create_capturing_log();
	const app = new Hono();
	app.use(
		'*',
		create_host_gate_middleware({ allowed_origins: origins('https://app.example.com'), log, now })
	);
	app.get('/x', (c) => c.text('ok'));
	return { app, warnings };
};

describe('create_host_gate_middleware', () => {
	test('a loopback Host and a Host the allowlist names pass', async () => {
		const { app, warnings } = create_app();
		for (const host of ['localhost:4460', '127.0.0.1', '[::1]:80', 'app.example.com']) {
			const res = await app.request('/x', { headers: { host } });
			assert.strictEqual(res.status, 200, host);
		}
		assert.deepStrictEqual(warnings, []);
	});

	test('a request without a Host passes', async () => {
		const { app } = create_app();
		const res = await app.request('http://localhost/x');
		assert.strictEqual(res.status, 200);
	});

	test('a foreign Host is refused 403 forbidden_host, the body naming nothing else', async () => {
		const { app } = create_app();
		const res = await app.request('/x', { headers: { host: 'rebind.example.com' } });
		assert.strictEqual(res.status, 403);
		assert.deepStrictEqual(await res.json(), { error: 'forbidden_host' });
	});

	test('two Hosts joined into one value are refused', async () => {
		const { app } = create_app();
		const res = await app.request('/x', { headers: { host: 'localhost, rebind.example.com' } });
		assert.strictEqual(res.status, 403);
	});

	test('the first refusal warns, the rest of the interval is counted into the next', async () => {
		let now = 1_000;
		const { app, warnings } = create_app(() => now);
		const refuse = (host: string) => app.request('/x', { headers: { host } });
		await refuse('a.example');
		await refuse('b.example');
		await refuse('c.example');
		assert.strictEqual(warnings.length, 1);
		assert.include(warnings[0], '"a.example"');
		assert.include(warnings[0], 'FUZ_ALLOWED_ORIGINS');
		now += HOST_REFUSAL_WARN_INTERVAL_MS;
		await refuse('d.example');
		assert.strictEqual(warnings.length, 2);
		assert.include(warnings[1], '"d.example" (2 more refused since the last warning)');
	});
});

describe('create_host_refusal_warnings', () => {
	test('warns at most once per interval, counting what it holds back', () => {
		const warnings = create_host_refusal_warnings();
		assert.strictEqual(warnings.note(0), 0);
		assert.strictEqual(warnings.note(1), null);
		assert.strictEqual(warnings.note(2), null);
		assert.strictEqual(warnings.note(HOST_REFUSAL_WARN_INTERVAL_MS), 2);
		assert.strictEqual(warnings.note(HOST_REFUSAL_WARN_INTERVAL_MS + 1), null);
	});
});

describe('format_host_refusal_warning', () => {
	test('quotes the Host ASCII-only, so a client cannot write a control into the log', () => {
		const text = format_host_refusal_warning('evil\u001b.example', 'FUZ_ALLOWED_ORIGINS', 0);
		assert.notInclude(text, '\u001b');
		assert.include(text, '"evil\\u001b.example"');
		assert.notInclude(text, 'more refused');
	});

	test('truncates a long Host and names the count held back', () => {
		const text = format_host_refusal_warning('a'.repeat(500), 'X', 3);
		assert.isBelow(text.length, 500);
		assert.include(text, '(3 more refused since the last warning)');
	});

	test('the whole text, as the Rust spine words it', () => {
		assert.strictEqual(
			format_host_refusal_warning('rebind.example', 'FUZ_ALLOWED_ORIGINS', 0),
			'host gate refused a request for Host "rebind.example": the server answers only to ' +
				'loopback names and the hosts FUZ_ALLOWED_ORIGINS names. If it should answer to this ' +
				'name, add the origin it is served from to FUZ_ALLOWED_ORIGINS'
		);
	});
});
