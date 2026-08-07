/**
 * Tests for backend_action_bridge.ts — deriving RouteSpec and EventSpec from ActionSpec.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { z } from 'zod';

import {
	derive_http_method,
	create_action_route_spec,
	create_action_event_spec
} from '$lib/actions/action_bridge.ts';
import type { ActionSpec } from '$lib/actions/action_spec.ts';

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

const create_public_get_spec = (): ActionSpec => ({
	method: 'thing_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'none', actor: 'none' },
	side_effects: false,
	input: z.null(),
	output: z.strictObject({ items: z.array(z.string()) }),
	async: true,
	description: 'List things'
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

const noop_handler = (c: any) => c.json({});

describe('derive_http_method', () => {
	test('side_effects true maps to POST', () => {
		assert.strictEqual(derive_http_method(true), 'POST');
	});

	test('side_effects false maps to GET', () => {
		assert.strictEqual(derive_http_method(false), 'GET');
	});
});

describe('create_action_route_spec', () => {
	test('produces a valid RouteSpec from request_response action', () => {
		const spec = create_request_response_spec();
		const route = create_action_route_spec(spec, {
			path: '/api/things',
			handler: noop_handler
		});

		assert.strictEqual(route.method, 'POST');
		assert.strictEqual(route.path, '/api/things');
		assert.deepStrictEqual(route.auth, {
			account: 'required',
			actor: 'none',
			required_scope: 'rpc:thing_create'
		});
		assert.strictEqual(route.description, 'Create a thing');
		assert.strictEqual(route.handler, noop_handler);
		assert.strictEqual(route.input, spec.input);
		assert.strictEqual(route.output, spec.output);
	});

	test('uses GET for actions without side effects', () => {
		const spec = create_public_get_spec();
		const route = create_action_route_spec(spec, {
			path: '/api/things',
			handler: noop_handler
		});

		assert.strictEqual(route.method, 'GET');
		assert.deepStrictEqual(route.auth, { account: 'none', actor: 'none' });
	});

	test('allows http_method override', () => {
		const spec = create_request_response_spec();
		const route = create_action_route_spec(spec, {
			path: '/api/things',
			handler: noop_handler,
			http_method: 'PUT'
		});

		assert.strictEqual(route.method, 'PUT');
	});

	test('derives role auth from spec without options override', () => {
		const spec: ActionSpec = {
			...create_request_response_spec(),
			auth: { account: 'required', actor: 'required', roles: ['admin'] }
		};
		const route = create_action_route_spec(spec, { path: '/api/things', handler: noop_handler });
		assert.deepStrictEqual(route.auth, {
			account: 'required',
			actor: 'required',
			roles: ['admin'],
			required_scope: 'rpc:thing_create'
		});
	});

	test('allows auth override', () => {
		const spec = create_request_response_spec();
		const route = create_action_route_spec(spec, {
			path: '/api/things',
			handler: noop_handler,
			auth: {
				account: 'required',
				actor: 'required',
				roles: ['keeper'],
				credential_types: ['daemon_token']
			}
		});

		assert.deepStrictEqual(route.auth, {
			account: 'required',
			actor: 'required',
			roles: ['keeper'],
			credential_types: ['daemon_token'],
			required_scope: 'rpc:thing_create'
		});
	});

	test('throws for null auth', () => {
		const spec = create_notification_spec();
		assert.throws(
			() => create_action_route_spec(spec, { path: '/api/x', handler: noop_handler }),
			/auth is null/
		);
	});

	test('throws for local_call with null auth', () => {
		const spec = create_local_call_spec();
		assert.throws(
			() => create_action_route_spec(spec, { path: '/api/x', handler: noop_handler }),
			/auth is null/
		);
	});

	test('description comes from action spec', () => {
		const spec = create_public_get_spec();
		const route = create_action_route_spec(spec, {
			path: '/api/things',
			handler: noop_handler
		});

		assert.strictEqual(route.description, 'List things');
	});

	test('passes through errors from options', () => {
		const spec = create_request_response_spec();
		const errors = { 404: z.looseObject({ error: z.literal('not_found') }) };
		const route = create_action_route_spec(spec, {
			path: '/api/things',
			handler: noop_handler,
			errors
		});

		assert.strictEqual(route.errors, errors);
	});

	test('omits errors when not in options', () => {
		const spec = create_request_response_spec();
		const route = create_action_route_spec(spec, {
			path: '/api/things',
			handler: noop_handler
		});

		assert.strictEqual(route.errors, undefined);
	});

	test('sets transaction from side_effects true', () => {
		const spec = create_request_response_spec(); // side_effects: true
		const route = create_action_route_spec(spec, {
			path: '/api/things',
			handler: noop_handler
		});

		assert.strictEqual(route.transaction, true);
	});

	test('sets transaction from side_effects false', () => {
		const spec = create_public_get_spec(); // side_effects: false
		const route = create_action_route_spec(spec, {
			path: '/api/things',
			handler: noop_handler
		});

		assert.strictEqual(route.transaction, false);
	});
});

/**
 * The bridge's token-scope gate.
 *
 * A bridged route runs its own handler through the REST pipeline and never
 * reaches `perform_action`, so the dispatcher's per-method scope check cannot
 * fire on it. Left alone that is a bearer-reachable surface a **narrowed** api
 * token walks straight through — the shape token scoping's RPC-only rule exists
 * to refuse. So the bridge declares the capability itself, and these pin that it
 * does, that it names the action's own method rather than a blanket refusal, and
 * that it stays out of the two places where the guard would enforce nothing.
 */
describe('create_action_route_spec — token scope', () => {
	test('derives the per-method capability from the action', () => {
		const route = create_action_route_spec(create_request_response_spec(), {
			path: '/api/things',
			handler: noop_handler
		});
		assert.strictEqual(route.auth.required_scope, 'rpc:thing_create');
	});

	/**
	 * Per-method, not rule 3's blanket refusal: a bridged route carries the
	 * method's identity, which is exactly what the non-RPC surfaces rule 3
	 * covers do not have. A token minted for this method reaches it.
	 */
	test('the capability names the method, not a surface', () => {
		const route = create_action_route_spec(create_request_response_spec(), {
			path: '/api/things',
			handler: noop_handler
		});
		assert.ok(!route.auth.required_scope?.startsWith('surface:'));
	});

	/**
	 * A public action has no credential to narrow — the same holder reaches the
	 * route by dropping it — so the gate would read as a control and enforce
	 * nothing. `fuz_auth_guard_resolver` throws on exactly that shape, so
	 * deriving it here would make every bridged public action fail to register.
	 */
	test('a public action gets no gate', () => {
		const route = create_action_route_spec(create_public_get_spec(), {
			path: '/api/things',
			handler: noop_handler
		});
		assert.strictEqual(route.auth.required_scope, undefined);
	});

	/**
	 * The escape hatch, and the one case that matters: bridge something with no
	 * request/response shape (an SSE stream, a file download) and rule 3's
	 * reasoning applies instead of the method's. An explicit `required_scope`
	 * on the auth override wins.
	 */
	test('an explicit capability on the auth override wins', () => {
		const route = create_action_route_spec(create_request_response_spec(), {
			path: '/api/things/stream',
			handler: noop_handler,
			auth: {
				account: 'required',
				actor: 'none',
				required_scope: 'surface:thing_stream'
			}
		});
		assert.strictEqual(route.auth.required_scope, 'surface:thing_stream');
	});

	/**
	 * An override that doesn't mention scope still gets the gate. Widening the
	 * credential axis without noticing the scope axis is the exact shape of the
	 * consumer defect this whole control family keeps finding.
	 */
	test('an auth override that omits the capability still gets one', () => {
		const route = create_action_route_spec(create_request_response_spec(), {
			path: '/api/things',
			handler: noop_handler,
			auth: { account: 'required', actor: 'required', roles: ['admin'] }
		});
		assert.strictEqual(route.auth.required_scope, 'rpc:thing_create');
	});
});

// --- Table-driven tests with real consumer spec shapes ---

/** Spec shapes modeled on real tx and zzz action specs. */
const consumer_spec_cases: Array<{
	name: string;
	spec: ActionSpec;
	expected_method: 'GET' | 'POST';
	expected_auth: NonNullable<ActionSpec['auth']>;
}> = [
	{
		name: 'zap_plan (admin role, no side_effects → GET)',
		spec: {
			method: 'zap_plan',
			kind: 'request_response',
			initiator: 'frontend',
			auth: { account: 'required', actor: 'required', roles: ['admin'] },
			side_effects: false,
			async: true,
			input: z.strictObject({ config: z.any() }),
			output: z.looseObject({ plan: z.any(), warnings: z.array(z.string()) }),
			description: 'Generate plan from options'
		},
		expected_method: 'GET',
		expected_auth: {
			account: 'required',
			actor: 'required',
			roles: ['admin'],
			required_scope: 'rpc:zap_plan'
		}
	},
	{
		name: 'zap_apply (keeper auth, side_effects → POST)',
		spec: {
			method: 'zap_apply',
			kind: 'request_response',
			initiator: 'frontend',
			auth: {
				account: 'required',
				actor: 'required',
				roles: ['keeper'],
				credential_types: ['daemon_token']
			},
			side_effects: true,
			async: true,
			input: z.strictObject({ run_id: z.string() }),
			output: z.null(),
			description: 'Execute plan'
		},
		expected_method: 'POST',
		expected_auth: {
			account: 'required',
			actor: 'required',
			roles: ['keeper'],
			credential_types: ['daemon_token'],
			required_scope: 'rpc:zap_apply'
		}
	},
	{
		name: 'zzz ping (public, no side_effects → GET)',
		spec: {
			method: 'ping',
			kind: 'request_response',
			initiator: 'both',
			auth: { account: 'none', actor: 'none' },
			side_effects: false,
			async: true,
			input: z.void().optional(),
			output: z.strictObject({ ping_id: z.number() }),
			description: 'Health check'
		},
		expected_method: 'GET',
		expected_auth: { account: 'none', actor: 'none' }
	},
	{
		name: 'zzz completion_create (public, side_effects → POST)',
		spec: {
			method: 'completion_create',
			kind: 'request_response',
			initiator: 'frontend',
			auth: { account: 'none', actor: 'none' },
			side_effects: true,
			async: true,
			input: z.strictObject({ prompt: z.string() }),
			output: z.strictObject({ response: z.string() }),
			description: 'Start an AI completion request'
		},
		expected_method: 'POST',
		expected_auth: { account: 'none', actor: 'none' }
	},
	{
		name: 'authenticated action (authenticated, side_effects → POST)',
		spec: {
			method: 'session_load',
			kind: 'request_response',
			initiator: 'frontend',
			auth: { account: 'required', actor: 'none' },
			side_effects: true,
			async: true,
			input: z.null(),
			output: z.strictObject({ data: z.any() }),
			description: 'Load session data'
		},
		expected_method: 'POST',
		expected_auth: {
			account: 'required',
			actor: 'none',
			required_scope: 'rpc:session_load'
		}
	}
];

describe('create_action_route_spec — consumer spec shapes', () => {
	for (const tc of consumer_spec_cases) {
		test(`${tc.name}: method=${tc.expected_method}, auth=${JSON.stringify(
			tc.expected_auth
		)}`, () => {
			const route = create_action_route_spec(tc.spec, {
				path: `/api/${tc.spec.method}`,
				handler: noop_handler
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
