import { test } from 'vitest';

import type {
	RuntimeDeps,
	EnvDeps,
	FetchDeps,
	FsReadDeps,
	FsWriteDeps,
	FsRemoveDeps,
	ProcessProbeDeps,
	LogDeps,
	TerminalDeps,
	ProcessDeps
} from '#lib/runtime/deps.ts';

// Type-level assertions — compile error if RuntimeDeps doesn't satisfy *Deps.

test('RuntimeDeps satisfies EnvDeps', () => {
	const _check: EnvDeps = {} as RuntimeDeps;
	_check;
});

test('RuntimeDeps satisfies FsReadDeps', () => {
	const _check: FsReadDeps = {} as RuntimeDeps;
	_check;
});

test('RuntimeDeps satisfies FsWriteDeps', () => {
	const _check: FsWriteDeps = {} as RuntimeDeps;
	_check;
});

test('RuntimeDeps satisfies FsRemoveDeps', () => {
	const _check: FsRemoveDeps = {} as RuntimeDeps;
	_check;
});

test('RuntimeDeps satisfies ProcessProbeDeps', () => {
	const _check: ProcessProbeDeps = {} as RuntimeDeps;
	_check;
});

test('RuntimeDeps satisfies TerminalDeps', () => {
	const _check: TerminalDeps = {} as RuntimeDeps;
	_check;
});

test('RuntimeDeps satisfies ProcessDeps', () => {
	const _check: ProcessDeps = {} as RuntimeDeps;
	_check;
});

test('RuntimeDeps satisfies FetchDeps', () => {
	const _check: FetchDeps = {} as RuntimeDeps;
	_check;
});

test('RuntimeDeps satisfies LogDeps', () => {
	const _check: LogDeps = {} as RuntimeDeps;
	_check;
});
