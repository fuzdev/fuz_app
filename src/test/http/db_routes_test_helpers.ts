/**
 * The test app the `db_routes` suites mount the route specs on: keeper auth
 * over a daemon-token credential, plus the effect queues and post-commit flush
 * the app server provides.
 *
 * @module
 */

import { Hono } from 'hono';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { apply_route_specs, type RouteSpec } from '#lib/http/route_spec.ts';
import { flush_post_commit_effects } from '#lib/http/pending_effects.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { REQUEST_CONTEXT_KEY, type RequestContext } from '#lib/auth/request_context.ts';
import { create_test_context } from '#lib/testing/entities.ts';
import {
	RESOLVED_AUTH_KEY,
	TEST_CONTEXT_PRESET,
	TEST_CONTEXT_PRESET_KEY
} from '#lib/hono_context.ts';
import { create_test_resolved_auth } from '#lib/testing/resolved_auth.ts';
import type { Db } from '#lib/db/db.ts';

/** The request context the test app authenticates every request as — a keeper. */
export const db_routes_keeper_ctx: RequestContext = create_test_context([{ role: 'keeper' }]);

/**
 * Create a Hono app serving `specs` over `db`, every request authenticated as
 * `db_routes_keeper_ctx` (a daemon-token credential).
 *
 * @param specs - the route specs to mount
 * @param db - the database the routes run on
 * @param log - the logger the routes and the post-commit flush write to
 * @returns the app
 */
export const create_db_routes_test_app = (specs: Array<RouteSpec>, db: Db, log: Logger): Hono => {
	const app = new Hono();
	app.use('/*', async (c, next) => {
		c.set(
			RESOLVED_AUTH_KEY,
			create_test_resolved_auth({
				credential_type: 'daemon_token',
				account_id: db_routes_keeper_ctx.account.id
			})
		);
		c.set(REQUEST_CONTEXT_KEY, db_routes_keeper_ctx);
		c.set(TEST_CONTEXT_PRESET_KEY, TEST_CONTEXT_PRESET);
		// the queues + post-commit flush the app server provides — the DELETE
		// route defers its audit emission via `emit_after_commit`, so a
		// recording emitter observes it only when the flush runs (i.e. only
		// for a committed transaction)
		c.set('pending_effects', []);
		c.set('post_commit_effects', []);
		await next();
		await flush_post_commit_effects(c.var.post_commit_effects, log);
	});
	apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);
	return app;
};
