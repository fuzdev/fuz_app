/**
 * `describe_adversarial_404` over 404 definitions whose body carries fields
 * beside `error`: the stub fills them from the definition's schema, so a
 * required field (a `message`) is answered and its body parses against the
 * route's declared 404; a field the generator can't satisfy throws at
 * collection, naming the route; and the body check is wired: a route error
 * map whose 404 refuses the stub's body fails the generated test.
 *
 * @module
 */

import { assert, beforeAll, describe, test } from 'vitest';
import { check, literal, loose_object, object, pipe, string } from '@fuzdev/fuz_schema/schema.ts';

import { define_route } from '#lib/http/route_spec.ts';
import { route_ok } from '#lib/http/route_result.ts';
import { describe_adversarial_404 } from '#lib/testing/adversarial_404.ts';
import { create_app_surface_spec } from '#lib/http/surface.ts';
import { Uuid } from '#lib/primitive_schemas.ts';
import { rest_error } from '#lib/http/error_schemas.ts';
import { format_route_key } from '#lib/http/surface_query.ts';

// a required `message` beside the code: the stub's body carries one
describe_adversarial_404({
	build: () =>
		create_app_surface_spec({
			middleware_specs: [],
			route_specs: [
				define_route({
					method: 'GET',
					path: '/fuz_files/:id',
					auth: { account: 'none', actor: 'none' },
					handler: () => route_ok({ ok: true }),
					description: 'Read a file',
					params: object({ id: Uuid }),
					input: literal(null),
					output: loose_object({ ok: literal(true) }),
					errors: [rest_error(404, 'fuz_file_not_found', { message: string })]
				})
			]
		}),
	roles: []
});

test('a 404 field the generator cannot satisfy throws at collection, naming the route', () => {
	const build = () =>
		create_app_surface_spec({
			middleware_specs: [],
			route_specs: [
				define_route({
					method: 'GET',
					path: '/fuz_magic/:id',
					auth: { account: 'none', actor: 'none' },
					handler: () => route_ok({ ok: true }),
					description: 'Read a magic thing',
					params: object({ id: Uuid }),
					input: literal(null),
					output: loose_object({ ok: literal(true) }),
					errors: [
						rest_error(404, 'fuz_magic_not_found', {
							message: pipe(
								string,
								check((v) => v === 'magic', 'message must be magic')
							)
						})
					]
				})
			]
		});
	assert.throws(
		() => describe_adversarial_404({ build, roles: [] }),
		/GET \/fuz_magic\/:id's 404 'fuz_magic_not_found'/
	);
});

// the stub's body always fits the spec's own definition, so the body check is
// proven by a route error map edited to require a field the definition lacks:
// the generated test is flagged `fails` before it runs, as `test.fails` would,
// so the run passes only when the body check throws
describe('a route error map whose 404 refuses the stub body', () => {
	describe_adversarial_404({
		build: () => {
			const spec = create_app_surface_spec({
				middleware_specs: [],
				route_specs: [
					define_route({
						method: 'GET',
						path: '/fuz_strict_files/:id',
						auth: { account: 'none', actor: 'none' },
						handler: () => route_ok({ ok: true }),
						description: 'Read a file whose 404 the map widens',
						params: object({ id: Uuid }),
						input: literal(null),
						output: loose_object({ ok: literal(true) }),
						errors: [rest_error(404, 'fuz_strict_file_not_found', { message: string })]
					})
				]
			});
			const route_error_maps = new Map(spec.route_error_maps);
			for (const [key, map] of route_error_maps) {
				const strict = rest_error(404, 'fuz_strict_file_not_found', {
					message: string,
					resource: string
				});
				route_error_maps.set(key, { ...map, schemas: { ...map.schemas, 404: strict.schema } });
			}
			return { ...spec, route_error_maps };
		},
		roles: []
	});
	// the generated test exists once collection ends, so it is flagged before it runs;
	// vitest requires the hook's context argument to be a destructuring pattern
	// eslint-disable-next-line no-empty-pattern
	beforeAll(({}, suite) => {
		const inner = suite.tasks.at(-1);
		assert.ok(inner?.type === 'suite');
		const generated = inner.tasks.at(-1);
		assert.ok(
			generated?.type === 'test' &&
				generated.name === format_route_key({ method: 'GET', path: '/fuz_strict_files/:id' })
		);
		generated.fails = true;
	});
});
