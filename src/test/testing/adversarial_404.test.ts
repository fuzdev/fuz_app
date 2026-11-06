/**
 * `describe_adversarial_404` over a route whose params and input are
 * fuz_schema and whose 404 is a definition: the stub answers the
 * definition's code, its body validated with `parse_any` against the route's
 * declared 404.
 *
 * @module
 */

import {
	literal,
	loose_object,
	min_length,
	object,
	pipe,
	string
} from '@fuzdev/fuz_schema/schema.ts';

import { describe_adversarial_404 } from '#lib/testing/adversarial_404.ts';
import { rest_error } from '#lib/http/error_schemas.ts';
import { create_app_surface_spec } from '#lib/http/surface.ts';
import { Uuid } from '#lib/primitive_schemas_fuz.ts';

// a fuz_schema route: its 404 test is generated and its stub's body parsed
// against its 404 definition
describe_adversarial_404({
	build: () =>
		create_app_surface_spec({
			middleware_specs: [],
			route_specs: [
				{
					method: 'POST',
					path: '/fuz_things/:id/rename',
					auth: { account: 'none', actor: 'none' },
					handler: (c) => c.json({ ok: true }),
					description: 'Rename a fuz_schema thing',
					params: object({ id: Uuid }),
					input: object({ name: pipe(string, min_length(1)) }),
					output: loose_object({ ok: literal(true) }),
					errors: [rest_error(404, 'fuz_thing_not_found')]
				}
			]
		}),
	roles: []
});
