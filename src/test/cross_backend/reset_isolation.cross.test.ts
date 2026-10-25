/**
 * Cross-process reset isolation for fuz_app's own spine: the per-test
 * `_testing_reset` empties the cell and fact tables, not just the auth ones,
 * so a test never sees another test's cells or facts.
 *
 * Two sequential tests in one `describe` (vitest runs a file's tests in
 * order): the first creates a cell and puts a fact, the second asserts the
 * keeper — a global admin, who sees every cell and may read any fact by its
 * bare hash — finds neither. Runs under every `cross_backend_*` project.
 *
 * @module
 */

import { describe, assert, inject } from 'vitest';

import { CellCreateOutput, CellListOutput } from '#lib/auth/cell_action_specs.ts';
import { test_if } from '#lib/testing/cross_backend/capabilities.ts';
import { cross_rpc_call, expect_output } from '#lib/testing/cross_backend/cell_cross_helpers.ts';
import { cross_put_fact } from '#lib/testing/cross_backend/fact_serving.ts';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { capabilities, rpc_path } = handle.config;

// the reset-isolation pair's own content, so no other suite's fact shares its hash
const FACT_CONTENT = 'reset-isolation-probe';

describe('_testing_reset isolation', () => {
	const cond = capabilities.cell_crud && capabilities.fact_serving;
	let cell_id: string | null = null;
	let fact_hash: string | null = null;

	test_if(cond, 'a test creates a cell and puts a fact', async () => {
		const fixture = await setup_test();
		const t = fixture.fresh_transport();
		const created = expect_output(
			await cross_rpc_call(
				t,
				rpc_path,
				'cell_create',
				{ kind: 'note', data: { probe: 'reset-isolation' } },
				fixture.create_session_headers()
			),
			CellCreateOutput
		);
		cell_id = created.cell.id;
		fact_hash = await cross_put_fact(fixture, rpc_path, { content: FACT_CONTENT });

		const res = await t(`/api/facts/${fact_hash}`, {
			method: 'GET',
			headers: fixture.create_session_headers()
		});
		assert.strictEqual(res.status, 200, 'the fact the test put should serve');
	});

	test_if(cond, 'the next test sees neither', async () => {
		assert.ok(cell_id && fact_hash, 'the first test did not run');
		const fixture = await setup_test();
		const t = fixture.fresh_transport();
		const headers = fixture.create_session_headers();

		const res = await t(`/api/facts/${fact_hash}`, { method: 'GET', headers });
		assert.strictEqual(res.status, 404, "the previous test's fact still serves");

		const listed = expect_output(
			await cross_rpc_call(t, rpc_path, 'cell_list', {}, headers),
			CellListOutput
		);
		assert.ok(
			!listed.cells.some((c) => c.id === cell_id),
			"cell_list returned the previous test's cell"
		);
		assert.strictEqual(listed.cells.length, 0, 'cell_list should be empty after a reset');
	});
});
