/**
 * Tests for `actions/action_bridge.ts` — deriving an `EventSpec` from an `ActionSpec`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';

import { create_action_event_spec } from '#lib/actions/action_bridge.ts';
import type { ActionSpec } from '#lib/actions/action_spec.ts';

const create_request_response_spec = (): ActionSpec => ({
	method: 'thing_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: z.strictObject({ name: z.string() }),
	output: z.strictObject({ id: z.string() }),
	async: true,
	description: 'Create a thing'
});

const create_notification_spec = (): ActionSpec => ({
	method: 'thing_created',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: z.strictObject({ id: z.string(), name: z.string() }),
	output: z.void(),
	async: true,
	description: 'A thing was created'
});

const create_local_call_spec = (): ActionSpec => ({
	method: 'toggle_menu',
	kind: 'local_call',
	initiator: 'frontend',
	auth: null,
	side_effects: false,
	input: z.null(),
	output: z.null(),
	async: false,
	description: 'Toggle the menu'
});

/** Notification spec shapes modeled on real tx and zzz specs. */
const notification_spec_cases: Array<{
	name: string;
	spec: ActionSpec;
	channel: string;
}> = [
	{
		name: 'zap_run_created',
		spec: {
			method: 'zap_run_created',
			kind: 'remote_notification',
			initiator: 'backend',
			auth: null,
			side_effects: true,
			async: true,
			input: z.strictObject({ run_id: z.string(), status: z.string() }),
			output: z.void(),
			description: 'A new run was created'
		},
		channel: 'runs'
	},
	{
		name: 'zzz filer_change',
		spec: {
			method: 'filer_change',
			kind: 'remote_notification',
			initiator: 'backend',
			auth: null,
			side_effects: true,
			async: true,
			input: z.strictObject({ change: z.string(), path: z.string() }),
			output: z.void(),
			description: 'File system change detected'
		},
		channel: 'files'
	}
];

describe('create_action_event_spec — consumer spec shapes', () => {
	for (const tc of notification_spec_cases) {
		test(`${tc.name}: channel=${tc.channel}`, () => {
			const event = create_action_event_spec(tc.spec, { channel: tc.channel });
			assert.strictEqual(event.method, tc.spec.method);
			assert.strictEqual(event.description, tc.spec.description);
			assert.strictEqual(event.channel, tc.channel);
			assert.strictEqual(event.params, tc.spec.input);
		});
	}
});

describe('create_action_event_spec', () => {
	test('produces a valid EventSpec from remote_notification action', () => {
		const spec = create_notification_spec();
		const event = create_action_event_spec(spec, { channel: 'things' });

		assert.strictEqual(event.method, 'thing_created');
		assert.strictEqual(event.description, 'A thing was created');
		assert.strictEqual(event.channel, 'things');
		assert.strictEqual(event.params, spec.input);
	});

	test('works without options', () => {
		const spec = create_notification_spec();
		const event = create_action_event_spec(spec);

		assert.strictEqual(event.method, 'thing_created');
		assert.strictEqual(event.channel, undefined);
	});

	test('throws for request_response kind', () => {
		const spec = create_request_response_spec();
		assert.throws(() => create_action_event_spec(spec), /must be 'remote_notification'/);
	});

	test('throws for local_call kind', () => {
		const spec = create_local_call_spec();
		assert.throws(() => create_action_event_spec(spec), /must be 'remote_notification'/);
	});

	test('error message includes method name', () => {
		const spec = create_request_response_spec();
		assert.throws(() => create_action_event_spec(spec), /thing_create/);
	});

	test('error message includes actual kind', () => {
		const spec = create_request_response_spec();
		assert.throws(() => create_action_event_spec(spec), /request_response/);
	});
});
