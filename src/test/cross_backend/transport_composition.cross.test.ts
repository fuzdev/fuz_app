/**
 * Cross-process front-door contract for fuz_app's own spine over real HTTP:
 * the per-transport composition table (`describe_transport_composition_cross_tests`)
 * against each spawned backend — the TS spine binaries and the Rust
 * `testing_spine_stub`. The WebSocket and SSE rows gate on
 * `capabilities.ws` / `capabilities.sse`, both `true` on every spine backend.
 *
 * The multi-actor upgrade row runs on a keeper seeded with a second actor. The
 * Rust stub's upgrade resolves an account and no actor, so it admits the
 * socket the TS spine refuses `actor_required`; there the row is an
 * `xfail_until`.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import { describe_transport_composition_cross_tests } from '#lib/testing/cross_backend/transport_composition.ts';
import { RUST_SPINE_STUB_DEFAULT_NAME } from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { capabilities, rpc_path, base_url, ws_path, sse_path } = handle.config;

describe_transport_composition_cross_tests({
	setup_test,
	capabilities,
	rpc_path,
	base_url,
	ws_path,
	sse_path,
	multi_actor: {
		setup_test: default_cross_process_setup(handle, { extra_actors: ['keeper_second_persona'] }),
		...(handle.config.name === RUST_SPINE_STUB_DEFAULT_NAME && {
			xfail: {
				tracking_id: 'rust-ws-upgrade-acting-fail-open',
				reason:
					'the Rust upgrade resolves an account, not an actor, so it admits a multi-actor ' +
					'upgrade that names no actor; per-frame dispatch still resolves each frame'
			}
		})
	}
});
