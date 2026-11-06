/**
 * An all-Zod `RouteSpec` answers byte for byte what it answered before route
 * specs took `@fuzdev/fuz_schema` schemas: its surface (JSON Schema, the
 * route error maps, the non-strict-input warning text) and every exchange of
 * `route_spec_all_zod_helpers.ts` (status, body, `log.error` arguments),
 * captured in `fixtures/surface/route_spec_all_zod.json`.
 *
 * The capture was taken again when errors became definitions, which moved
 * two things and nothing else: each route's 400 is the codes its slots
 * derive, one branch each (it was one enum of the four input codes on every
 * route), and the logged mismatch of the undeclared 404 body carries
 * fuz_schema issues, as the 404 is a definition (it was a Zod schema). Its
 * 404, the middleware's 403, and every other byte are the Zod-era capture's.
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
