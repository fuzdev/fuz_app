/**
 * `describe_adversarial_404` fails a route whose fuz_schema 404 schema refuses
 * the stub's bare `{error}` body (here it requires a `resource` field): the
 * generated test is flagged `fails` before it runs, as `test.fails` would, so the run passes
 * only when the body check throws.
 *
 * @module
 */

import { assert, beforeAll, describe } from 'vitest';
import { literal, loose_object, object, string } from '@fuzdev/fuz_schema/schema.ts';

import { describe_adversarial_404 } from '#lib/testing/adversarial_404.ts';
import { create_app_surface_spec } from '#lib/http/surface.ts';
import { Uuid } from '#lib/primitive_schemas_fuz.ts';

describe('a fuz_schema 404 schema the stub body does not satisfy', () => {
	describe_adversarial_404({
		build: () =>
			create_app_surface_spec({
				middleware_specs: [],
				route_specs: [
					{
						method: 'POST',
						path: '/fuz_strict_things/:id',
						auth: { account: 'none', actor: 'none' },
						handler: (c) => c.json(null),
						description: 'A thing whose 404 names the resource',
						params: object({ id: Uuid }),
						input: object({ name: string }),
						output: loose_object({}),
						errors: {
							404: loose_object({ error: literal('fuz_strict_thing_not_found'), resource: string })
						}
					}
				]
			}),
		roles: []
	});
	// the generated test exists once collection ends, so it is flagged before it runs;
	// vitest requires the hook's context argument to be a destructuring pattern
	// eslint-disable-next-line no-empty-pattern
	beforeAll(({}, suite) => {
		const inner = suite.tasks.at(-1);
		assert.ok(inner?.type === 'suite');
		const generated = inner.tasks.at(-1);
		assert.ok(generated?.type === 'test' && generated.name === 'POST /fuz_strict_things/:id');
		generated.fails = true;
	});
});
