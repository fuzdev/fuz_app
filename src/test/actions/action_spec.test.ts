/**
 * Tests for action_spec.ts — ActionSpec types and type guards.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {z} from 'zod';

import {
	ActionKind,
	ActionInitiator,
	ActionAuth,
	ActionSideEffects,
	ActionSpec,
	RequestResponseActionSpec,
	RemoteNotificationActionSpec,
	LocalCallActionSpec,
	ActionSpecUnion,
	is_action_spec,
} from '$lib/actions/action_spec.js';

describe('ActionKind', () => {
	test('accepts valid kinds', () => {
		assert.ok(ActionKind.safeParse('request_response').success);
		assert.ok(ActionKind.safeParse('remote_notification').success);
		assert.ok(ActionKind.safeParse('local_call').success);
	});

	test('rejects invalid kind', () => {
		assert.ok(!ActionKind.safeParse('unknown').success);
	});
});

describe('ActionInitiator', () => {
	test('accepts valid initiators', () => {
		assert.ok(ActionInitiator.safeParse('frontend').success);
		assert.ok(ActionInitiator.safeParse('backend').success);
		assert.ok(ActionInitiator.safeParse('both').success);
	});

	test('rejects invalid initiator', () => {
		assert.ok(!ActionInitiator.safeParse('server').success);
	});
});

describe('ActionAuth', () => {
	test('accepts public and authenticated', () => {
		assert.ok(ActionAuth.safeParse('public').success);
		assert.ok(ActionAuth.safeParse('authenticated').success);
	});

	test('accepts role object', () => {
		assert.ok(ActionAuth.safeParse({role: 'admin'}).success);
		assert.ok(ActionAuth.safeParse({role: 'keeper'}).success);
	});

	test('rejects invalid string auth', () => {
		assert.ok(!ActionAuth.safeParse('admin').success);
	});

	test('rejects role object missing role field', () => {
		assert.ok(!ActionAuth.safeParse({}).success);
	});

	test('rejects role object with non-string role', () => {
		assert.ok(!ActionAuth.safeParse({role: 42}).success);
	});
});

describe('ActionSideEffects', () => {
	test('accepts true and null', () => {
		assert.ok(ActionSideEffects.safeParse(true).success);
		assert.ok(ActionSideEffects.safeParse(null).success);
	});

	test('rejects false', () => {
		assert.ok(!ActionSideEffects.safeParse(false).success);
	});
});

const create_request_response_spec = () => ({
	method: 'thing_create',
	kind: 'request_response' as const,
	initiator: 'frontend' as const,
	auth: 'authenticated' as const,
	side_effects: true as const,
	input: z.strictObject({name: z.string()}),
	output: z.strictObject({id: z.string()}),
	async: true,
	description: 'Create a thing',
});

const create_remote_notification_spec = () => ({
	method: 'thing_created',
	kind: 'remote_notification' as const,
	initiator: 'backend' as const,
	auth: null,
	side_effects: true as const,
	input: z.strictObject({id: z.string()}),
	output: z.void(),
	async: true,
	description: 'A thing was created',
});

const create_local_call_spec = () => ({
	method: 'toggle_menu',
	kind: 'local_call' as const,
	initiator: 'frontend' as const,
	auth: null,
	side_effects: null,
	input: z.null(),
	output: z.null(),
	async: false,
	description: 'Toggle the menu',
});

describe('ActionSpec', () => {
	test('accepts a valid request_response spec', () => {
		const result = ActionSpec.safeParse(create_request_response_spec());
		assert.ok(result.success);
	});

	test('accepts a valid remote_notification spec', () => {
		const result = ActionSpec.safeParse(create_remote_notification_spec());
		assert.ok(result.success);
	});

	test('accepts a valid local_call spec', () => {
		const result = ActionSpec.safeParse(create_local_call_spec());
		assert.ok(result.success);
	});

	test('requires description', () => {
		const {description: _, ...spec} = create_request_response_spec();
		const result = ActionSpec.safeParse(spec);
		assert.ok(!result.success);
	});

	test('rejects unknown keys (strict)', () => {
		const spec = {...create_request_response_spec(), extra: 'field'};
		const result = ActionSpec.safeParse(spec);
		assert.ok(!result.success);
	});
});

describe('RequestResponseActionSpec', () => {
	test('accepts a valid spec', () => {
		const result = RequestResponseActionSpec.safeParse(create_request_response_spec());
		assert.ok(result.success);
	});

	test('requires non-null auth', () => {
		const spec = {...create_request_response_spec(), auth: null};
		const result = RequestResponseActionSpec.safeParse(spec);
		assert.ok(!result.success);
	});

	test('requires async true', () => {
		const spec = {...create_request_response_spec(), async: false};
		const result = RequestResponseActionSpec.safeParse(spec);
		assert.ok(!result.success);
	});

	test('defaults kind to request_response', () => {
		const {kind: _, ...spec} = create_request_response_spec();
		const result = RequestResponseActionSpec.safeParse(spec);
		assert.ok(result.success);
		assert.strictEqual(result.data.kind, 'request_response');
	});
});

describe('RemoteNotificationActionSpec', () => {
	test('accepts a valid spec', () => {
		const result = RemoteNotificationActionSpec.safeParse(create_remote_notification_spec());
		assert.ok(result.success);
	});

	test('requires void output', () => {
		const spec = {...create_remote_notification_spec(), output: z.strictObject({id: z.string()})};
		const result = RemoteNotificationActionSpec.safeParse(spec);
		assert.ok(!result.success);
	});

	test('defaults auth to null', () => {
		const {auth: _, ...spec} = create_remote_notification_spec();
		const result = RemoteNotificationActionSpec.safeParse(spec);
		assert.ok(result.success);
		assert.strictEqual(result.data.auth, null);
	});
});

describe('LocalCallActionSpec', () => {
	test('accepts a valid spec', () => {
		const result = LocalCallActionSpec.safeParse(create_local_call_spec());
		assert.ok(result.success);
	});

	test('allows sync', () => {
		const spec = create_local_call_spec();
		const result = LocalCallActionSpec.safeParse(spec);
		assert.ok(result.success);
		assert.strictEqual(result.data.async, false);
	});

	test('defaults auth to null', () => {
		const {auth: _, ...spec} = create_local_call_spec();
		const result = LocalCallActionSpec.safeParse(spec);
		assert.ok(result.success);
		assert.strictEqual(result.data.auth, null);
	});
});

describe('ActionSpecUnion', () => {
	test('accepts all three kinds', () => {
		assert.ok(ActionSpecUnion.safeParse(create_request_response_spec()).success);
		assert.ok(ActionSpecUnion.safeParse(create_remote_notification_spec()).success);
		assert.ok(ActionSpecUnion.safeParse(create_local_call_spec()).success);
	});
});

describe('is_action_spec', () => {
	test('returns true for valid specs', () => {
		assert.ok(is_action_spec(create_request_response_spec()));
		assert.ok(is_action_spec(create_remote_notification_spec()));
		assert.ok(is_action_spec(create_local_call_spec()));
	});

	test('returns false for null', () => {
		assert.ok(!is_action_spec(null));
	});

	test('returns false for non-objects', () => {
		assert.ok(!is_action_spec('string'));
		assert.ok(!is_action_spec(42));
	});

	test('returns false for objects without method', () => {
		assert.ok(!is_action_spec({kind: 'request_response'}));
	});

	test('returns false for objects with invalid kind', () => {
		assert.ok(!is_action_spec({method: 'test', kind: 'invalid'}));
	});
});
