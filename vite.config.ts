import {availableParallelism} from 'node:os';
import {defineConfig} from 'vitest/config';
import {sveltekit} from '@sveltejs/kit/vite';

const max_threads = Math.max(1, Math.ceil(availableParallelism() / 2));

export default defineConfig({
	plugins: [sveltekit()],
	optimizeDeps: {exclude: ['@fuzdev/blake3_wasm']},
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					include: ['src/test/**/*.test.ts'],
					exclude: ['src/test/**/*.db.test.ts'],
					maxWorkers: max_threads,
					sequence: {groupOrder: 1},
				},
			},
			{
				extends: true,
				test: {
					name: 'db',
					include: ['src/test/**/*.db.test.ts'],
					isolate: false,
					fileParallelism: false,
					sequence: {groupOrder: 2},
				},
			},
			// `globalSetup` for this project owns spawning the backend, so
			// `isolate` + `fileParallelism` are off: one shared backend
			// instance across every `*.cross.test.ts` file in one run.
			{
				extends: true,
				test: {
					name: 'cross_backend_fuz_webui',
					include: ['src/test/cross_backend/*.cross.test.ts'],
					isolate: false,
					fileParallelism: false,
					sequence: {groupOrder: 3},
				},
			},
		],
	},
});
