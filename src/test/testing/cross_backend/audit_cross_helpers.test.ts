/**
 * `cross_drain_effects` holds the drain to exactly `{ok: true}`, so a backend
 * answering anything else fails its first audit read instead of racing it.
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
	test('accepts the {ok: true} drain', async () => {
		const { fixture, methods } = create_fixture({ ok: true });
		await cross_drain_effects(fixture);
		assert.deepStrictEqual(methods, ['_testing_drain_effects']);
	});

	test('refuses ok: false', async () => {
		const { fixture } = create_fixture({ ok: false });
		const error = await assert_rejects(() => cross_drain_effects(fixture));
		assert.include(error.message, '{ok: true}');
		assert.include(error.message, '"ok":false');
	});

	test('refuses an unknown key, the retired tracked included', async () => {
		const { fixture } = create_fixture({ ok: true, tracked: true });
		await assert_rejects(() => cross_drain_effects(fixture));
	});

	test('refuses a truthy ok that is not true', async () => {
		const { fixture } = create_fixture({ ok: 'true' });
		await assert_rejects(() => cross_drain_effects(fixture));
	});
});
