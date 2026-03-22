/**
 * Basic rendering test for `SurfaceExplorer` using SSR.
 *
 * @module
 */

import {test, assert} from 'vitest';
import {render} from 'svelte/server';

import SurfaceExplorer from '$lib/ui/SurfaceExplorer.svelte';
import type {AppSurface} from '$lib/http/surface.js';

const test_surface: AppSurface = {
	middleware: [
		{name: 'origin', path: '/api/*', error_schemas: null},
		{name: 'session', path: '/api/*', error_schemas: null},
	],
	routes: [
		{
			method: 'GET',
			path: '/health',
			auth: {type: 'none'},
			applicable_middleware: [],
			description: 'Health check',
			is_mutation: false,
			transaction: false,
			rate_limit_key: null,
			params_schema: null,
			query_schema: null,
			input_schema: null,
			output_schema: {type: 'object', properties: {status: {type: 'string'}}},
			error_schemas: null,
		},
		{
			method: 'POST',
			path: '/api/login',
			auth: {type: 'authenticated'},
			applicable_middleware: ['origin', 'session'],
			description: 'Login endpoint',
			is_mutation: true,
			transaction: true,
			rate_limit_key: null,
			params_schema: null,
			query_schema: null,
			input_schema: {type: 'object', properties: {username: {type: 'string'}}},
			output_schema: {type: 'object'},
			error_schemas: {'401': {type: 'object'}},
		},
		{
			method: 'DELETE',
			path: '/api/admin/user',
			auth: {type: 'role', role: 'admin'},
			applicable_middleware: ['origin', 'session'],
			description: 'Delete user',
			is_mutation: true,
			transaction: true,
			rate_limit_key: null,
			params_schema: null,
			query_schema: null,
			input_schema: null,
			output_schema: {type: 'object'},
			error_schemas: {'403': {type: 'object'}},
		},
	],
	env: [
		{
			name: 'DATABASE_URL',
			description: 'Postgres connection',
			sensitivity: 'secret',
			optional: false,
			has_default: false,
		},
		{
			name: 'PORT',
			description: 'Server port',
			sensitivity: null,
			optional: true,
			has_default: true,
		},
	],
	events: [
		{
			method: 'user_updated',
			description: 'User profile changed',
			channel: 'user',
			params_schema: null,
		},
	],
	diagnostics: [],
};

test('renders without error', () => {
	const {body} = render(SurfaceExplorer, {props: {surface: test_surface}});
	assert.ok(body.includes('<section'), 'should render a section element');
});

test('renders summary chips', () => {
	const {body} = render(SurfaceExplorer, {props: {surface: test_surface}});
	assert.ok(body.includes('3 routes'), 'should show route count');
	assert.ok(body.includes('2 middleware'), 'should show middleware count');
	assert.ok(body.includes('2 env'), 'should show env count');
	assert.ok(body.includes('1 events'), 'should show event count');
});

test('renders auth distribution chips', () => {
	const {body} = render(SurfaceExplorer, {props: {surface: test_surface}});
	assert.ok(body.includes('1 public'), 'should show public count');
	assert.ok(body.includes('1 authenticated'), 'should show authenticated count');
	assert.ok(body.includes('1 role'), 'should show role count');
});

test('renders route rows', () => {
	const {body} = render(SurfaceExplorer, {props: {surface: test_surface}});
	assert.ok(body.includes('/health'), 'should show health route path');
	assert.ok(body.includes('/api/login'), 'should show login route path');
	assert.ok(body.includes('/api/admin/user'), 'should show admin route path');
});

test('renders middleware names', () => {
	const {body} = render(SurfaceExplorer, {props: {surface: test_surface}});
	assert.ok(body.includes('origin'), 'should show origin middleware');
	assert.ok(body.includes('session'), 'should show session middleware');
});

test('renders env var names', () => {
	const {body} = render(SurfaceExplorer, {props: {surface: test_surface}});
	assert.ok(body.includes('DATABASE_URL'), 'should show env var name');
	assert.ok(body.includes('PORT'), 'should show env var name');
});

test('renders event methods', () => {
	const {body} = render(SurfaceExplorer, {props: {surface: test_surface}});
	assert.ok(body.includes('user_updated'), 'should show event method');
	assert.ok(body.includes('User profile changed'), 'should show event description');
});

test('renders diagnostics warnings', () => {
	const surface_with_diagnostics: AppSurface = {
		...test_surface,
		diagnostics: [
			{
				level: 'warning',
				category: 'schema',
				message: 'Input schema is not z.strictObject()',
				source: 'POST /api/login input',
			},
			{level: 'info', category: 'config', message: 'Rate limiter disabled'},
		],
	};
	const {body} = render(SurfaceExplorer, {props: {surface: surface_with_diagnostics}});
	assert.ok(body.includes('1 warning'), 'should show warning count chip');
	assert.ok(body.includes('diagnostics'), 'should show diagnostics section');
	assert.ok(body.includes('schema'), 'should show category');
	assert.ok(body.includes('Input schema is not z.strictObject()'), 'should show warning message');
	assert.ok(body.includes('Rate limiter disabled'), 'should show info message');
});

test('hides diagnostics warning chip when only info-level', () => {
	const surface_info_only: AppSurface = {
		...test_surface,
		diagnostics: [{level: 'info', category: 'config', message: 'Something informational'}],
	};
	const {body} = render(SurfaceExplorer, {props: {surface: surface_info_only}});
	assert.ok(!body.includes('warning'), 'should not show warning chip');
	assert.ok(body.includes('diagnostics'), 'should still show diagnostics section');
});

test('handles empty surface', () => {
	const empty_surface: AppSurface = {
		middleware: [],
		routes: [],
		env: [],
		events: [],
		diagnostics: [],
	};
	const {body} = render(SurfaceExplorer, {props: {surface: empty_surface}});
	assert.ok(body.includes('0 routes'), 'should show zero routes');
	assert.ok(body.includes('0 middleware'), 'should show zero middleware');
	// env and events sections should not appear
	assert.ok(!body.includes('environment'), 'should not show environment section');
	assert.ok(!body.includes('events'), 'should not show events section');
});
