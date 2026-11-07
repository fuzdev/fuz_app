import type { Task } from '@fuzdev/gro';
import { writeFileSync } from 'node:fs';

import {
	generate_codegen_fixture,
	zod_fixture_specs
} from '../../actions/action_codegen_fixture.ts';

export const task: Task = {
	summary: 'generate all_zod_expected.txt, the codegen of the all-Zod fixture spec list',
	run: ({ log }) => {
		const path = new URL('./all_zod_expected.txt', import.meta.url);
		writeFileSync(path, generate_codegen_fixture(zod_fixture_specs));
		log.info(`wrote ${path.pathname}`);
	}
};
