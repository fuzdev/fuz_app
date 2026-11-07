/**
 * Bundle symmetry tests for `all_actor_search_action_specs` ↔
 * `create_actor_search_actions`.
 *
 * Mirrors the symmetry check in ./actor_lookup_action_specs.test.ts.
 * One method today, but pinning the inverse so a future "added spec,
 * forgot handler" (or "added handler, forgot registry") fails fast.
 * Also pins the input's `'personal'` query, which keeps a search off the URL,
 * and `actor_search`'s `@fuzdev/fuz_schema` schemas: their surface entry is
 * the one captured in `fixtures/surface/actor_search.json`, and the wire
 * issues an invalid input gets.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { readFileSync } from 'node:fs';
import { is_schema, parse } from '@fuzdev/fuz_schema/schema.ts';

import {
	ACTOR_SEARCH_LIMIT_MAX,
	ACTOR_SEARCH_QUERY_LENGTH_MAX,
	ActorSearchInput,
	ActorSearchOutput,
	actor_search_action_spec,
	all_actor_search_action_specs
} from '#lib/auth/actor_search_action_specs.ts';
import { generate_app_surface } from '#lib/http/surface.ts';
import { action_manifest_entry } from '#lib/testing/cross_backend/action_manifest.ts';
import { to_wire_issues } from '#lib/schema_issues.ts';
import { create_actor_search_actions } from '#lib/auth/actor_search_actions.ts';
import { schema_has_sensitive_field } from '#lib/schema_meta.ts';
import { find_schema_sensitivity } from '#lib/sensitivity.ts';

const log = new Logger('test', { level: 'off' });

describe('all_actor_search_action_specs', () => {
	test('no method appears twice', () => {
		const methods = all_actor_search_action_specs.map((s) => s.method);
		assert.strictEqual(methods.length, new Set(methods).size, 'duplicate methods in registry');
	});

	test('every registry spec is mounted by create_actor_search_actions, and vice versa', () => {
		const handler_methods = create_actor_search_actions({ log }).map((a) => a.spec.method);
		const spec_methods = new Set(all_actor_search_action_specs.map((s) => s.method));
		for (const method of handler_methods) {
			assert.isTrue(spec_methods.has(method), `runtime mounts ${method} but registry omits it`);
		}
		const handler_set = new Set(handler_methods);
		for (const spec of all_actor_search_action_specs) {
			assert.isTrue(
				handler_set.has(spec.method),
				`registry has ${spec.method} but create_actor_search_actions doesn't mount it`
			);
		}
	});
});

describe('ActorSearchInput', () => {
	test('its query is personal, so a search goes as a POST, never in a GET URL', () => {
		assert.strictEqual(find_schema_sensitivity(ActorSearchInput.def.query), 'personal');
		assert.isTrue(schema_has_sensitive_field(ActorSearchInput));
	});
});

const SURFACE_FIXTURE_PATH = new URL('../fixtures/surface/actor_search.json', import.meta.url);

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** U+1F600 — one code point, two UTF-16 code units. */
const ASTRAL = '\u{1F600}';

/** The one wire issue `input` gets from `ActorSearchInput`, as `[kind, path, expected, received, message]`. */
const issue_of = (input: unknown): Array<unknown> => {
	const result = parse(ActorSearchInput, input);
	assert.ok(!result.ok, JSON.stringify(input));
	const issues = to_wire_issues(result.issues);
	assert.strictEqual(issues.length, 1, JSON.stringify(issues));
	const { kind, path, expected, received, message } = issues[0]!;
	return [kind, path, expected, received, message];
};

describe('actor_search schemas', () => {
	test('are fuz_schema schemas', () => {
		assert.ok(is_schema(ActorSearchInput));
		assert.ok(is_schema(ActorSearchOutput));
	});

	test('the surface entry is the captured one', () => {
		const surface = generate_app_surface({
			route_specs: [],
			middleware_specs: [],
			rpc_endpoints: [
				{ path: '/api/rpc', actions: [{ spec: actor_search_action_spec, handler: () => null }] }
			]
		});
		assert.deepStrictEqual(surface.diagnostics, []);
		const entry = surface.rpc_endpoints[0]!.methods[0];
		// equal as JSON, not byte for byte: a node's keywords are written `type`
		// first, metadata last, where the capture has the `description` of an
		// optional field first
		assert.deepStrictEqual(entry, JSON.parse(readFileSync(SURFACE_FIXTURE_PATH, 'utf8')));
	});

	test('the action manifest entry reads an object input', () => {
		assert.deepStrictEqual(action_manifest_entry(actor_search_action_spec), {
			method: 'actor_search',
			input: 'object',
			side_effects: false,
			account: 'required',
			actor: 'none',
			roles: [],
			credential_types: [],
			rate_limit: 'account'
		});
	});

	test('takes a query of 1 to the cap in UTF-16 code units, and optional scope_ids and limit', () => {
		for (const input of [
			{ query: 'a' },
			{ query: 'a'.repeat(ACTOR_SEARCH_QUERY_LENGTH_MAX) },
			{ query: ASTRAL.repeat(ACTOR_SEARCH_QUERY_LENGTH_MAX / 2) },
			{ query: 'a', scope_ids: [] },
			{ query: 'a', limit: 1 },
			{ query: 'a', limit: ACTOR_SEARCH_LIMIT_MAX },
			{ query: 'a', limit: undefined }
		]) {
			const result = parse(ActorSearchInput, input);
			assert.ok(result.ok, JSON.stringify(input));
			// nothing to change, so the input itself
			assert.strictEqual(result.value, input);
		}
		const upper = parse(ActorSearchInput, { query: 'a', scope_ids: [ID.toUpperCase()] });
		assert.ok(upper.ok);
		assert.deepStrictEqual<unknown>(upper.value, { query: 'a', scope_ids: [ID] });
	});

	test('an invalid input gets its wire issue', () => {
		const max = ACTOR_SEARCH_QUERY_LENGTH_MAX;
		const cap = ACTOR_SEARCH_LIMIT_MAX;
		const cases: Array<[input: unknown, issue: Array<unknown>]> = [
			[
				{ query: '' },
				[
					'min_length',
					['query'],
					'length >= 1',
					'string',
					'query: expected length >= 1, received string'
				]
			],
			[
				{ query: 'a'.repeat(max + 1) },
				[
					'max_length',
					['query'],
					`length <= ${max}`,
					'string',
					`query: expected length <= ${max}, received string`
				]
			],
			// past the cap in code units, at it in code points
			[
				{ query: ASTRAL.repeat(max / 2) + 'a' },
				[
					'max_length',
					['query'],
					`length <= ${max}`,
					'string',
					`query: expected length <= ${max}, received string`
				]
			],
			[
				{ query: 1 },
				['string', ['query'], 'string', 'number', 'query: expected string, received number']
			],
			[
				{},
				['string', ['query'], 'string', 'undefined', 'query: expected string, received undefined']
			],
			[
				{ query: 'a', limit: 0 },
				['min_value', ['limit'], '>= 1', 'number', 'limit: expected >= 1, received number']
			],
			[
				{ query: 'a', limit: cap + 1 },
				[
					'max_value',
					['limit'],
					`<= ${cap}`,
					'number',
					`limit: expected <= ${cap}, received number`
				]
			],
			[
				{ query: 'a', limit: 1.5 },
				['integer', ['limit'], 'integer', 'number', 'limit: expected integer, received number']
			],
			[
				{ query: 'a', limit: '5' },
				['number', ['limit'], 'number', 'string', 'limit: expected number, received string']
			],
			[
				{ query: 'a', limit: null },
				['number', ['limit'], 'number', 'null', 'limit: expected number, received null']
			],
			[
				{ query: 'a', limit: NaN },
				['number', ['limit'], 'number', 'NaN', 'limit: expected number, received NaN']
			],
			[
				{ query: 'a', scope_ids: ['x'] },
				['uuid', ['scope_ids', 0], 'uuid', 'string', 'scope_ids.0: expected uuid, received string']
			],
			[
				{ query: 'a', scope_ids: null },
				['array', ['scope_ids'], 'array', 'null', 'scope_ids: expected array, received null']
			],
			[
				{ query: 'a', extra: 1 },
				[
					'unknown_key',
					['extra'],
					'no unknown keys',
					'number',
					'extra: expected no unknown keys, received number'
				]
			],
			[null, ['object', [], 'object', 'null', 'expected object, received null']]
		];
		for (const [input, issue] of cases) {
			assert.deepStrictEqual(issue_of(input), issue, JSON.stringify(input));
		}
	});

	test('the output refuses an unknown key on a row', () => {
		assert.ok(parse(ActorSearchOutput, { actors: [{ id: ID, username: 'u' }] }).ok);
		assert.ok(!parse(ActorSearchOutput, { actors: [{ id: ID, username: 'u', email: 'e' }] }).ok);
		assert.ok(!parse(ActorSearchOutput, { actors: [], extra: 1 }).ok);
	});
});
