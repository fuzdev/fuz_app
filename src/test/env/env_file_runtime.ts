/**
 * A mock runtime seeded with env files, for the `update_env_variable` suites.
 *
 * @module
 */

import { create_mock_runtime, type MockRuntime } from '#lib/runtime/mock.ts';

/** A `create_mock_runtime` whose `mock_fs` starts with `files` (path → content). */
export const create_env_file_runtime = (files: Record<string, string> = {}): MockRuntime => {
	const runtime = create_mock_runtime();
	for (const [path, content] of Object.entries(files)) runtime.mock_fs.set(path, content);
	return runtime;
};
