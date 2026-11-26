/**
 * With no RPC endpoints, `describe_rpc_attack_surface_tests` registers one
 * skipped test naming the reason, rather than nothing.
 *
 * @module
 */

import { test, assert } from 'vitest';

import { describe_rpc_attack_surface_tests } from '#lib/testing/rpc_attack_surface.ts';
import { create_app_surface_spec } from '#lib/http/surface.ts';

import { probe_registration, registered_test_names } from './collection_test_helpers.ts';

const LABEL = 'no rpc endpoints';

const outcome = probe_registration(LABEL, () =>
	describe_rpc_attack_surface_tests({
		build: () => create_app_surface_spec({ route_specs: [], middleware_specs: [] }),
		roles: []
	})
);

test('registers one skipped test naming the reason', ({ task }) => {
	assert.isNull(outcome.error);
	assert.deepEqual(registered_test_names(task.file, LABEL), [
		'RPC attack surface (no RPC endpoints declared)'
	]);
});
