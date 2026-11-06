/**
 * `describe_adversarial_auth`'s `correct auth passes guard` fails a route whose
 * handler answers a JSON error its error map doesn't declare: the generated
 * test is flagged `fails` before it runs, as `test.fails` would, so the run
 * passes only when the suite refuses the undeclared status. The same route's
 * `unauthenticated → 401`, a code its map declares, passes as usual.
 *
 * @module
 */

import { assert, beforeAll, describe, type RunnerTask, type RunnerTestSuite } from 'vitest';
import { literal, loose_object } from '@fuzdev/fuz_schema/schema.ts';

import { describe_adversarial_auth } from '#lib/testing/attack_surface.ts';
import { create_app_surface_spec } from '#lib/http/surface.ts';

const ROUTE = 'GET /api/teapot';

/** The test named `name` in the suite named `suite_name`, under `parent`, at any depth. */
const find_test = (
	parent: RunnerTestSuite,
	suite_name: string,
	name: string
): RunnerTask | undefined => {
	for (const task of parent.tasks) {
		if (task.type !== 'suite') continue;
		if (task.name === suite_name) {
			const found = task.tasks.find((t) => t.type === 'test' && t.name === name);
			if (found) return found;
		}
		const nested: RunnerTask | undefined = find_test(task, suite_name, name);
		if (nested) return nested;
	}
	return undefined;
};

describe('a handler answering an error its route does not declare', () => {
	describe_adversarial_auth({
		build: () =>
			create_app_surface_spec({
				middleware_specs: [],
				route_specs: [
					{
						method: 'GET',
						path: '/api/teapot',
						auth: { account: 'required', actor: 'none' },
						handler: (c) => c.json({ error: 'teapot' }, 418),
						description: 'Answers a status no definition declares.',
						input: literal(null),
						output: loose_object({})
					}
				]
			}),
		roles: []
	});
	// the generated tests exist once collection ends, so the one is flagged before it runs;
	// vitest requires the hook's context argument to be a destructuring pattern
	// eslint-disable-next-line no-empty-pattern
	beforeAll(({}, suite) => {
		const guard = find_test(suite, 'correct auth passes guard', ROUTE);
		assert.ok(guard?.type === 'test');
		guard.fails = true;
		// the 401 is declared and stays a passing test
		assert.ok(find_test(suite, 'unauthenticated → 401', ROUTE));
	});
});
