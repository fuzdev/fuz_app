/**
 * Tests for `cross_backend_projects.ts` — the cross projects run at once, so
 * every port, Postgres database and temp directory `CROSS_PROJECT_RESOURCES`
 * claims must be claimed once, and the table must cover exactly the projects
 * `CROSS_BACKEND_PROJECTS` defines.
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
	CROSS_PROJECT_RESOURCES,
	type CrossBackendResources
} from './cross_backend_projects.ts';

/** Every backend in the table, labelled `project.role`. */
const backends: ReadonlyArray<[string, CrossBackendResources]> = Object.entries(
	CROSS_PROJECT_RESOURCES
).flatMap(([project, roles]) =>
	Object.entries(roles as Record<string, CrossBackendResources>).map(
		([role, resources]): [string, CrossBackendResources] => [`${project}.${role}`, resources]
	)
);

/** The labels claiming each value more than once. */
const find_duplicates = (
	claim: (resources: CrossBackendResources) => string | number | null
): Array<string> => {
	const claimed: Map<string | number, Array<string>> = new Map();
	for (const [label, resources] of backends) {
		const value = claim(resources);
		if (value === null) continue;
		const labels = claimed.get(value) ?? [];
		labels.push(label);
		claimed.set(value, labels);
	}
	return [...claimed]
		.filter(([, labels]) => labels.length > 1)
		.map(([value, labels]) => `${value}: ${labels.join(', ')}`);
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

	test('every Postgres database is claimed once', () => {
		assert.deepEqual(
			find_duplicates((r) => r.database),
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
