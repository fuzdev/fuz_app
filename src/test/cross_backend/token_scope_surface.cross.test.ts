/**
 * Cross-process token-scope **surface** parity for fuz_app's own spine over
 * real HTTP.
 *
 * The `surface:<name>` twin of the conformance slate's `token_scope_cases`,
 * which cover only the `rpc:<method>` arm. Rule 3 — *a narrowed token is
 * RPC-only* — is the load-bearing half of token scoping and had no cross-impl
 * gate at all: the schema gate can't see it (no column), the action-manifest
 * gate can't see it (no method), and the spec-derived suites can't see it
 * (REST routes, off the declared RPC surface).
 *
 * Runs under every `cross_backend_*` project; the surface cases gate on
 * `capabilities.sse` / `capabilities.fact_serving`, both `true` on the TS
 * spines and the Rust `spine_stub`.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '$lib/testing/cross_backend/setup.ts';
import { describe_token_scope_surface_cross_tests } from '$lib/testing/cross_backend/token_scope_surface.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { capabilities } = handle.config;

describe_token_scope_surface_cross_tests({
	setup_test,
	capabilities,
	rpc_path: handle.config.rpc_path,
	sse_path: handle.config.sse_path
});
