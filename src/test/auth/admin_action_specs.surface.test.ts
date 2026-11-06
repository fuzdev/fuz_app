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
 * - the fuz_schema outputs of the listings (`MOVED_OUTPUT_METHODS`): every
 *   timestamp is a `Timestamp`, gaining `format: 'date-time'` and the
 *   `iso_datetime` `pattern` (an `anyOf` with `null` where nullable); an
 *   account's or an invite's `username`, `{}` at capture (the Zod
 *   `Username`'s transform has no JSON Schema form, an `info` diagnostic on
 *   the output), is `UsernameCanonical`, its bounds and lowercase grammar; a
 *   grant's or an offer's `role` and `scope_kind` take the `RoleName` and
 *   `ScopeKindName` grammar; and an account's or an invite's `email` gains
 *   `maxLength`, as the input's did, its byte `check` an `info` diagnostic in
 *   place of the transform's
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { readFileSync } from 'node:fs';

import { all_admin_action_specs } from '#lib/auth/admin_action_specs.ts';
import { to_ws_actions, protocol_actions } from '#lib/actions/protocol.ts';
import type { ResolvedWsEndpointSpec } from '#lib/actions/ws_endpoint_spec.ts';
import { generate_app_surface, type AppSurfaceDiagnostic } from '#lib/http/surface.ts';
import {
	EMAIL_LENGTH_MAX,
	EMAIL_REGEX,
	USERNAME_LENGTH_MAX,
	USERNAME_LENGTH_MIN
} from '#lib/primitive_schemas.ts';
import { USERNAME_CANONICAL_REGEX } from '#lib/primitive_schemas_fuz.ts';
import { NAME_LENGTH_MAX, NAME_REGEX } from '#lib/auth/name_schema.ts';

import { with_timestamp_format } from '../surface_test_helpers.ts';

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

/** The methods whose output moved from Zod to fuz_schema with a row in it. */
const MOVED_OUTPUT_METHODS: ReadonlyArray<unknown> = [
	'admin_account_list',
	'admin_session_list',
	'audit_log_list',
	'audit_log_role_grant_history',
	'invite_create',
	'invite_list'
];

const USERNAME_NODE = {
	type: 'string',
	minLength: USERNAME_LENGTH_MIN,
	maxLength: USERNAME_LENGTH_MAX,
	pattern: USERNAME_CANONICAL_REGEX.source
};
const NAME_NODE = { type: 'string', maxLength: NAME_LENGTH_MAX, pattern: NAME_REGEX.source };

// declared: in a moved output, the nodes found by their Zod-era form at their keys
const with_row_nodes = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(with_row_nodes);
	if (typeof value !== 'object' || value === null) return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		const node = child as Record<string, any>;
		if (key === 'username' && JSON.stringify(child) === '{}') {
			out[key] = USERNAME_NODE;
		} else if (key === 'username' && JSON.stringify(node.anyOf?.[0]) === '{}') {
			out[key] = { ...node, anyOf: [USERNAME_NODE, ...node.anyOf.slice(1)] };
		} else if (key === 'role' && JSON.stringify(child) === '{"type":"string"}') {
			out[key] = NAME_NODE;
		} else if (key === 'scope_kind' && JSON.stringify(node.type) === '["string","null"]') {
			const { type: _, ...rest } = node;
			out[key] = { anyOf: [NAME_NODE, { type: 'null' }], ...rest };
		} else if (key === 'email' && Array.isArray(node.anyOf)) {
			const [string_node, ...others] = node.anyOf;
			out[key] = { ...node, anyOf: [{ ...string_node, maxLength: EMAIL_LENGTH_MAX }, ...others] };
		} else {
			out[key] = with_row_nodes(child);
		}
	}
	return out;
};

const with_moved_output = (entry: Record<string, unknown>): Record<string, unknown> =>
	MOVED_OUTPUT_METHODS.includes(entry.name)
		? { ...entry, output_schema: with_timestamp_format(with_row_nodes(entry.output_schema)) }
		: entry;

const expected_entries = (head: Array<Record<string, unknown>>): unknown =>
	(with_email_pattern(head) as Array<Record<string, unknown>>)
		.map(with_email_max_length)
		.map(with_integer_count)
		.map(with_moved_output);

const check_diagnostic = (
	source: string,
	pointer = '#/properties/email/anyOf/0'
): AppSurfaceDiagnostic => ({
	level: 'info',
	category: 'schema',
	message: `Part of the schema has no JSON Schema form and is left out or written as {} there: cannot express \`check\` at ${pointer}: it holds a function`,
	source
});

/** Where a moved output's `Email` check sits, by method. */
const OUTPUT_EMAIL_POINTERS: Record<string, string> = {
	admin_account_list: '#/properties/accounts/items/properties/account/properties/email/anyOf/0',
	invite_create: '#/properties/invite/properties/email/anyOf/0',
	invite_list: '#/properties/invites/items/properties/email/anyOf/0'
};

// declared: a moved output's transform diagnostic is its `Email` check's, or none
const with_moved_diagnostics = (list: Array<AppSurfaceDiagnostic>): Array<AppSurfaceDiagnostic> =>
	list.flatMap((d) => {
		const [endpoint, method, side] = d.source!.split(' ');
		if (side !== 'output' || !MOVED_OUTPUT_METHODS.includes(method)) return [d];
		const pointer = OUTPUT_EMAIL_POINTERS[method!];
		return pointer ? [check_diagnostic(`${endpoint} ${method} output`, pointer)] : [];
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
			...at(with_moved_diagnostics(rpc), '/api/rpc invite_create input'),
			...at(with_moved_diagnostics(ws), '/ws invite_create input')
		]);
	});
});
