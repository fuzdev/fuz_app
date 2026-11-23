/**
 * Tests for `cross_backend_projects.ts` — the cross projects run at once, so
 * every port, Postgres database and temp directory `CROSS_PROJECT_RESOURCES`
 * claims must be claimed once (and the `db_postgres` step's database by
 * none), and the table must cover exactly the projects
 * `CROSS_BACKEND_PROJECTS` defines. The one exception: the backends of a
 * project `SHARED_DATABASE_PROJECTS` names may share a database among
 * themselves, never with another project.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { default_test_backend_prefix } from '#lib/testing/cross_backend/build_test_backend_paths.ts';
import {
	RUST_SPINE_STUB_DEFAULT_DATABASE_URL,
	RUST_SPINE_STUB_DEFAULT_NAME,
	RUST_SPINE_STUB_DEFAULT_PORT
} from '#lib/testing/cross_backend/rust_spine_stub_backend_config.ts';

import {
	CROSS_BACKEND_PROJECTS,
	CROSS_DB_POSTGRES_DATABASE,
	CROSS_PROJECT_RESOURCES,
	SHARED_DATABASE_PROJECTS,
	type CrossBackendResources,
	type CrossProjectName
} from './cross_backend_projects.ts';

/** Every backend in the table, labelled `project.role`, with its project. */
const backends: ReadonlyArray<[string, CrossBackendResources, CrossProjectName]> = Object.entries(
	CROSS_PROJECT_RESOURCES
).flatMap(([project, roles]) =>
	Object.entries(roles as Record<string, CrossBackendResources>).map(
		([role, resources]): [string, CrossBackendResources, CrossProjectName] => [
			`${project}.${role}`,
			resources,
			project as CrossProjectName
		]
	)
);

/**
 * The labels claiming each value more than once. With `shared_within`, a
 * value claimed only by the backends of one project the set names counts
 * once.
 */
const find_duplicates = (
	claim: (resources: CrossBackendResources) => string | number | null,
	shared_within?: ReadonlySet<CrossProjectName>
): Array<string> => {
	const claimed: Map<string | number, Array<[string, CrossProjectName]>> = new Map();
	for (const [label, resources, project] of backends) {
		const value = claim(resources);
		if (value === null) continue;
		const claims = claimed.get(value) ?? [];
		claims.push([label, project]);
		claimed.set(value, claims);
	}
	const is_shared_within_one = (claims: Array<[string, CrossProjectName]>): boolean => {
		const projects = new Set(claims.map(([, project]) => project));
		const [project] = projects;
		return projects.size === 1 && project !== undefined && !!shared_within?.has(project);
	};
	return [...claimed]
		.filter(([, claims]) => claims.length > 1 && !is_shared_within_one(claims))
		.map(([value, claims]) => `${value}: ${claims.map(([label]) => label).join(', ')}`);
};

describe('CROSS_PROJECT_RESOURCES', () => {
	test('names exactly the projects CROSS_BACKEND_PROJECTS defines', () => {
		assert.deepEqual(
			Object.keys(CROSS_PROJECT_RESOURCES).sort(),
			CROSS_BACKEND_PROJECTS.map((project) => project.name).sort()
		);
	});

	test('every port is claimed once', () => {
		assert.deepEqual(
			find_duplicates((r) => r.port),
			[]
		);
	});

	test('every Postgres database is claimed once, but within a sharing project', () => {
		assert.deepEqual(
			find_duplicates((r) => r.database, SHARED_DATABASE_PROJECTS),
			[]
		);
	});

	test('a sharing project runs over one database, which no other project claims', () => {
		for (const project of SHARED_DATABASE_PROJECTS) {
			const databases = new Set(
				Object.values(
					CROSS_PROJECT_RESOURCES[project] as Record<string, CrossBackendResources>
				).map((r) => r.database)
			);
			assert.strictEqual(databases.size, 1, `${project} runs over one database`);
			assert.deepEqual(
				backends
					.filter(([, r, p]) => p !== project && databases.has(r.database))
					.map(([label]) => label),
				[],
				`no other project claims ${project}'s database`
			);
		}
	});

	test("no backend claims the db_postgres step's database", () => {
		assert.deepEqual(
			backends.filter(([, r]) => r.database === CROSS_DB_POSTGRES_DATABASE).map(([l]) => l),
			[]
		);
	});

	test('every backend name, and so every temp directory, is claimed once', () => {
		assert.deepEqual(
			find_duplicates((r) => r.name),
			[]
		);
		assert.deepEqual(
			find_duplicates((r) => default_test_backend_prefix(r.name)),
			[]
		);
	});

	test("the single-backend stub's row is the preset's defaults", () => {
		// its setup leaves the database to the stub's URL, so the default URL
		// must name the database the table claims
		const { stub } = CROSS_PROJECT_RESOURCES.cross_backend_rust_spine_stub;
		assert.strictEqual(
			new URL(RUST_SPINE_STUB_DEFAULT_DATABASE_URL).pathname.slice(1),
			stub.database
		);
		assert.strictEqual(stub.port, RUST_SPINE_STUB_DEFAULT_PORT);
		assert.strictEqual(stub.name, RUST_SPINE_STUB_DEFAULT_NAME);
	});
});
