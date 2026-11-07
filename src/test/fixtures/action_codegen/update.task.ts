import type { Task } from '@fuzdev/gro';
import { writeFileSync } from 'node:fs';

import { fixture_specs, generate_codegen_fixture } from '../../actions/action_codegen_fixture.ts';

export const task: Task = {
	summary: 'generate fuz_expected.txt, the codegen of fuz_app’s own spec list',
	run: ({ log }) => {
		const path = new URL('./fuz_expected.txt', import.meta.url);
		writeFileSync(path, generate_codegen_fixture(fixture_specs));
		log.info(`wrote ${path.pathname}`);
	}
};
