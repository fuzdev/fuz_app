/**
 * Tests for action_spec.ts — the spec interfaces, the kind/initiator/phase
 * enums and their const lists, `is_action_spec`, and the handler types a spec
 * of either schema library gives (`HandlerForSpec`, `ValidationOutput`,
 * `ValidationInput`). The type pins are checked by `gro typecheck`.
 *
 * @module
 */

import { describe, assert, test, expectTypeOf } from 'vitest';
import { z } from 'zod';
import {
	is,
	number,
	object,
	optional,
	string,
	void as fuz_void,
	with_default
} from '@fuzdev/fuz_schema/schema.ts';

import {
	ACTION_EVENT_PHASES,
	ACTION_INITIATORS,
	ACTION_KINDS,
	ActionEventPhase,
	ActionInitiator,
	ActionKind,
	is_action_spec,
	type ActionSpecUnion,
	type LocalCallActionSpec,
	type RemoteNotificationActionSpec,
	type RequestResponseActionSpec
} from '#lib/actions/action_spec.ts';
import type {
	ActionActorContext,
	ActionAuthContext,
	ActionContext,
	HandlerForSpec
} from '#lib/actions/action_types.ts';
import type { ValidationInput, ValidationOutput } from '#lib/schema_issues.ts';
import { ActingActor } from '#lib/primitive_schemas_fuz.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';

describe('ActionKind', () => {
	test('accepts valid kinds', () => {
		assert.ok(is(ActionKind, 'request_response'));
		assert.ok(is(ActionKind, 'remote_notification'));
		assert.ok(is(ActionKind, 'local_call'));
	});

	test('rejects invalid kind', () => {
		assert.ok(!is(ActionKind, 'unknown'));
	});

	test('is built from ACTION_KINDS', () => {
		assert.deepStrictEqual(ActionKind.def, [...ACTION_KINDS]);
	});
});

describe('ActionInitiator', () => {
	test('accepts valid initiators', () => {
		assert.ok(is(ActionInitiator, 'frontend'));
		assert.ok(is(ActionInitiator, 'backend'));
		assert.ok(is(ActionInitiator, 'both'));
	});

	test('rejects invalid initiator', () => {
		assert.ok(!is(ActionInitiator, 'server'));
	});

	test('is built from ACTION_INITIATORS', () => {
		assert.deepStrictEqual(ActionInitiator.def, [...ACTION_INITIATORS]);
	});
});

describe('ActionEventPhase', () => {
	test('is built from ACTION_EVENT_PHASES', () => {
		assert.deepStrictEqual(ActionEventPhase.def, [...ACTION_EVENT_PHASES]);
		assert.ok(is(ActionEventPhase, 'execute'));
		assert.ok(!is(ActionEventPhase, 'unknown'));
	});
});

const request_response_spec = {
	method: 'thing_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: z.strictObject({ name: z.string() }),
	output: z.strictObject({ id: z.string() }),
	async: true,
	description: 'Create a thing'
} satisfies RequestResponseActionSpec;

const remote_notification_spec = {
	method: 'thing_created',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: z.strictObject({ id: z.string() }),
	output: z.void(),
	async: true,
	description: 'A thing was created'
} satisfies RemoteNotificationActionSpec;

const local_call_spec = {
	method: 'toggle_menu',
	kind: 'local_call',
	initiator: 'frontend',
	auth: null,
	side_effects: false,
	input: z.null(),
	output: z.null(),
	async: false,
	description: 'Toggle the menu'
} satisfies LocalCallActionSpec;

describe('the spec interfaces', () => {
	test('each kind is an ActionSpecUnion member', () => {
		const specs: Array<ActionSpecUnion> = [
			request_response_spec,
			remote_notification_spec,
			local_call_spec
		];
		assert.deepStrictEqual(
			specs.map((s) => s.kind),
			['request_response', 'remote_notification', 'local_call']
		);
	});

	test('a fuz_schema spec is a spec too, a fuz_schema void its notification output', () => {
		const fuz_request = {
			...request_response_spec,
			input: object({ name: string }),
			output: object({ id: string })
		} satisfies RequestResponseActionSpec;
		const fuz_notification = {
			...remote_notification_spec,
			input: object({ id: string }),
			output: fuz_void
		} satisfies RemoteNotificationActionSpec;
		assert.ok(is_action_spec(fuz_request));
		assert.ok(is_action_spec(fuz_notification));
	});

	test('the kinds narrow their fields (type-level)', () => {
		// @ts-expect-error a request_response spec carries an auth shape
		({ ...request_response_spec, auth: null }) satisfies RequestResponseActionSpec;
		// @ts-expect-error a request_response spec is async
		({ ...request_response_spec, async: false }) satisfies RequestResponseActionSpec;
		// @ts-expect-error every spec spells its kind
		({ ...request_response_spec, kind: undefined }) satisfies RequestResponseActionSpec;
		const { description: _, ...no_description } = request_response_spec;
		// @ts-expect-error every spec has a description
		no_description satisfies RequestResponseActionSpec;
		// @ts-expect-error a literal spec has no unknown keys
		({ ...request_response_spec, extra: 'field' }) satisfies RequestResponseActionSpec;
		({
			...remote_notification_spec,
			// @ts-expect-error a notification's output is a void schema
			output: z.strictObject({})
		}) satisfies RemoteNotificationActionSpec;
		// @ts-expect-error a notification's output is a void schema, fuz_schema's too
		({ ...remote_notification_spec, output: object({}) }) satisfies RemoteNotificationActionSpec;
		// @ts-expect-error a notification has side effects
		({ ...remote_notification_spec, side_effects: false }) satisfies RemoteNotificationActionSpec;
		({
			...local_call_spec,
			// @ts-expect-error a local call has no auth shape
			auth: { account: 'none', actor: 'none' }
		}) satisfies LocalCallActionSpec;
		// @ts-expect-error a spec's schemas are Zod or fuz_schema schemas
		({ ...local_call_spec, input: { parse: () => null } }) satisfies LocalCallActionSpec;
		// a local call may be synchronous
		({ ...local_call_spec, async: false }) satisfies LocalCallActionSpec;
	});
});

describe('is_action_spec', () => {
	test('returns true for valid specs', () => {
		assert.ok(is_action_spec(request_response_spec));
		assert.ok(is_action_spec(remote_notification_spec));
		assert.ok(is_action_spec(local_call_spec));
	});

	test('returns true for every kind in ACTION_KINDS', () => {
		for (const kind of ACTION_KINDS) assert.ok(is_action_spec({ method: 'test', kind }));
	});

	test('returns false for null', () => {
		assert.ok(!is_action_spec(null));
	});

	test('returns false for non-objects', () => {
		assert.ok(!is_action_spec('string'));
		assert.ok(!is_action_spec(42));
	});

	test('returns false for objects without method', () => {
		assert.ok(!is_action_spec({ kind: 'request_response' }));
	});

	test('returns false for objects with invalid kind', () => {
		assert.ok(!is_action_spec({ method: 'test', kind: 'invalid' }));
		assert.ok(!is_action_spec({ method: 'test', kind: 1 }));
	});
});

describe('ValidationOutput / ValidationInput (type-level)', () => {
	test('a Zod schema gives its output and input types', () => {
		const _schema = z.strictObject({ name: z.string(), n: z.number().default(1) });
		expectTypeOf<ValidationOutput<typeof _schema>>().toEqualTypeOf<{ name: string; n: number }>();
		expectTypeOf<ValidationInput<typeof _schema>>().toEqualTypeOf<{
			name: string;
			n?: number | undefined;
		}>();
	});

	test('a fuz_schema schema gives its output and input types', () => {
		const _schema = object({ name: string, n: with_default(number, 1) });
		expectTypeOf<ValidationOutput<typeof _schema>>().toEqualTypeOf<{ name: string; n: number }>();
		expectTypeOf<ValidationInput<typeof _schema>>().toEqualTypeOf<{
			name: string;
			n?: number | undefined;
		}>();
	});
});

describe('HandlerForSpec (type-level)', () => {
	test('a Zod spec narrows the handler input and output', () => {
		const _spec = {
			...request_response_spec,
			input: z.strictObject({ name: z.string(), n: z.number().default(1) }),
			output: z.strictObject({ id: z.string() })
		} satisfies RequestResponseActionSpec;
		type Handler = HandlerForSpec<typeof _spec>;
		expectTypeOf<Parameters<Handler>[0]>().toEqualTypeOf<{ name: string; n: number }>();
		expectTypeOf<Parameters<Handler>[1]>().toEqualTypeOf<ActionAuthContext>();
		expectTypeOf<ReturnType<Handler>>().toEqualTypeOf<{ id: string } | Promise<{ id: string }>>();
	});

	test('a fuz_schema spec narrows the handler input and output', () => {
		const _spec = {
			...request_response_spec,
			auth: { account: 'none', actor: 'none' },
			input: object({ name: string, n: with_default(number, 1) }),
			output: object({ id: string })
		} satisfies RequestResponseActionSpec;
		type Handler = HandlerForSpec<typeof _spec>;
		expectTypeOf<Parameters<Handler>[0]>().toEqualTypeOf<{ name: string; n: number }>();
		expectTypeOf<Parameters<Handler>[1]>().toEqualTypeOf<ActionContext>();
		expectTypeOf<ReturnType<Handler>>().toEqualTypeOf<{ id: string } | Promise<{ id: string }>>();
	});

	test('a fuz_schema actor-axis spec selects the actor tier and keeps the twin Uuid', () => {
		const _spec = {
			...request_response_spec,
			auth: { account: 'required', actor: 'required' },
			input: object({ acting: ActingActor, label: optional(string) }),
			output: fuz_void
		} satisfies RequestResponseActionSpec;
		type Handler = HandlerForSpec<typeof _spec>;
		expectTypeOf<Parameters<Handler>[0]>().toEqualTypeOf<{
			acting?: Uuid | undefined;
			label?: string | undefined;
		}>();
		expectTypeOf<Parameters<Handler>[1]>().toEqualTypeOf<ActionActorContext>();
		expectTypeOf<ReturnType<Handler>>().toEqualTypeOf<void | Promise<void>>();
	});
});
