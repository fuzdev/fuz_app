/**
 * Production-mode coverage for the bearer-auth browser-context discard
 * diagnostic header.
 *
 * `bearer_auth.ts` adds `X-Fuz-Auth-Debug: bearer_discarded_browser_context`
 * only under `DEV` — production must never emit it, since it would leak that a
 * token was dropped and defeat the anti-enumeration silence (a stolen-token
 * probe is meant to get an indistinguishable 401). Vitest runs with `DEV=true`,
 * and the standard `$lib/testing` harness can't load under `DEV=false` (its
 * `assert_dev_env` guard throws at import), so this builds a minimal inline
 * Hono app around `create_bearer_auth_middleware` imported fresh under a scoped
 * `esm-env` mock, then asserts the header is absent on the discard path.
 * Sibling of the DEV-mode assertion in `bearer_auth_middleware.test.ts`.
 *
 * @module
 */

import {test, assert, afterEach, vi} from 'vitest';
import type {Logger} from '@fuzdev/fuz_util/log.js';

import type {QueryDeps} from '$lib/db/query_deps.js';

afterEach(() => {
	vi.doUnmock('esm-env');
	vi.resetModules();
});

test('bearer browser-context discard omits the debug header in production (DEV=false)', async () => {
	vi.resetModules();
	vi.doMock('esm-env', () => ({DEV: false}));
	const {Hono} = await import('hono');
	const {create_bearer_auth_middleware} = await import('$lib/auth/bearer_auth.js');

	// The discard path runs before any DB or rate-limiter work, so stub deps suffice.
	const log = {debug() {}} as unknown as Logger;
	const app = new Hono();
	app.use('/api/*', create_bearer_auth_middleware({} as QueryDeps, null, log));
	app.get('/api/test', (c) => c.text('ok'));

	// Authorization + Origin → browser-context discard branch.
	const res = await app.request('/api/test', {
		headers: {Authorization: 'Bearer secret_fuz_token_test', Origin: 'https://x.example'},
	});
	assert.strictEqual(res.status, 200);
	assert.strictEqual(res.headers.get('X-Fuz-Auth-Debug'), null);
});
