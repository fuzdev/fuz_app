/**
 * `assert_response_matches_spec` over a route whose output and error schemas
 * are `@fuzdev/fuz_schema`: a matching body passes, a mismatch throws with
 * the fuz_schema issues.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { literal, loose_object, object, string } from '@fuzdev/fuz_schema/schema.ts';

import type { RouteSpec } from '#lib/http/route_spec.ts';
import { assert_response_matches_spec } from '#lib/testing/integration_helpers.ts';

const spec: RouteSpec = {
	method: 'POST',
	path: '/api/things',
	auth: { account: 'none', actor: 'none' },
	description: 'Creates a thing.',
	input: object({ name: string }),
	output: object({ id: string }),
	errors: { 409: loose_object({ error: literal('thing_taken') }) },
	handler: (c) => c.json({ id: 'x' })
};

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});

describe('assert_response_matches_spec on a fuz_schema route', () => {
	test('passes a matching output and error body', async () => {
		await assert_response_matches_spec([spec], 'POST', '/api/things', json({ id: 'x' }, 200));
		await assert_response_matches_spec(
			[spec],
			'POST',
			'/api/things',
			json({ error: 'thing_taken' }, 409)
		);
	});

	test('throws on an output mismatch', async () => {
		let err: unknown;
		try {
			await assert_response_matches_spec([spec], 'POST', '/api/things', json({ id: 5 }, 200));
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof Error);
		assert.match(
			err.message,
			/^Output schema mismatch for POST \/api\/things \(200\): \[\{"kind":"string"/
		);
	});

	test('throws on an error-body mismatch with the fuz_schema issues', async () => {
		let err: unknown;
		try {
			await assert_response_matches_spec(
				[spec],
				'POST',
				'/api/things',
				json({ error: 'other' }, 409)
			);
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof Error);
		assert.match(
			err.message,
			/^Error schema mismatch for POST \/api\/things \(409\): \[\{"kind":"literal"/
		);
	});
});
