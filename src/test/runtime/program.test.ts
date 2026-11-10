/**
 * Tests for `Program` (runtime/deps.ts) — that gro's program handle satisfies
 * it, so a gro task root can hand `spawn.find(...)` straight to fuz_app's
 * helpers without fuz_app depending on gro.
 *
 * @module
 */

import { test } from 'vitest';
import type { Spawn, SpawnOutput, SpawnProgram } from '@fuzdev/gro/spawn.ts';

import type { Program, ProgramFactory, ProgramOutput } from '#lib/runtime/deps.ts';

// Type-level assertions — compile error if gro's shapes stop satisfying fuz_app's.

test('a gro SpawnProgram satisfies Program', () => {
	const _check: Program = {} as SpawnProgram;
	const _found: Program | null = {} as SpawnProgram | null;
	_check;
	_found;
});

test('a gro SpawnOutput satisfies ProgramOutput', () => {
	const _check: ProgramOutput = {} as SpawnOutput;
	_check;
});

test("a factory over gro's spawn.find satisfies ProgramFactory", () => {
	const spawn = {} as Spawn;
	const _check: ProgramFactory = (env) => spawn.find('createdb', { pass_env: ['PG*'], env });
	_check;
});
