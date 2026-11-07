/**
 * `compile_action_registry` refuses an `ActionSpec` whose `input` or `output`
 * holds a value that is not a schema at registration, naming the action and the
 * slot — on every spec, a handler-less or notification spec included — and
 * admits a `@fuzdev/fuz_schema` schema in each.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { literal, object, string } from '@fuzdev/fuz_schema/schema.ts';

import { compile_action_registry } from '#lib/actions/compile_action_registry.ts';
import type { Action } from '#lib/actions/action_types.ts';

const base_spec = {
	method: 'take_thing',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'none', actor: 'none' },
	side_effects: false,
	input: object({ name: string }),
	output: object({ ok: literal(true) }),
	async: true,
	description: 'Takes a thing.'
} as const;

// a spec is data: a JS caller, or one cast past the types, can put anything in a slot
const compile = (overrides: Record<string, unknown>, with_handler = true): void => {
	const action = {
		spec: { ...base_spec, ...overrides },
		...(with_handler ? { handler: async () => ({ ok: true }) } : {})
	} as unknown as Action;
	compile_action_registry([action], 'RPC action');
};

const NOT_SCHEMAS: Array<[string, unknown]> = [
	['an empty object', {}],
	['null', null],
	['undefined', undefined],
	['a string', 'string'],
	['a schema-shaped object', { kind: 'string', def: {} }]
];

const refusal = (slot: string): RegExp =>
	new RegExp(`^RPC action "take_thing": ${slot} is .*a @fuzdev/fuz_schema schema$`);

describe('compile_action_registry refuses a value that is not a schema', () => {
	for (const slot of ['input', 'output'] as const) {
		for (const [label, value] of NOT_SCHEMAS) {
			test(`${label} as ${slot}, naming the action and slot`, () => {
				assert.throws(() => compile({ [slot]: value }), refusal(slot));
			});
		}

		test(`on a handler-less spec's ${slot}`, () => {
			assert.throws(() => compile({ [slot]: {} }, false), refusal(slot));
		});
	}

	test('on a notification spec', () => {
		assert.throws(
			() =>
				compile(
					{ kind: 'remote_notification', initiator: 'backend', auth: null, input: {} },
					false
				),
			refusal('input')
		);
	});

	test('before the checks that read the schemas', () => {
		// the acting biconditional reads input; without the slot check first,
		// this threw a TypeError naming nothing
		assert.throws(() => compile({ input: {} }), refusal('input'));
	});
});

describe('compile_action_registry admits', () => {
	test('fuz_schema schemas', () => {
		compile({});
	});
});
