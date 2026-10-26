/**
 * `cross_drain_effects` holds the drain to `tracked: true`, so a backend whose
 * audit emitter was built without in-flight tracking fails its first audit
 * read instead of racing it.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	cross_drain_effects,
	type AuditReadFixture
} from '#lib/testing/cross_backend/audit_cross_helpers.ts';
import type { FetchTransport } from '#lib/testing/transports/fetch_transport.ts';

/** A fixture whose transport answers the drain with `result`, recording each call. */
const create_fixture = (result: unknown): { fixture: AuditReadFixture; methods: Array<string> } => {
	const methods: Array<string> = [];
	const transport: FetchTransport = Object.assign(
		async (_path: string, init?: RequestInit) => {
			methods.push((JSON.parse(init!.body as string) as { method: string }).method);
			return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
		},
		{ cookies: () => [] }
	);
	const fixture: AuditReadFixture = {
		fresh_transport: () => transport,
		create_session_headers: () => ({}),
		create_daemon_token_headers: () => ({})
	};
	return { fixture, methods };
};

describe('cross_drain_effects', () => {
	test('accepts a tracked drain', async () => {
		const { fixture, methods } = create_fixture({ ok: true, tracked: true });
		await cross_drain_effects(fixture);
		assert.deepStrictEqual(methods, ['_testing_drain_effects']);
	});

	test('refuses tracked: false', async () => {
		const { fixture } = create_fixture({ ok: true, tracked: false });
		const error = await assert_rejects(() => cross_drain_effects(fixture));
		assert.include(error.message, 'tracked: true');
		assert.include(error.message, '"tracked":false');
	});

	test('refuses an answer without tracked', async () => {
		const { fixture } = create_fixture({ ok: true });
		const error = await assert_rejects(() => cross_drain_effects(fixture));
		assert.include(error.message, 'tracked: true');
	});

	test('refuses a truthy tracked that is not true', async () => {
		const { fixture } = create_fixture({ ok: true, tracked: 'true' });
		await assert_rejects(() => cross_drain_effects(fixture));
	});
});
