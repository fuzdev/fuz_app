import {test} from 'vitest';

import type {
	RuntimeDeps,
	EnvDeps,
	FsReadDeps,
	FsWriteDeps,
	FsRemoveDeps,
	CommandDeps,
	TerminalDeps,
	ProcessDeps,
} from '$lib/runtime/deps.js';

// Type-level assertions — compile error if RuntimeDeps doesn't satisfy *Deps.
// These tests exist for structural verification; create_deno_runtime itself
// requires Deno APIs and can't run in vitest's Node environment.

test('RuntimeDeps satisfies EnvDeps', () => {
	const _check: EnvDeps = {} as RuntimeDeps;
	void _check;
});

test('RuntimeDeps satisfies FsReadDeps', () => {
	const _check: FsReadDeps = {} as RuntimeDeps;
	void _check;
});

test('RuntimeDeps satisfies FsWriteDeps', () => {
	const _check: FsWriteDeps = {} as RuntimeDeps;
	void _check;
});

test('RuntimeDeps satisfies FsRemoveDeps', () => {
	const _check: FsRemoveDeps = {} as RuntimeDeps;
	void _check;
});

test('RuntimeDeps satisfies CommandDeps', () => {
	const _check: CommandDeps = {} as RuntimeDeps;
	void _check;
});

test('RuntimeDeps satisfies TerminalDeps', () => {
	const _check: TerminalDeps = {} as RuntimeDeps;
	void _check;
});

test('RuntimeDeps satisfies ProcessDeps', () => {
	const _check: ProcessDeps = {} as RuntimeDeps;
	void _check;
});
