/**
 * `npm run test:cross` — every `cross_backend_*` project at once, behind one
 * summary.
 *
 * vitest runs the projects of one invocation one after another (see the
 * comment in `vite.config.ts`), so this runs each project in a `vitest`
 * invocation of its own, all concurrently — which the projects' disjoint
 * ports, databases and temp directories allow (`cross_backend_projects.ts`).
 * The Rust stub is rebuilt once first (`rebuild_rust_spine_stub`, skipped by
 * `FUZ_TESTING_NO_REBUILD=1` as usual), and every invocation is handed
 * `FUZ_TESTING_NO_REBUILD=1` and the binary path, so no two builds race on
 * Cargo's lock.
 *
 * Each invocation's output is held and printed whole when it finishes, with
 * one line naming the projects still running; an invocation still running
 * after `CHILD_TIMEOUT_MS` is stopped and reported as timed out. A summary
 * then lists every project's counts and failed tests. Exits nonzero when any
 * invocation fails.
 *
 * Runs on plain Node (type stripping, with the `development` condition the
 * testing modules assert), not under `gro run`: gro forwards no signals, so a
 * signal to a gro layer would orphan this process and its invocations. A
 * `SIGINT`, `SIGTERM` or `SIGHUP` here is passed to every invocation, whose
 * backends' own handlers tear them down, and the runner also stops them when
 * its parent goes away (npm's `sh -c` layer dies on `SIGTERM` without passing
 * it on). On Ctrl+C, npm returns the prompt before the runner prints its
 * summary, which lands after it.
 *
 * The timeout's `SIGKILL` reaches only the vitest process: its backends run in
 * process groups of their own, so a vitest that ignored `SIGTERM` would leave
 * them running. That takes a wedged event loop, since a live one runs the
 * `SIGTERM` teardown.
 *
 * Run: `node --conditions=development src/test/cross_backend/run_cross.ts`
 * (or `npm run test:cross`).
 *
 * @module
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { NO_REBUILD_ENV } from '#lib/testing/cross_backend/cargo_binary.ts';

import { CROSS_BACKEND_ENV, CROSS_BACKEND_PROJECTS } from './cross_backend_projects.ts';
import { rebuild_rust_spine_stub, RUST_SPINE_STUB_CRATE } from './global_setup_helpers.ts';

/**
 * How long one project's invocation may run (ms) before it is stopped and
 * reported as timed out — well past the slowest project's half minute, so
 * only a hang reaches it.
 */
const CHILD_TIMEOUT_MS = 10 * 60_000;

/**
 * How long a stopped invocation gets after `SIGTERM` (ms) before `SIGKILL` —
 * room for vitest to run its global teardowns, which stop the backends.
 */
const CHILD_KILL_GRACE_MS = 15_000;

/** How often the runner checks that its parent is still there (ms). */
const PARENT_POLL_INTERVAL_MS = 1_000;

/** What one project's invocation ended with. */
interface ProjectRun {
	readonly name: string;
	readonly outcome: 'passed' | 'failed' | 'timed out' | 'interrupted';
	/** `exit N`, `signal SIG`, or a spawn failure. */
	readonly exit: string;
	readonly duration_ms: number;
	readonly report: VitestJsonReport | null;
}

/** The fields read from vitest's `json` reporter output. */
interface VitestJsonReport {
	readonly numTotalTests: number;
	readonly numPassedTests: number;
	readonly numFailedTests: number;
	readonly numPendingTests: number;
	readonly numTodoTests: number;
	readonly testResults: ReadonlyArray<{
		readonly name: string;
		readonly message?: string;
		readonly assertionResults: ReadonlyArray<{
			readonly fullName: string;
			readonly status: string;
		}>;
	}>;
}

const vitest_bin = join(
	dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
	'vitest.mjs'
);

const live_children: Map<ChildProcess, string> = new Map();

/** Set once a signal (or the parent's exit) stops the run. */
let interrupted = false;

const format_seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

const run_project = (
	name: string,
	report_path: string,
	env: NodeJS.ProcessEnv
): Promise<ProjectRun> =>
	new Promise((resolve) => {
		const started_at = performance.now();
		const child = spawn(
			process.execPath,
			[
				vitest_bin,
				'run',
				'--project',
				name,
				'--reporter=default',
				'--reporter=json',
				`--outputFile.json=${report_path}`
			],
			{ env, stdio: ['ignore', 'pipe', 'pipe'] }
		);
		live_children.set(child, name);
		const output: Array<Buffer> = [];
		child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => output.push(chunk));

		let timed_out = false;
		let kill_timer: NodeJS.Timeout | undefined;
		const timeout_timer = setTimeout(() => {
			timed_out = true;
			child.kill('SIGTERM');
			kill_timer = setTimeout(() => child.kill('SIGKILL'), CHILD_KILL_GRACE_MS);
		}, CHILD_TIMEOUT_MS);

		let finished = false;
		const finish = async (exit: string, exited_ok: boolean): Promise<void> => {
			// `'error'` and `'close'` can both fire for one child
			if (finished) return;
			finished = true;
			clearTimeout(timeout_timer);
			clearTimeout(kill_timer);
			live_children.delete(child);
			const duration_ms = performance.now() - started_at;
			let report: VitestJsonReport | null = null;
			try {
				report = JSON.parse(await readFile(report_path, 'utf-8')) as VitestJsonReport;
			} catch {
				// no report — the invocation failed or was stopped before its reporter wrote one
			}
			const outcome: ProjectRun['outcome'] = timed_out
				? 'timed out'
				: exited_ok
					? 'passed'
					: interrupted
						? 'interrupted'
						: 'failed';
			console.log(`\n── ${name} (${exit}, ${format_seconds(duration_ms)}) ──`);
			process.stdout.write(Buffer.concat(output));
			const still_running = [...live_children.values()];
			console.log(
				`done ${name} (${outcome}, ${format_seconds(duration_ms)}) — ` +
					(still_running.length ? `still running: ${still_running.join(', ')}` : 'none left')
			);
			resolve({ name, outcome, exit, duration_ms, report });
		};
		child.once('error', (error) => void finish(`failed to spawn: ${error.message}`, false));
		child.once(
			'close',
			(code, signal) => void finish(signal ? `signal ${signal}` : `exit ${code}`, code === 0)
		);
	});

const format_counts = (report: VitestJsonReport | null): string => {
	if (!report) return 'no report';
	const skipped = report.numPendingTests + report.numTodoTests;
	return (
		`${report.numPassedTests} passed` +
		(report.numFailedTests ? `, ${report.numFailedTests} failed` : '') +
		(skipped ? `, ${skipped} skipped` : '') +
		` (${report.numTotalTests})`
	);
};

/** The failed tests and failed files without tests (an import or hook error), paths cwd-relative. */
const list_failures = (report: VitestJsonReport | null): Array<string> => {
	if (!report) return [];
	const failures: Array<string> = [];
	for (const file of report.testResults) {
		const path = relative(process.cwd(), file.name);
		const failed = file.assertionResults.filter((a) => a.status === 'failed');
		for (const assertion of failed) failures.push(`${path} > ${assertion.fullName}`);
		if (failed.length === 0 && file.message) {
			failures.push(`${path}: ${file.message.split('\n')[0]}`);
		}
	}
	return failures;
};

/** Stop every invocation; each passes the signal on to its backends' teardown. */
const stop_children = (signal: NodeJS.Signals): void => {
	interrupted = true;
	for (const child of live_children.keys()) child.kill(signal);
};
process.once('SIGINT', () => stop_children('SIGINT'));
process.once('SIGTERM', () => stop_children('SIGTERM'));
process.once('SIGHUP', () => stop_children('SIGHUP'));

// a parent that dies without signalling (a `SIGKILL`, a wrapper that forwards
// nothing) reparents this process — stop the run rather than leave it orphaned
const parent_pid = process.ppid;
const parent_poll = setInterval(() => {
	if (process.ppid !== parent_pid && !interrupted) {
		console.error(`run_cross: parent ${parent_pid} is gone, stopping the run`);
		stop_children('SIGTERM');
	}
}, PARENT_POLL_INTERVAL_MS);
parent_poll.unref();

const started_at = performance.now();

// one build for every Rust-backed project; it also defaults the binary path
// in this process's env, which every invocation inherits
rebuild_rust_spine_stub({ crate: RUST_SPINE_STUB_CRATE });
const env: NodeJS.ProcessEnv = {
	...process.env,
	[CROSS_BACKEND_ENV]: '1',
	[NO_REBUILD_ENV]: '1'
};

const names = CROSS_BACKEND_PROJECTS.map((project) => project.name);
console.log(`running ${names.length} cross projects concurrently: ${names.join(', ')}`);

const report_dir = await mkdtemp(join(tmpdir(), 'fuz_app_cross_'));
let runs: Array<ProjectRun>;
try {
	runs = await Promise.all(
		names.map((name) => run_project(name, join(report_dir, `${name}.json`), env))
	);
} finally {
	await rm(report_dir, { recursive: true, force: true });
}

const width = Math.max(...names.map((name) => name.length));
console.log('\n── test:cross summary ──');
for (const run of runs) {
	const ok = run.outcome === 'passed';
	console.log(
		`${ok ? 'pass' : 'FAIL'}  ${run.name.padEnd(width)}  ${format_seconds(run.duration_ms).padStart(6)}  ${format_counts(run.report)}` +
			(ok ? '' : `  [${run.outcome}: ${run.exit}]`)
	);
	const failures = list_failures(run.report);
	for (const failure of failures) console.log(`        ${failure}`);
	if (!ok && failures.length === 0) {
		const note =
			run.outcome === 'timed out'
				? `timed out after ${format_seconds(CHILD_TIMEOUT_MS)}`
				: run.outcome === 'interrupted' || run.exit.startsWith('signal')
					? 'interrupted'
					: 'no failed test reported — see its output above';
		console.log(`        ${note}`);
	}
}
const failed = runs.filter((run) => run.outcome !== 'passed');
console.log(
	`${failed.length === 0 ? 'all passed' : `${failed.length} of ${runs.length} failed`} in ${format_seconds(performance.now() - started_at)}`
);
if (failed.length > 0 || interrupted) process.exitCode = 1;
