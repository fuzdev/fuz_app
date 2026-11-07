/**
 * Bundle symmetry tests for `all_actor_lookup_action_specs` ↔
 * `create_actor_lookup_actions`.
 *
 * Mirrors the symmetry check in
 * ./standard_action_specs.test.ts for an opt-in bundle. With one
 * method today this is mostly trivial, but it pins the inverse so a
 * future "added spec, forgot handler" (or "added handler, forgot
 * registry") fails fast.
 *
 * Also `actor_lookup`'s `@fuzdev/fuz_schema` schemas: their surface entry is
 * the one captured in `fixtures/surface/actor_lookup.json`, and the wire
 * issues an invalid input gets.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { readFileSync } from 'node:fs';
import { is_schema, parse } from '@fuzdev/fuz_schema/schema.ts';

import {
	ACTOR_LOOKUP_IDS_MAX,
	ActorLookupEntryJson,
	ActorLookupInput,
	ActorLookupOutput,
	actor_lookup_action_spec,
	all_actor_lookup_action_specs
} from '#lib/auth/actor_lookup_action_specs.ts';
import { create_actor_lookup_actions } from '#lib/auth/actor_lookup_actions.ts';
import { generate_app_surface } from '#lib/http/surface.ts';
import { action_manifest_entry } from '#lib/testing/cross_backend/action_manifest.ts';
import { to_wire_issues, type WireIssue } from '#lib/schema_issues.ts';

const log = new Logger('test', { level: 'off' });

describe('all_actor_lookup_action_specs', () => {
	test('no method appears twice', () => {
		const methods = all_actor_lookup_action_specs.map((s) => s.method);
		assert.strictEqual(methods.length, new Set(methods).size, 'duplicate methods in registry');
	});

	test('every registry spec is mounted by create_actor_lookup_actions, and vice versa', () => {
		const handler_methods = create_actor_lookup_actions({ log }).map((a) => a.spec.method);
		const spec_methods = new Set(all_actor_lookup_action_specs.map((s) => s.method));
		for (const method of handler_methods) {
			assert.isTrue(spec_methods.has(method), `runtime mounts ${method} but registry omits it`);
		}
		const handler_set = new Set(handler_methods);
		for (const spec of all_actor_lookup_action_specs) {
			assert.isTrue(
				handler_set.has(spec.method),
				`registry has ${spec.method} but create_actor_lookup_actions doesn't mount it`
			);
		}
	});
});

const SURFACE_FIXTURE_PATH = new URL('../fixtures/surface/actor_lookup.json', import.meta.url);

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** The wire issues `input` gets from `ActorLookupInput`. */
const issues_of = (input: unknown): Array<WireIssue> => {
	const result = parse(ActorLookupInput, input);
	assert.ok(!result.ok, JSON.stringify(input));
	return to_wire_issues(result.issues, input);
};

describe('actor_lookup schemas', () => {
	test('are fuz_schema schemas', () => {
		assert.ok(is_schema(ActorLookupInput));
		assert.ok(is_schema(ActorLookupOutput));
		assert.ok(is_schema(ActorLookupEntryJson));
	});

	test('the surface entry is the captured one', () => {
		const surface = generate_app_surface({
			route_specs: [],
			middleware_specs: [],
			rpc_endpoints: [
				{ path: '/api/rpc', actions: [{ spec: actor_lookup_action_spec, handler: () => null }] }
			]
		});
		assert.deepStrictEqual(surface.diagnostics, []);
		const entry = surface.rpc_endpoints[0]!.methods[0];
		// equal as JSON, not byte for byte: a node's keywords are written `type`
		// first, metadata last, where the capture has `minItems` and `maxItems`
		// ahead of `type`
		assert.deepStrictEqual(entry, JSON.parse(readFileSync(SURFACE_FIXTURE_PATH, 'utf8')));
	});

	test('the action manifest entry reads an object input', () => {
		assert.deepStrictEqual(action_manifest_entry(actor_lookup_action_spec), {
			method: 'actor_lookup',
			input: 'object',
			side_effects: false,
			account: 'required',
			actor: 'none',
			roles: [],
			credential_types: [],
			rate_limit: 'account'
		});
	});

	test('takes 1 to ACTOR_LOOKUP_IDS_MAX ids of either case, output in lowercase', () => {
		const one = parse(ActorLookupInput, { ids: [ID.toUpperCase()] });
		assert.ok(one.ok);
		assert.deepStrictEqual<unknown>(one.value, { ids: [ID] });
		const max = parse(ActorLookupInput, {
			ids: Array.from({ length: ACTOR_LOOKUP_IDS_MAX }, () => ID)
		});
		assert.ok(max.ok);
	});

	test('an invalid input gets its wire issue', () => {
		const cases: Array<[input: unknown, issues: Array<WireIssue>]> = [
			[
				{ ids: [] },
				[
					{
						kind: 'min_length',
						path: ['ids'],
						expected: 'length >= 1',
						received: 'array',
						message: 'ids: expected length >= 1, received array'
					}
				]
			],
			[
				{ ids: Array.from({ length: ACTOR_LOOKUP_IDS_MAX + 1 }, () => ID) },
				[
					{
						kind: 'max_length',
						path: ['ids'],
						expected: `length <= ${ACTOR_LOOKUP_IDS_MAX}`,
						received: 'array',
						message: `ids: expected length <= ${ACTOR_LOOKUP_IDS_MAX}, received array`
					}
				]
			],
			[
				{ ids: [ID, 'not-a-uuid'] },
				[
					{
						kind: 'uuid',
						path: ['ids', 1],
						expected: 'uuid',
						received: 'string',
						message: 'ids.1: expected uuid, received string'
					}
				]
			],
			[
				{ ids: [1] },
				[
					{
						kind: 'string',
						path: ['ids', 0],
						expected: 'string',
						received: 'number',
						message: 'ids.0: expected string, received number'
					}
				]
			],
			[
				{ ids: null },
				[
					{
						kind: 'array',
						path: ['ids'],
						expected: 'array',
						received: 'null',
						message: 'ids: expected array, received null'
					}
				]
			],
			[
				{},
				[
					{
						kind: 'array',
						path: ['ids'],
						expected: 'array',
						received: 'undefined',
						message: 'ids: expected array, received undefined'
					}
				]
			],
			[
				{ ids: ['x'], extra: 1 },
				[
					{
						kind: 'uuid',
						path: ['ids', 0],
						expected: 'uuid',
						received: 'string',
						message: 'ids.0: expected uuid, received string'
					},
					{
						kind: 'unknown_key',
						path: ['extra'],
						expected: 'no unknown keys',
						received: 'number',
						message: 'extra: expected no unknown keys, received number'
					}
				]
			],
			[
				[ID],
				[
					{
						kind: 'object',
						path: [],
						expected: 'object',
						received: 'array',
						message: 'expected object, received array'
					}
				]
			]
		];
		for (const [input, issues] of cases) {
			assert.deepStrictEqual(issues_of(input), issues, JSON.stringify(input));
		}
	});

	test('the output refuses an unknown key, a null display_name, and a bad id', () => {
		assert.ok(parse(ActorLookupOutput, { actors: [] }).ok);
		assert.ok(parse(ActorLookupOutput, { actors: [{ id: ID, username: 'u' }] }).ok);
		assert.ok(
			parse(ActorLookupOutput, { actors: [{ id: ID, username: 'u', display_name: 'U' }] }).ok
		);
		for (const value of [
			{ actors: [{ id: ID, username: 'u', account_id: ID }] },
			{ actors: [], total: 0 },
			{ actors: [{ id: ID, username: 'u', display_name: null }] },
			{ actors: [{ id: 'x', username: 'u' }] },
			{ actors: [{ id: ID }] },
			{}
		]) {
			assert.ok(!parse(ActorLookupOutput, value).ok, JSON.stringify(value));
		}
	});
});
