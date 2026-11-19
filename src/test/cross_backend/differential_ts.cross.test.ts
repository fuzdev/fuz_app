/**
 * Cross-runtime differential gate for fuz_app's TS spine, Node against Bun.
 *
 * The same suites as `differential.cross.test.ts`
 * (`describe_spine_differential_suites`), with the TS spine binary on Node as
 * one side and on Bun as the other: one implementation, two runtimes, so any
 * difference in an answer is the runtime's — its HTTP server, its WebSocket
 * upgrade, its `Request` / `Response` — never the spine's logic.
 *
 * Beside them it compares the rows only the TS spine answers
 * (`conformance_verify_cases.ts`, `GET /verify`), which the shared
 * composition leaves out because the TS-vs-Rust gate runs it too.
 *
 * The ledger is empty. The TS-vs-Rust ledger's rows are all TS-against-Rust
 * differences, and its DEV-only rows (the `issues` on `invalid_params`, the
 * `X-Fuz-Auth-Debug` header) show on both sides here, since both binaries run
 * the one spine under `DEV` — a ledger row naming them would fail as an entry
 * that no longer differs.
 *
 * Runs under the dual-spawn `cross_backend_ts_differential` project
 * (`ts_differential_handle_a` = Node, `ts_differential_handle_b` = Bun), both
 * on `memory://`, so it needs no Postgres and runs in the `cross-ts` CI job.
 *
 * @module
 */

import { inject } from 'vitest';

import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import { describe_differential_conformance_tests } from '#lib/testing/cross_backend/differential.ts';
import {
	create_spine_surface_spec,
	spine_rpc_endpoints,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';

import { conformance_verify_cases } from './conformance_verify_cases.ts';
import { describe_spine_differential_suites } from './spine_differential.ts';
import './cross_test_types.ts';

const node = reconstruct_bootstrapped_handle(inject('ts_differential_handle_a'));
const bun = reconstruct_bootstrapped_handle(inject('ts_differential_handle_b'));

describe_spine_differential_suites({
	backends: [
		{ name: 'node', handle: node },
		{ name: 'bun', handle: bun }
	]
});

// the TS spine's own rows (`GET /verify`, which the Rust spine doesn't mount),
// so they sit outside the composition the TS-vs-Rust gate shares
const keeper_setup = { extra_keeper_roles: [ROLE_ADMIN] };
describe_differential_conformance_tests({
	cases: conformance_verify_cases,
	backends: [
		{ name: 'node', setup_test: default_cross_process_setup(node, keeper_setup) },
		{ name: 'bun', setup_test: default_cross_process_setup(bun, keeper_setup) }
	],
	surface_source: create_spine_surface_spec(),
	rpc_endpoints: spine_rpc_endpoints,
	session_options: spine_session_options,
	suite_name: 'differential conformance, TS spine only (node vs bun)'
});
