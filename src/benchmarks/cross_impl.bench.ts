/**
 * Cross-impl latency benchmark for fuz_app's own spine — TS (Node + Bun),
 * plus the Rust `testing_spine_stub` when its prebuilt binary is
 * available. Spawns each backend, runs identical RPC round-trip scenarios
 * over real HTTP, prints a per-scenario markdown table + a significance
 * verdict vs the Node TS reference, and writes a JSON artifact.
 *
 * Out-of-process for every impl by construction (that's the whole point of a
 * cross-impl bench); the correctness suites keep the fast in-process path.
 *
 * Run: `gro run src/benchmarks/cross_impl.bench.ts` (or `npm run benchmark:cross-impl`).
 *
 * **DB-layer caveat.** The TS binaries run in-process pglet (`memory://`)
 * while the Rust spine runs over the wire, on a `pglet_server` of its own —
 * or a PostgreSQL database of its own under `FUZ_TEST_POSTGRES_URL`
 * (`open_test_database`) — so the TS-vs-Rust columns are NOT apples-to-apples
 * at the DB layer; the TS-node-vs-TS-bun comparison is (same driver). The
 * Rust column only appears when `FUZ_TESTING_RUST_SPINE_STUB_BIN` is set; its
 * `pglet_server` is `PGLET_SERVER_BIN`, else built in the stub's Cargo
 * workspace. TS-only is the zero-infra default.
 *
 * @module
 */

import { writeFileSync } from 'node:fs';

import {
	compare_cross_impl,
	format_cross_impl_comparison,
	format_cross_impl_json,
	format_cross_impl_markdown
} from '../lib/testing/cross_backend/bench/bench_report.ts';
import { run_cross_impl_bench } from '../lib/testing/cross_backend/bench/run_cross_impl_bench.ts';
import { default_bench_scenarios } from '../lib/testing/cross_backend/bench/scenario.ts';
import type { BackendConfig } from '../lib/testing/cross_backend/backend_config.ts';
import { bootstrap_backend } from '../lib/testing/cross_backend/bootstrap_backend.ts';
import type { BootstrappedBackendHandle } from '../lib/testing/cross_backend/setup.ts';
import {
	open_test_database,
	prepare_pglet_server_binary,
	type TestDatabase
} from '../lib/testing/cross_backend/test_database.ts';
import { FUZ_TEST_POSTGRES_URL_ENV } from '../lib/testing/db.ts';
import { to_rust_spine_pglet_server } from '../test/cross_backend/global_setup_helpers.ts';
import {
	RUST_SPINE_STUB_BIN_ENV,
	rust_spine_stub_backend_config
} from '../lib/testing/cross_backend/rust_spine_stub_backend_config.ts';
import {
	ts_spine_bun_backend_config,
	ts_spine_node_backend_config
} from '../lib/testing/cross_backend/ts_spine_backend_config.ts';

const ARTIFACT_PATH = 'src/benchmarks/cross_impl.latest.json';
const REFERENCE_BACKEND = 'ts_spine_node';

const configs: Array<BackendConfig> = [
	ts_spine_node_backend_config(),
	ts_spine_bun_backend_config()
];

// Include the Rust spine only when its prebuilt binary is available — keeps
// the TS-only run zero-infra.
let stub_database: TestDatabase | null = null;
if (process.env[RUST_SPINE_STUB_BIN_ENV]) {
	stub_database = await open_test_database({
		name: 'spine_stub_bench',
		postgres_url: process.env[FUZ_TEST_POSTGRES_URL_ENV],
		pglet_server_bin: () => prepare_pglet_server_binary(to_rust_spine_pglet_server())
	});
	configs.push(rust_spine_stub_backend_config({ database_url: stub_database.url }));
	console.log(
		`including Rust spine_stub (${RUST_SPINE_STUB_BIN_ENV} set, ${stub_database.engine})`
	);
} else {
	console.log(`skipping Rust spine_stub (${RUST_SPINE_STUB_BIN_ENV} unset) — TS-only run`);
}

const handles: Array<BootstrappedBackendHandle> = [];
try {
	// Spawn + bootstrap sequentially — parallel spawns would contend during boot.
	for (const config of configs) {
		handles.push(await bootstrap_backend(config));
	}

	const result = await run_cross_impl_bench({ handles, scenarios: default_bench_scenarios });

	console.log(`\n${format_cross_impl_markdown(result)}\n`);
	console.log(
		format_cross_impl_comparison(compare_cross_impl(result, { reference: REFERENCE_BACKEND }))
	);

	writeFileSync(ARTIFACT_PATH, `${format_cross_impl_json(result)}\n`);
	console.log(`\nwrote ${ARTIFACT_PATH}`);
} finally {
	const torn_down = await Promise.allSettled(handles.map((h) => h.teardown()));
	// a backend that exits uncleanly is reported, not hidden behind the results
	for (const settled of torn_down) {
		if (settled.status === 'rejected') console.error(settled.reason);
	}
	await stub_database?.close();
}
