/**
 * Tests for backend_action_bridge.ts — deriving RouteSpec and SseEventSpec from ActionSpec.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';
import {z} from 'zod';

import {
	map_action_auth,
	derive_http_method,
	route_spec_from_action,
	event_spec_from_action,
} from '$lib/actions/action_bridge.js';
import type {ActionSpec} from '$lib/actions/action_spec.js';
import type {RouteAuth} from '$lib/http/route_spec.js';

const create_request_response_spec = (): ActionSpec => ({
	method: 'thing_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: z.strictObject({name: z.string()}),
	output: z.strictObject({id: z.string()}),
	async: true,
	description: 'Create a thing',
});

const create_public_get_spec = (): ActionSpec => ({
	method: 'thing_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: null,
	input: z.null(),
	output: z.strictObject({items: z.array(z.string())}),
	async: true,
	description: 'List things',
});

const create_notification_spec = (): ActionSpec => ({
	method: 'thing_created',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: z.strictObject({id: z.string(), name: z.string()}),
	output: z.void(),
	async: true,
	description: 'A thing was created',
});

const create_local_call_spec = (): ActionSpec => ({
	method: 'toggle_menu',
	kind: 'local_call',
	initiator: 'frontend',
	auth: null,
	side_effects: null,
	input: z.null(),
	output: z.null(),
	async: false,
	description: 'Toggle the menu',
});

const noop_handler = (c: any) => c.json({});

describe('map_action_auth', () => {
	test('maps public to none', () => {
		assert.deepStrictEqual(map_action_auth('public'), {type: 'none'});
	});

	test('maps authenticated to authenticated', () => {
		assert.deepStrictEqual(map_action_auth('authenticated'), {type: 'authenticated'});
	});

	test('maps role object to role auth', () => {
		assert.deepStrictEqual(map_action_auth({role: 'admin'}), {type: 'role', role: 'admin'});
	});

	test('maps keeper literal to keeper auth type', () => {
		assert.deepStrictEqual(map_action_auth('keeper'), {type: 'keeper'});
	});
});

describe('derive_http_method', () => {
	test('side_effects true maps to POST', () => {
		assert.strictEqual(derive_http_method(true), 'POST');
	});

	test('side_effects null maps to GET', () => {
		assert.strictEqual(derive_http_method(null), 'GET');
	});
});

describe('route_spec_from_action', () => {
	test('produces a valid RouteSpec from request_response action', () => {
		const spec = create_request_response_spec();
		const route = route_spec_from_action(spec, {
			path: '/api/things',
			handler: noop_handler,
		});

		assert.strictEqual(route.method, 'POST');
		assert.strictEqual(route.path, '/api/things');
		assert.deepStrictEqual(route.auth, {type: 'authenticated'});
		assert.strictEqual(route.description, 'Create a thing');
		assert.strictEqual(route.handler, noop_handler);
		assert.strictEqual(route.input, spec.input);
		assert.strictEqual(route.output, spec.output);
	});

	test('uses GET for actions without side effects', () => {
		const spec = create_public_get_spec();
		const route = route_spec_from_action(spec, {
			path: '/api/things',
			handler: noop_handler,
		});

		assert.strictEqual(route.method, 'GET');
		assert.deepStrictEqual(route.auth, {type: 'none'});
	});

	test('allows http_method override', () => {
		const spec = create_request_response_spec();
		const route = route_spec_from_action(spec, {
			path: '/api/things',
			handler: noop_handler,
			http_method: 'PUT',
		});

		assert.strictEqual(route.method, 'PUT');
	});

	test('derives role auth from spec without options override', () => {
		const spec: ActionSpec = {
			...create_request_response_spec(),
			auth: {role: 'admin'},
		};
		const route = route_spec_from_action(spec, {path: '/api/things', handler: noop_handler});
		assert.deepStrictEqual(route.auth, {type: 'role', role: 'admin'});
	});

	test('allows auth override', () => {
		const spec = create_request_response_spec();
		const route = route_spec_from_action(spec, {
			path: '/api/things',
			handler: noop_handler,
			auth: {type: 'keeper'},
		});

		assert.deepStrictEqual(route.auth, {type: 'keeper'});
	});

	test('throws for null auth', () => {
		const spec = create_notification_spec();
		assert.throws(
			() => route_spec_from_action(spec, {path: '/api/x', handler: noop_handler}),
			/auth is null/,
		);
	});

	test('throws for local_call with null auth', () => {
		const spec = create_local_call_spec();
		assert.throws(
			() => route_spec_from_action(spec, {path: '/api/x', handler: noop_handler}),
			/auth is null/,
		);
	});

	test('description comes from action spec', () => {
		const spec = create_public_get_spec();
		const route = route_spec_from_action(spec, {
			path: '/api/things',
			handler: noop_handler,
		});

		assert.strictEqual(route.description, 'List things');
	});

	test('passes through errors from options', () => {
		const spec = create_request_response_spec();
		const errors = {404: z.looseObject({error: z.literal('not_found')})};
		const route = route_spec_from_action(spec, {
			path: '/api/things',
			handler: noop_handler,
			errors,
		});

		assert.strictEqual(route.errors, errors);
	});

	test('omits errors when not in options', () => {
		const spec = create_request_response_spec();
		const route = route_spec_from_action(spec, {
			path: '/api/things',
			handler: noop_handler,
		});

		assert.strictEqual(route.errors, undefined);
	});
});

// --- Table-driven tests with real consumer spec shapes ---

/** Spec shapes modeled on real tx and zzz action specs. */
const consumer_spec_cases: Array<{
	name: string;
	spec: ActionSpec;
	expected_method: 'GET' | 'POST';
	expected_auth: RouteAuth;
}> = [
	{
		name: 'tx_plan (admin role, no side_effects → GET)',
		spec: {
			method: 'tx_plan',
			kind: 'request_response',
			initiator: 'frontend',
			auth: {role: 'admin'},
			side_effects: null,
			async: true,
			input: z.strictObject({config: z.any()}),
			output: z.looseObject({plan: z.any(), warnings: z.array(z.string())}),
			description: 'Generate plan from options',
		},
		expected_method: 'GET',
		expected_auth: {type: 'role', role: 'admin'},
	},
	{
		name: 'tx_apply (keeper auth, side_effects → POST)',
		spec: {
			method: 'tx_apply',
			kind: 'request_response',
			initiator: 'frontend',
			auth: 'keeper',
			side_effects: true,
			async: true,
			input: z.strictObject({run_id: z.string()}),
			output: z.null(),
			description: 'Execute plan',
		},
		expected_method: 'POST',
		expected_auth: {type: 'keeper'},
	},
	{
		name: 'zzz ping (public, no side_effects → GET)',
		spec: {
			method: 'ping',
			kind: 'request_response',
			initiator: 'both',
			auth: 'public',
			side_effects: null,
			async: true,
			input: z.void().optional(),
			output: z.strictObject({ping_id: z.number()}),
			description: 'Health check',
		},
		expected_method: 'GET',
		expected_auth: {type: 'none'},
	},
	{
		name: 'zzz completion_create (public, side_effects → POST)',
		spec: {
			method: 'completion_create',
			kind: 'request_response',
			initiator: 'frontend',
			auth: 'public',
			side_effects: true,
			async: true,
			input: z.strictObject({prompt: z.string()}),
			output: z.strictObject({response: z.string()}),
			description: 'Start an AI completion request',
		},
		expected_method: 'POST',
		expected_auth: {type: 'none'},
	},
	{
		name: 'authenticated action (authenticated, side_effects → POST)',
		spec: {
			method: 'session_load',
			kind: 'request_response',
			initiator: 'frontend',
			auth: 'authenticated',
			side_effects: true,
			async: true,
			input: z.null(),
			output: z.strictObject({data: z.any()}),
			description: 'Load session data',
		},
		expected_method: 'POST',
		expected_auth: {type: 'authenticated'},
	},
];

describe('route_spec_from_action — consumer spec shapes', () => {
	for (const tc of consumer_spec_cases) {
		test(`${tc.name}: method=${tc.expected_method}, auth=${JSON.stringify(tc.expected_auth)}`, () => {
			const route = route_spec_from_action(tc.spec, {
				path: `/api/${tc.spec.method}`,
				handler: noop_handler,
			});
			assert.strictEqual(route.method, tc.expected_method);
			assert.deepStrictEqual(route.auth, tc.expected_auth);
			assert.strictEqual(route.description, tc.spec.description);
			assert.strictEqual(route.input, tc.spec.input);
			assert.strictEqual(route.output, tc.spec.output);
		});
	}
});

/** Notification spec shapes modeled on real tx and zzz specs. */
const notification_spec_cases: Array<{
	name: string;
	spec: ActionSpec;
	channel: string;
}> = [
	{
		name: 'tx_run_created',
		spec: {
			method: 'tx_run_created',
			kind: 'remote_notification',
			initiator: 'backend',
			auth: null,
			side_effects: true,
			async: true,
			input: z.strictObject({run_id: z.string(), status: z.string()}),
			output: z.void(),
			description: 'A new run was created',
		},
		channel: 'runs',
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
			input: z.strictObject({change: z.string(), path: z.string()}),
			output: z.void(),
			description: 'File system change detected',
		},
		channel: 'files',
	},
];

describe('event_spec_from_action — consumer spec shapes', () => {
	for (const tc of notification_spec_cases) {
		test(`${tc.name}: channel=${tc.channel}`, () => {
			const event = event_spec_from_action(tc.spec, {channel: tc.channel});
			assert.strictEqual(event.method, tc.spec.method);
			assert.strictEqual(event.description, tc.spec.description);
			assert.strictEqual(event.channel, tc.channel);
			assert.strictEqual(event.params, tc.spec.input);
		});
	}
});

/** Table-driven auth mapping — all ActionAuth → RouteAuth combinations. */
const auth_mapping_cases: Array<{
	action_auth: 'public' | 'authenticated' | 'keeper' | {role: string};
	expected: RouteAuth;
}> = [
	{action_auth: 'public', expected: {type: 'none'}},
	{action_auth: 'authenticated', expected: {type: 'authenticated'}},
	{action_auth: 'keeper', expected: {type: 'keeper'}},
	{action_auth: {role: 'admin'}, expected: {type: 'role', role: 'admin'}},
	{action_auth: {role: 'user'}, expected: {type: 'role', role: 'user'}},
	{action_auth: {role: 'teacher'}, expected: {type: 'role', role: 'teacher'}},
];

describe('map_action_auth — comprehensive', () => {
	for (const tc of auth_mapping_cases) {
		test(`${JSON.stringify(tc.action_auth)} → ${JSON.stringify(tc.expected)}`, () => {
			assert.deepStrictEqual(map_action_auth(tc.action_auth), tc.expected);
		});
	}
});

describe('event_spec_from_action', () => {
	test('produces a valid SseEventSpec from remote_notification action', () => {
		const spec = create_notification_spec();
		const event = event_spec_from_action(spec, {channel: 'things'});

		assert.strictEqual(event.method, 'thing_created');
		assert.strictEqual(event.description, 'A thing was created');
		assert.strictEqual(event.channel, 'things');
		assert.strictEqual(event.params, spec.input);
	});

	test('works without options', () => {
		const spec = create_notification_spec();
		const event = event_spec_from_action(spec);

		assert.strictEqual(event.method, 'thing_created');
		assert.strictEqual(event.channel, undefined);
	});

	test('throws for request_response kind', () => {
		const spec = create_request_response_spec();
		assert.throws(() => event_spec_from_action(spec), /must be 'remote_notification'/);
	});

	test('throws for local_call kind', () => {
		const spec = create_local_call_spec();
		assert.throws(() => event_spec_from_action(spec), /must be 'remote_notification'/);
	});

	test('error message includes method name', () => {
		const spec = create_request_response_spec();
		assert.throws(() => event_spec_from_action(spec), /thing_create/);
	});

	test('error message includes actual kind', () => {
		const spec = create_request_response_spec();
		assert.throws(() => event_spec_from_action(spec), /request_response/);
	});
});
