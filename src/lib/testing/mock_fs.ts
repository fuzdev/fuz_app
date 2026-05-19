/**
 * In-memory file system mock for tests that use dependency-injected
 * `read_file` and `write_file` callbacks. Avoids module-level mocking.
 *
 * @module
 */

export interface MockFs {
	read_file: (path: string, encoding: string) => Promise<string>;
	write_file: (path: string, content: string, encoding: string) => Promise<void>;
	get_file: (path: string) => string | undefined;
}

/**
 * Creates an in-memory file system for tests.
 *
 * `read_file` throws an `ENOENT`-tagged error for missing paths so callers
 * can exercise the same "file doesn't exist" code path as `node:fs`.
 */
export const create_mock_fs = (initial_files: Record<string, string> = {}): MockFs => {
	const files = {...initial_files};

	return {
		read_file: async (path, _encoding) => {
			if (!(path in files)) {
				const error: any = new Error(`ENOENT: no such file or directory, open '${path}'`);
				error.code = 'ENOENT';
				throw error;
			}
			const file_content = files[path];
			if (file_content === undefined) {
				throw new Error(`File at ${path} exists in record but has undefined content`);
			}
			return file_content;
		},

		write_file: async (path, content, _encoding) => {
			files[path] = content;
		},
		get_file: (path) => files[path],
	};
};
