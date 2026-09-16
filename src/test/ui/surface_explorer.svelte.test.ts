/**
 * Basic rendering test for `SurfaceExplorer` using SSR.
 *
 * @module
 */

import { test, assert } from 'vitest';
import { render } from 'svelte/server';

import SurfaceExplorer from '$lib/ui/SurfaceExplorer.svelte';
import type { AppSurface } from '$lib/http/surface.ts';

const test_surface: AppSurface = {
	middleware: [
		{ name: 'origin', path: '/api/*', error_schemas: null },
		{ name: 'session', path: '/api/*', error_schemas: null }
	],
	routes: [
		{
			method: 'GET',
			path: '/health',
			auth: { account: 'none', actor: 'none' },
			applicable_middleware: [],
			description: 'Health check',
			is_mutation: false,
			transaction: false,
			raw_body: false,
			rate_limit_key: null,
			params_schema: null,
			query_schema: null,
			input_schema: null,
			output_schema: { type: 'object', properties: { status: { type: 'string' } } },
			error_schemas: null
		},
		{
			method: 'POST',
			path: '/api/login',
			auth: { account: 'required', actor: 'none' },
			applicable_middleware: ['origin', 'session'],
			description: 'Login endpoint',
			is_mutation: true,
			transaction: true,
			raw_body: false,
			rate_limit_key: null,
			params_schema: null,
			query_schema: null,
			input_schema: { type: 'object', properties: { username: { type: 'string' } } },
			output_schema: { type: 'object' },
			error_schemas: { '401': { type: 'object' } }
		},
		{
			method: 'DELETE',
			path: '/api/admin/user',
			auth: { account: 'required', actor: 'required', roles: ['admin'] },
			applicable_middleware: ['origin', 'session'],
			description: 'Delete user',
			is_mutation: true,
			transaction: true,
			raw_body: false,
			rate_limit_key: null,
			params_schema: null,
			query_schema: null,
			input_schema: null,
			output_schema: { type: 'object' },
			error_schemas: { '403': { type: 'object' } }
		}
	],
	env: [
		{
			name: 'DATABASE_URL',
			description: 'Postgres connection',
			sensitivity: 'secret',
			optional: false,
			has_default: false
		},
		{
			name: 'PORT',
			description: 'Server port',
			sensitivity: null,
			optional: true,
			has_default: true
		}
	],
	rpc_endpoints: [
		{
			path: '/api/rpc',
			methods: [
				{
					name: 'account_verify',
					auth: { account: 'required', actor: 'none' },
					input_schema: null,
					output_schema: { type: 'object' },
					side_effects: false,
					description: 'Verify the session',
					rate_limit_key: null
				},
				{
					name: 'invite_create',
					auth: { account: 'required', actor: 'required', roles: ['admin'] },
					input_schema: { type: 'object', properties: { note: { type: 'string' } } },
					output_schema: { type: 'object' },
					side_effects: true,
					description: 'Create an invite',
					rate_limit_key: 'account'
				}
			]
		}
	],
	ws_endpoints: [
		{
			path: '/api/ws',
			allowed_origins: ['/^http:\\/\\/localhost(:\\d+)?$/i'],
			required_roles: [],
			methods: [
				{
					name: 'heartbeat',
					kind: 'request_response',
					auth: { account: 'required', actor: 'none' },
					input_schema: { type: 'object', properties: {}, additionalProperties: false },
					output_schema: { type: 'object' },
					description: 'Ping the server',
					side_effects: false,
					rate_limit_key: null
				},
				{
					name: 'role_grant_offer_received',
					kind: 'remote_notification',
					auth: null,
					input_schema: { type: 'object', properties: { offer: { type: 'object' } } },
					output_schema: { type: 'null' },
					description: 'Notify the recipient of a new offer',
					side_effects: true,
					rate_limit_key: null
				}
			]
		}
	],
	events: [
		{
			method: 'user_updated',
			description: 'User profile changed',
			channel: 'user',
			params_schema: null
		}
	],
	diagnostics: []
};

test('renders without error', () => {
	const { body } = render(SurfaceExplorer, { props: { surface: test_surface } });
	assert.ok(body.includes('<section'), 'should render a section element');
});

test('renders summary chips', () => {
	const { body } = render(SurfaceExplorer, { props: { surface: test_surface } });
	assert.ok(body.includes('3 routes'), 'should show route count');
	assert.ok(body.includes('2 middleware'), 'should show middleware count');
	assert.ok(body.includes('2 rpc methods'), 'should show rpc method count');
	assert.ok(body.includes('2 ws methods'), 'should show ws method count');
	assert.ok(body.includes('2 env'), 'should show env count');
	assert.ok(body.includes('1 events'), 'should show event count');
});

test('renders auth distribution chips', () => {
	const { body } = render(SurfaceExplorer, { props: { surface: test_surface } });
	assert.ok(body.includes('1 public'), 'should show public count');
	assert.ok(body.includes('1 authenticated'), 'should show authenticated count');
	assert.ok(body.includes('1 role'), 'should show role count');
});

test('renders route rows', () => {
	const { body } = render(SurfaceExplorer, { props: { surface: test_surface } });
	assert.ok(body.includes('/health'), 'should show health route path');
	assert.ok(body.includes('/api/login'), 'should show login route path');
	assert.ok(body.includes('/api/admin/user'), 'should show admin route path');
});

test('renders middleware names', () => {
	const { body } = render(SurfaceExplorer, { props: { surface: test_surface } });
	assert.ok(body.includes('origin'), 'should show origin middleware');
	assert.ok(body.includes('session'), 'should show session middleware');
});

test('renders env var names', () => {
	const { body } = render(SurfaceExplorer, { props: { surface: test_surface } });
	assert.ok(body.includes('DATABASE_URL'), 'should show env var name');
	assert.ok(body.includes('PORT'), 'should show env var name');
});

test('renders event methods', () => {
	const { body } = render(SurfaceExplorer, { props: { surface: test_surface } });
	assert.ok(body.includes('user_updated'), 'should show event method');
	assert.ok(body.includes('User profile changed'), 'should show event description');
});

test('renders rpc endpoint section', () => {
	const { body } = render(SurfaceExplorer, { props: { surface: test_surface } });
	assert.ok(body.includes('rpc endpoints'), 'should show rpc section heading');
	assert.ok(body.includes('/api/rpc'), 'should show rpc endpoint path');
	assert.ok(body.includes('account_verify'), 'should show rpc method name');
	assert.ok(body.includes('invite_create'), 'should show second rpc method');
	assert.ok(body.includes('Verify the session'), 'should show rpc method description');
});

test('renders ws endpoint section with kind chip', () => {
	const { body } = render(SurfaceExplorer, { props: { surface: test_surface } });
	assert.ok(body.includes('websocket endpoints'), 'should show ws section heading');
	assert.ok(body.includes('/api/ws'), 'should show ws endpoint path');
	assert.ok(body.includes('heartbeat'), 'should show ws method name');
	assert.ok(body.includes('role_grant_offer_received'), 'should show notification method name');
	assert.ok(body.includes('remote_notification'), 'should show kind chip');
	assert.ok(body.includes('request_response'), 'should show request_response kind chip');
	assert.ok(
		body.includes('/^http:\\/\\/localhost(:\\d+)?$/i'),
		'should show allowed_origin pattern chip'
	);
});

test('hides empty rpc/ws sections', () => {
	const surface_no_rpc_ws: AppSurface = {
		...test_surface,
		rpc_endpoints: [],
		ws_endpoints: []
	};
	const { body } = render(SurfaceExplorer, { props: { surface: surface_no_rpc_ws } });
	assert.ok(!body.includes('rpc endpoints'), 'should not show rpc section');
	assert.ok(!body.includes('websocket endpoints'), 'should not show ws section');
	assert.ok(!body.includes('rpc methods'), 'should not show rpc chip');
	assert.ok(!body.includes('ws methods'), 'should not show ws chip');
});

test('renders diagnostics warnings', () => {
	const surface_with_diagnostics: AppSurface = {
		...test_surface,
		diagnostics: [
			{
				level: 'warning',
				category: 'schema',
				message: 'Input schema is not z.strictObject()',
				source: 'POST /api/login input'
			},
			{ level: 'info', category: 'config', message: 'Rate limiter disabled' }
		]
	};
	const { body } = render(SurfaceExplorer, { props: { surface: surface_with_diagnostics } });
	assert.ok(body.includes('1 warning'), 'should show warning count chip');
	assert.ok(body.includes('diagnostics'), 'should show diagnostics section');
	assert.ok(body.includes('schema'), 'should show category');
	assert.ok(body.includes('Input schema is not z.strictObject()'), 'should show warning message');
	assert.ok(body.includes('Rate limiter disabled'), 'should show info message');
});

test('hides diagnostics warning chip when only info-level', () => {
	const surface_info_only: AppSurface = {
		...test_surface,
		diagnostics: [{ level: 'info', category: 'config', message: 'Something informational' }]
	};
	const { body } = render(SurfaceExplorer, { props: { surface: surface_info_only } });
	assert.ok(!body.includes('warning'), 'should not show warning chip');
	assert.ok(body.includes('diagnostics'), 'should still show diagnostics section');
});

test('handles empty surface', () => {
	const empty_surface: AppSurface = {
		middleware: [],
		routes: [],
		rpc_endpoints: [],
		ws_endpoints: [],
		env: [],
		events: [],
		diagnostics: []
	};
	const { body } = render(SurfaceExplorer, { props: { surface: empty_surface } });
	assert.ok(body.includes('0 routes'), 'should show zero routes');
	assert.ok(body.includes('0 middleware'), 'should show zero middleware');
	// env and events sections should not appear
	assert.ok(!body.includes('environment'), 'should not show environment section');
	assert.ok(!body.includes('events'), 'should not show events section');
});
