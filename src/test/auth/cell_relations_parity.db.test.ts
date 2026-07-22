/**
 * In-process leg of the cell relation / ACL / audit parity suite.
 *
 * Runs `describe_cell_relations_cross_tests` against the in-process Hono app
 * under a plain `gro test` — grant lifecycle, field / item bidirectional
 * relations, clone shallow + deep, the manage-tier audit gate, and the
 * editor-grant `cell_visibility_manage_only` 403. The cross-process legs
 * (`cell.cross.test.ts`) additionally drive the TS spine binary + Rust
 * `testing_spine_stub` over real HTTP behind `FUZ_TEST_CROSS_BACKEND=1`.
 *
 * Shares the full-surface `create_cell_parity_setup` with the CRUD leg.
 *
 * @module
 */

import { in_process_capabilities } from '$lib/testing/cross_backend/capabilities.ts';
import { describe_cell_relations_cross_tests } from '$lib/testing/cross_backend/cell_relations.ts';

import { create_cell_parity_setup } from './cell_parity_helpers.ts';

describe_cell_relations_cross_tests({
	setup_test: create_cell_parity_setup(),
	capabilities: in_process_capabilities
});
