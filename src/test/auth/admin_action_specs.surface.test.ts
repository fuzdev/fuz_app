/**
 * The admin domain's surface, held to the Zod-era one captured in
 * `fixtures/surface/admin.json`: the RPC and WS entries of every method of
 * `all_admin_action_specs`, and the diagnostics. Equal as JSON apart from the
 * declared moves, each applied to the capture here:
 *
 * - every `Email` node's `pattern` is the current `EMAIL_REGEX`, which refuses
 *   a domain with a dot at its edge, on the inputs and on the Zod outputs
 *   alike
 * - `invite_create`'s `email` gains `maxLength`, the `max_length` the
 *   fuz_schema `Email` bounds its code units by ahead of its byte `check`
 * - that `check` has no JSON Schema form, an `info` diagnostic on
 *   `invite_create`'s input on each endpoint
 * - the revoke-all outputs' `count` is a non-negative integer, where the Zod
 *   one was any number
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { readFileSync } from 'node:fs';

import { all_admin_action_specs } from '#lib/auth/admin_action_specs.ts';
import { to_ws_actions, protocol_actions } from '#lib/actions/protocol.ts';
import type { ResolvedWsEndpointSpec } from '#lib/actions/ws_endpoint_spec.ts';
import { generate_app_surface, type AppSurfaceDiagnostic } from '#lib/http/surface.ts';
import { EMAIL_LENGTH_MAX, EMAIL_REGEX } from '#lib/primitive_schemas.ts';

const FIXTURE_PATH = new URL('../fixtures/surface/admin.json', import.meta.url);

interface SurfaceCapture {
	rpc: Array<Record<string, unknown>>;
	ws: Array<Record<string, unknown>>;
	diagnostics: Array<AppSurfaceDiagnostic>;
}

/** The `Email` pattern of the capture, the grammar before a dot at a domain's edge was refused. */
const HEAD_EMAIL_PATTERN = '^[^\\s\\u0085@]+@[^\\s\\u0085@]+\\.[^\\s\\u0085@]+$';

const capture_surface = () => {
	const actions = all_admin_action_specs.map((spec) => ({ spec, handler: () => null }));
	const ws_endpoint: ResolvedWsEndpointSpec = {
		path: '/ws',
		allowed_origins: [],
		actions: to_ws_actions(actions)
	};
	return generate_app_surface({
		route_specs: [],
		middleware_specs: [],
		rpc_endpoints: [{ path: '/api/rpc', actions }],
		ws_endpoints: [ws_endpoint]
	});
};

// declared: every `Email` node, found by its Zod-era pattern, takes the current one
const with_email_pattern = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(with_email_pattern);
	if (typeof value !== 'object' || value === null) return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		out[key] =
			key === 'pattern' && child === HEAD_EMAIL_PATTERN
				? EMAIL_REGEX.source
				: with_email_pattern(child);
	}
	return out;
};

// declared: `invite_create`'s `email` string node gains `maxLength`
const with_email_max_length = (entry: Record<string, unknown>): Record<string, unknown> => {
	if (entry.name !== 'invite_create') return entry;
	const input = entry.input_schema as any;
	const email = input.properties.email;
	const [string_node, ...rest] = email.anyOf;
	return {
		...entry,
		input_schema: {
			...input,
			properties: {
				...input.properties,
				email: { ...email, anyOf: [{ ...string_node, maxLength: EMAIL_LENGTH_MAX }, ...rest] }
			}
		}
	};
};

/** The methods whose output's `count` is a non-negative integer. */
const REVOKE_ALL_METHODS: ReadonlyArray<unknown> = [
	'admin_session_revoke_all',
	'admin_token_revoke_all'
];

// declared: the revoke-all outputs' `count` is a non-negative integer
const with_integer_count = (entry: Record<string, unknown>): Record<string, unknown> => {
	if (!REVOKE_ALL_METHODS.includes(entry.name)) return entry;
	const output = entry.output_schema as any;
	assert.deepStrictEqual(output.properties.count, { type: 'number' });
	return {
		...entry,
		output_schema: {
			...output,
			properties: { ...output.properties, count: { type: 'integer', minimum: 0 } }
		}
	};
};

const expected_entries = (head: Array<Record<string, unknown>>): unknown =>
	(with_email_pattern(head) as Array<Record<string, unknown>>)
		.map(with_email_max_length)
		.map(with_integer_count);

const check_diagnostic = (source: string): AppSurfaceDiagnostic => ({
	level: 'info',
	category: 'schema',
	message:
		'Part of the schema has no JSON Schema form and is left out or written as {} there: cannot express `check` at #/properties/email/anyOf/0: it holds a function',
	source
});

describe('admin surface', () => {
	const head: SurfaceCapture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
	const surface = capture_surface();
	const methods = all_admin_action_specs.map((s) => s.method);

	test('the capture is of every admin method, on each endpoint', () => {
		assert.deepStrictEqual(
			head.rpc.map((m) => m.name),
			methods
		);
		assert.deepStrictEqual(
			head.ws.map((m) => m.name),
			methods
		);
		// the Zod-era capture held the Email pattern this test declares the move of
		assert.include(JSON.stringify(head.rpc), JSON.stringify(HEAD_EMAIL_PATTERN));
	});

	test('the RPC entries are the Zod-era ones but for the declared moves', () => {
		assert.deepStrictEqual(surface.rpc_endpoints[0]!.methods, expected_entries(head.rpc));
	});

	test('the WS entries are the Zod-era ones but for the declared moves', () => {
		assert.deepStrictEqual(
			surface.ws_endpoints[0]!.methods.slice(protocol_actions.length),
			expected_entries(head.ws)
		);
	});

	test("the diagnostics are the capture's and the Email check of invite_create's input", () => {
		const rpc = head.diagnostics.filter((d) => d.source?.startsWith('/api/rpc '));
		const ws = head.diagnostics.filter((d) => d.source?.startsWith('/ws '));
		assert.strictEqual(rpc.length + ws.length, head.diagnostics.length);
		const at = (list: Array<AppSurfaceDiagnostic>, source: string) => {
			const i = list.findIndex((d) => d.source === source.replace('input', 'output'));
			return [...list.slice(0, i), check_diagnostic(source), ...list.slice(i)];
		};
		assert.deepStrictEqual(surface.diagnostics, [
			...at(rpc, '/api/rpc invite_create input'),
			...at(ws, '/ws invite_create input')
		]);
	});
});
