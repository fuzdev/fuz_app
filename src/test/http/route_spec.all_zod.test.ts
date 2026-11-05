/**
 * An all-Zod `RouteSpec` answers byte for byte what it answered before route
 * specs took `@fuzdev/fuz_schema` schemas: its surface (JSON Schema, merged
 * error schemas, the non-strict-input warning text) and every exchange of
 * `route_spec_all_zod_helpers.ts` (status, body, `log.error` arguments),
 * captured in `fixtures/surface/route_spec_all_zod.json`.
 *
 * @module
 */

import { test, assert } from 'vitest';
import { readFileSync } from 'node:fs';

import { probe_all_zod_exchanges, probe_all_zod_surface } from './route_spec_all_zod_helpers.ts';

const FIXTURE_PATH = new URL('../fixtures/surface/route_spec_all_zod.json', import.meta.url);

test('an all-Zod route answers as captured, byte for byte', async () => {
	const live = { surface: probe_all_zod_surface(), exchanges: await probe_all_zod_exchanges() };
	const expected = readFileSync(FIXTURE_PATH, 'utf8');
	assert.deepStrictEqual(live, JSON.parse(expected));
	assert.strictEqual(JSON.stringify(live, null, '\t') + '\n', expected);
});
