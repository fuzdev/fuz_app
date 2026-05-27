/**
 * In-process leg of the cell-CRUD parity suite.
 *
 * Runs `describe_cell_crud_cross_tests` against the in-process Hono app (no
 * process boundary), so the cell wire contract + authz matrix are verified
 * under a plain `gro test` — the cross-process legs (`cell.cross.test.ts`)
 * additionally drive the TS spine binary + Rust `testing_spine_stub` over real
 * HTTP behind `FUZ_TEST_CROSS_BACKEND=1`.
 *
 * The shared `create_cell_parity_setup` mounts the full cell RPC surface on
 * the spine path (matching the binary + Rust stub) and provisions a per-test
 * db carrying the `fuz_cell` namespace. The relation / ACL / audit verbs are
 * exercised by the sibling `cell_relations_parity.db.test.ts`.
 *
 * @module
 */

import {in_process_capabilities} from '$lib/testing/cross_backend/capabilities.js';
import {describe_cell_crud_cross_tests} from '$lib/testing/cross_backend/cell_crud.js';

import {create_cell_parity_setup} from './cell_parity_helpers.js';

describe_cell_crud_cross_tests({
	setup_test: create_cell_parity_setup(),
	capabilities: in_process_capabilities,
});
