/**
 * Cross-process cell parity suites for fuz_app's own spine over real HTTP.
 *
 * Companion to `auth.cross.test.ts` (HTTP + RPC), `ws.cross.test.ts` (live
 * WebSocket), and `sse.cross.test.ts` (live SSE): this one drives the cell
 * verbs over real JSON-RPC against the spawned backend — the 5 CRUD verbs via
 * `describe_cell_crud_cross_tests` (gated on `capabilities.cell_crud`) and the
 * relation / ACL / audit verbs via `describe_cell_relations_cross_tests`
 * (gated on `capabilities.cell_relations`). Runs under every `cross_backend_*`
 * project. Cells stay off the standard declared surface; the TS spine binary
 * and the Rust `testing_spine_stub` both live-mount the full surface and
 * declare both flags, so the cases run on all backends (no `.skip`).
 *
 * @module
 */

import {inject} from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.js';
import {describe_cell_crud_cross_tests} from '$lib/testing/cross_backend/cell_crud.js';
import {describe_cell_relations_cross_tests} from '$lib/testing/cross_backend/cell_relations.js';

import './cross_test_types.js';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const {capabilities} = handle.config;
const {rpc_path} = handle.config;

describe_cell_crud_cross_tests({setup_test, capabilities, rpc_path});
describe_cell_relations_cross_tests({setup_test, capabilities, rpc_path});
