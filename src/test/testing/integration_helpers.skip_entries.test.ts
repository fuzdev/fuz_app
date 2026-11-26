/**
 * Tests for `assert_skip_entries_known`, the check every suite's skip list
 * runs at collection.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { assert_skip_entries_known } from '#lib/testing/integration_helpers.ts';

describe('assert_skip_entries_known', () => {
	const known = new Set(['GET /a', 'DELETE /f/:filename{.+}']);

	test('passes entries that name a known key, regex params included', () => {
		assert_skip_entries_known(
			'owner',
			'skip_routes',
			['GET /a', 'DELETE /f/:filename{.+}'],
			known,
			'n'
		);
	});

	test('passes no entries', () => {
		assert_skip_entries_known('owner', 'skip_routes', undefined, known, 'n');
		assert_skip_entries_known('owner', 'skip_routes', [], new Set(), 'n');
	});

	test('throws on an entry naming nothing, with owner, field and noun', () => {
		assert.throws(
			() =>
				assert_skip_entries_known('owner', 'skip_routes', ['GET /a', 'GET /b'], known, 'a route'),
			"owner: skip_routes names 'GET /b', which is not a route"
		);
	});

	test('matches exactly — case and spacing count', () => {
		assert.throws(
			() => assert_skip_entries_known('owner', 'skip_routes', ['get /a'], known, 'a route'),
			/names 'get \/a'/
		);
		assert.throws(
			() => assert_skip_entries_known('owner', 'skip_routes', ['GET  /a'], known, 'a route'),
			/names 'GET {2}\/a'/
		);
	});
});
