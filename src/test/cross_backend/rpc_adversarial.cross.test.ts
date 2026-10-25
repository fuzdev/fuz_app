/**
 * Cross-process malformed-envelope and invalid-params cases for fuz_app's own
 * spine over real HTTP. Sends the in-process attack-surface suite's envelope
 * cases and generated params cases to each spawned backend — the TS spine
 * binaries + the Rust `testing_spine_stub` — as a principal the method admits,
 * so the dispatcher's envelope check and params validation are what refuse.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import { create_spine_surface_spec } from '#lib/testing/cross_backend/default_spine_surface.ts';
import {
	describe_rpc_adversarial_cross_tests,
	type RpcParamsXfail
} from '#lib/testing/cross_backend/rpc_adversarial.ts';
import { RUST_SPINE_STUB_DEFAULT_NAME } from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { rpc_path } = handle.config;

/**
 * The Rust spine answers these `account_token_create` schema refusals with a
 * `data.reason` (`invalid_token_scope` / `invalid_token_lifetime`) the TS spine
 * doesn't send.
 */
const rust_xfail_params: ReadonlyArray<RpcParamsXfail> = [
	{
		method: 'account_token_create',
		labels: ['missing: scope', 'null: scope', 'missing: lifetime', 'null: lifetime'],
		tracking_id: 'rust-token-create-schema-reason',
		reason: 'Rust adds invalid_token_scope / invalid_token_lifetime to schema refusals'
	}
];

describe_rpc_adversarial_cross_tests({
	setup_test,
	surface_source: create_spine_surface_spec(),
	rpc_path,
	...(handle.config.name === RUST_SPINE_STUB_DEFAULT_NAME && { xfail_params: rust_xfail_params })
});
