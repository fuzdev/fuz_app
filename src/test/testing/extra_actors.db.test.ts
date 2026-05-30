/**
 * Coverage for the `extra_actors` fixture knob (in-process leg).
 *
 * `extra_actors` seeds additional actors on the bootstrapped keeper so the
 * multi-actor `acting`-selector branches (`actor_required` + `available[]`)
 * are reachable from tests — account creation otherwise only ever mints one
 * actor, and no production wire path adds a second. The cross-process leg
 * drives the same knob through `_testing_reset`'s `extra_actors` input.
 *
 * @module
 */

import {test, describe, assert} from 'vitest';

import {default_in_process_setup} from '$lib/testing/cross_backend/setup.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {create_standard_rpc_actions} from '$lib/auth/standard_rpc_actions.js';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.js';
import {ROLE_ADMIN, ROLE_KEEPER} from '$lib/auth/role_schema.js';
import type {AppServerContext} from '$lib/server/app_server_context.js';
import type {RouteSpec} from '$lib/http/route_spec.js';

const session_options = create_session_config('test_extra_actors');
const RPC_PATH = '/api/rpc';

const make_setup = (extra_actors: Array<string>) =>
	default_in_process_setup({
		session_options,
		roles: [ROLE_KEEPER, ROLE_ADMIN],
		create_route_specs: (ctx: AppServerContext): Array<RouteSpec> =>
			create_rpc_endpoint({
				path: RPC_PATH,
				actions: create_standard_rpc_actions(ctx.deps),
				log: ctx.deps.log,
			}),
		extra_actors,
	});

describe('extra_actors fixture knob', () => {
	test('seeds the declared keeper actors, distinct from the bootstrap actor', async () => {
		const fixture = await make_setup(['second_actor', 'third_actor'])();
		assert.deepStrictEqual(
			fixture.extra_actors.map((a) => a.name),
			['second_actor', 'third_actor'],
		);
		// The keeper now holds 3 distinct actors (1 bootstrap + 2 seeded) — the
		// state the `actor_required` branch needs.
		const ids = new Set([fixture.actor.id, ...fixture.extra_actors.map((a) => a.id)]);
		assert.strictEqual(ids.size, 3, 'keeper should have 3 distinct actor ids');
	});

	test('defaults to empty (single-actor keeper) when undeclared', async () => {
		const fixture = await make_setup([])();
		assert.strictEqual(fixture.extra_actors.length, 0);
	});
});
