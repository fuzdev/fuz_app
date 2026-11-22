/**
 * The transcript differential, TS spine (Node) against the Rust
 * `testing_spine_stub`, both on Postgres under the dual-spawn
 * `cross_backend_parity` project (`cross_backend_projects.ts`), where the
 * test process reads both databases, so each test's database state is
 * compared too (`compare_db_state`).
 * `FUZ_TEST_TRANSCRIPT_DUMP_DIR` names a directory the run's transcripts and
 * counts are written to (`transcript_differential.ts`).
 *
 * @module
 */

import { inject_parity_handles } from '#lib/testing/cross_backend/provided_context.ts';

import {
	describe_transcript_differential,
	TRANSCRIPT_DUMP_DIR_ENV
} from './transcript_differential.ts';
import { transcript_known_divergences } from './transcript_known_divergences.ts';

const parity = inject_parity_handles();

describe_transcript_differential({
	sides: [
		{ name: 'ts', handle: parity.a },
		{ name: 'rust', handle: parity.b }
	],
	ledger: transcript_known_divergences,
	compare_db_state: true,
	dump_dir: process.env[TRANSCRIPT_DUMP_DIR_ENV]
});
