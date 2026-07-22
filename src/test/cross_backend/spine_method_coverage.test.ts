import { describe, test } from 'vitest';

import { create_stub_app_deps } from '$lib/testing/stubs.ts';
import { build_full_spine_rpc_actions } from '$lib/testing/cross_backend/full_spine_mount.ts';
import { create_spine_surface_spec } from '$lib/testing/cross_backend/default_spine_surface.ts';
import { assert_rpc_method_coverage } from '$lib/testing/cross_backend/method_coverage.ts';
import type { DaemonTokenState } from '$lib/auth/daemon_token.ts';

import { SPINE_METHOD_COVERAGE } from './spine_method_coverage.ts';

/**
 * Construction-only deps — `build_full_spine_rpc_actions` builds action specs
 * + handler closures but never runs a handler, so a no-op stub suffices and no
 * DB is needed (plain `.test.ts`, not `.db.test.ts`).
 */
const stub_daemon_token_state: DaemonTokenState = {
	current_token: 'stub_token',
	previous_token: null,
	rotated_at: new Date(0),
	keeper_account_id: null
};

describe('spine method coverage', () => {
	test('the live RPC mount reconciles with the coverage manifest', () => {
		const live_methods = build_full_spine_rpc_actions(create_stub_app_deps(), {
			daemon_token_state: stub_daemon_token_state,
			notification_sender: null
		}).map((action) => action.spec.method);

		const declared_methods = create_spine_surface_spec().surface.rpc_endpoints.flatMap((endpoint) =>
			endpoint.methods.map((method) => method.name)
		);

		assert_rpc_method_coverage({ live_methods, declared_methods, manifest: SPINE_METHOD_COVERAGE });
	});
});
