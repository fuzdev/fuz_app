/**
 * The account domain's action surface, held to the Zod-era one captured in
 * `fixtures/surface/account.json`: the RPC and WS entries of every method of
 * `all_account_action_specs`, and the diagnostics. Equal as JSON apart from
 * the declared moves, each applied to the capture here:
 *
 * - `account_session_revoke_all`'s `count` is a non-negative integer, where
 *   the Zod one was any number
 * - `account_token_create`'s `expires_at` and every timestamp of an
 *   `account_token_list` row is a `Timestamp`, gaining `format: 'date-time'`
 *   and the `iso_datetime` `pattern` (an `anyOf` with `null` where nullable)
 * - an `account_token_list` row's `id` is an `ApiTokenId`, gaining its
 *   `pattern`
 *
 * The diagnostics are the capture's.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { readFileSync } from 'node:fs';

import { all_account_action_specs } from '#lib/auth/account_action_specs.ts';
import { API_TOKEN_ID_REGEX } from '#lib/auth/api_token.ts';
import { to_ws_actions, protocol_actions } from '#lib/actions/protocol.ts';
import type { ResolvedWsEndpointSpec } from '#lib/actions/ws_endpoint_spec.ts';
import { generate_app_surface, type AppSurfaceDiagnostic } from '#lib/http/surface.ts';

import { with_timestamp_format } from '../surface_test_helpers.ts';

const FIXTURE_PATH = new URL('../fixtures/surface/account.json', import.meta.url);

interface SurfaceCapture {
	rpc: Array<Record<string, any>>;
	ws: Array<Record<string, any>>;
	diagnostics: Array<AppSurfaceDiagnostic>;
}

const capture_surface = () => {
	const actions = all_account_action_specs.map((spec) => ({ spec, handler: () => null }));
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

// declared: `account_session_revoke_all`'s `count` is a non-negative integer
const with_integer_count = (entry: Record<string, any>): Record<string, any> => {
	if (entry.name !== 'account_session_revoke_all') return entry;
	const output = entry.output_schema;
	assert.deepStrictEqual(output.properties.count, { type: 'number' });
	return {
		...entry,
		output_schema: {
			...output,
			properties: { ...output.properties, count: { type: 'integer', minimum: 0 } }
		}
	};
};

// declared: the token outputs' timestamps are `Timestamp`s
const with_token_timestamps = (entry: Record<string, any>): Record<string, any> =>
	entry.name === 'account_token_create' || entry.name === 'account_token_list'
		? { ...entry, output_schema: with_timestamp_format(entry.output_schema) }
		: entry;

// declared: a token list row's `id` is an `ApiTokenId`
const with_token_id_pattern = (entry: Record<string, any>): Record<string, any> => {
	if (entry.name !== 'account_token_list') return entry;
	const output = entry.output_schema;
	const row = output.properties.tokens.items;
	assert.deepStrictEqual(row.properties.id, { type: 'string' });
	const id = { type: 'string', pattern: API_TOKEN_ID_REGEX.source };
	const tokens = {
		...output.properties.tokens,
		items: { ...row, properties: { ...row.properties, id } }
	};
	return { ...entry, output_schema: { ...output, properties: { ...output.properties, tokens } } };
};

const expected_entries = (head: Array<Record<string, any>>): unknown =>
	head.map(with_integer_count).map(with_token_timestamps).map(with_token_id_pattern);

describe('account surface', () => {
	const head: SurfaceCapture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
	const surface = capture_surface();
	const methods = all_account_action_specs.map((s) => s.method);

	test('the capture is of every account method, on each endpoint', () => {
		assert.deepStrictEqual(
			head.rpc.map((m) => m.name),
			methods
		);
		assert.deepStrictEqual(
			head.ws.map((m) => m.name),
			methods
		);
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

	test("the diagnostics are the capture's", () => {
		assert.deepStrictEqual(surface.diagnostics, head.diagnostics);
	});
});
