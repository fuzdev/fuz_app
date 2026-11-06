/**
 * The role_grant_offer domain's surface, held to the Zod-era one captured in
 * `fixtures/surface/role_grant_offer.json`: the RPC and WS entries of the
 * methods, the notifications as event specs, and the diagnostics. Equal as
 * JSON apart from the declared moves, each applied to the capture here:
 *
 * - the offer's `scope_kind` is a `ScopeKindName` or `null` on every output
 *   side, so its node gains the grammar's `maxLength` and `pattern`
 * - the offer's timestamps are `Timestamp`s, so each node gains
 *   `format: 'date-time'` and the `iso_datetime` `pattern`, the nullable ones
 *   as an `anyOf` with `null`
 * - the revokee's notification is renamed from `role_grant_revoke`, the admin
 *   action's method, to `role_grant_revoked`, and its params gain a required
 *   `scope_kind`, beside `scope_id`
 * - the `check` that pairs `scope_kind` with `scope_id` on the create and
 *   assign inputs has no JSON Schema form, an `info` diagnostic on each
 * - the WS endpoint lists the role_grant_offer notifications after the
 *   actions, as `remote_notification` methods
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { readFileSync } from 'node:fs';

import { all_role_grant_offer_action_specs } from '#lib/auth/role_grant_offer_action_specs.ts';
import {
	role_grant_offer_notification_actions,
	role_grant_offer_notification_specs,
	ROLE_GRANT_REVOKED_NOTIFICATION_METHOD
} from '#lib/auth/role_grant_offer_notifications.ts';
import { to_ws_actions, protocol_actions } from '#lib/actions/protocol.ts';
import type { ResolvedWsEndpointSpec } from '#lib/actions/ws_endpoint_spec.ts';
import { generate_app_surface, type AppSurfaceDiagnostic } from '#lib/http/surface.ts';
import { NAME_LENGTH_MAX, NAME_REGEX } from '#lib/auth/name_schema.ts';

import { with_timestamp_format } from '../surface_test_helpers.ts';

const FIXTURE_PATH = new URL('../fixtures/surface/role_grant_offer.json', import.meta.url);

interface SurfaceCapture {
	rpc: Array<Record<string, unknown>>;
	ws: Array<Record<string, unknown>>;
	events: Array<{ method: string; params_schema: unknown }>;
	diagnostics: Array<AppSurfaceDiagnostic>;
}

const METHODS: ReadonlySet<string> = new Set(
	all_role_grant_offer_action_specs.map((s) => s.method)
);

const capture_surface = () => {
	const actions = all_role_grant_offer_action_specs.map((spec) => ({ spec, handler: () => null }));
	const ws_endpoint: ResolvedWsEndpointSpec = {
		path: '/ws',
		allowed_origins: [],
		actions: to_ws_actions(actions)
	};
	const surface = generate_app_surface({
		route_specs: [],
		middleware_specs: [],
		rpc_endpoints: [{ path: '/api/rpc', actions }],
		ws_endpoints: [ws_endpoint],
		event_specs: role_grant_offer_notification_specs
	});
	return surface;
};

/** The JSON Schema of `nullable(ScopeKindName)`, `ScopeKindName`'s with a `null` beside it. */
const NULLABLE_SCOPE_KIND = {
	anyOf: [
		{ type: 'string', maxLength: NAME_LENGTH_MAX, pattern: NAME_REGEX.source },
		{ type: 'null' }
	]
};

// declared: every offer's `scope_kind` node, `z.string().nullable()` at capture,
// gains the grammar; the node is found by its Zod-era form
const with_strict_scope_kind = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(with_strict_scope_kind);
	if (typeof value !== 'object' || value === null) return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (
			key === 'scope_kind' &&
			JSON.stringify((child as { type?: unknown }).type) === '["string","null"]'
		) {
			const { type: _, ...rest } = child as Record<string, unknown>;
			out[key] = { ...rest, ...NULLABLE_SCOPE_KIND };
		} else {
			out[key] = with_strict_scope_kind(child);
		}
	}
	return out;
};

/** The scope_kind and the timestamp moves, which every entry and event takes. */
const with_declared_moves = (value: unknown): unknown =>
	with_timestamp_format(with_strict_scope_kind(value));

// the method the revokee's notification had in the capture, the admin action's
const HEAD_REVOKE_NOTIFICATION_METHOD = 'role_grant_revoke';

// declared: the revoke notification's params gain a required `scope_kind` before `scope_id`
const with_revoke_scope_kind = (params_schema: any): unknown => {
	const properties: Record<string, unknown> = {};
	for (const [key, node] of Object.entries(params_schema.properties)) {
		if (key === 'scope_id') properties.scope_kind = NULLABLE_SCOPE_KIND;
		properties[key] = node;
	}
	const required = (params_schema.required as Array<string>).flatMap((key) =>
		key === 'scope_id' ? ['scope_kind', key] : [key]
	);
	return { ...params_schema, properties, required };
};

const check_diagnostic = (source: string): AppSurfaceDiagnostic => ({
	level: 'info',
	category: 'schema',
	message:
		'Part of the schema has no JSON Schema form and is left out or written as {} there: cannot express `check` at #: it holds a function',
	source
});

describe('role_grant_offer surface', () => {
	const head: SurfaceCapture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
	const surface = capture_surface();

	test('the capture is of the eight methods and the six notifications', () => {
		assert.deepStrictEqual(
			head.rpc.map((m) => m.name),
			[...METHODS]
		);
		assert.deepStrictEqual(
			head.ws.map((m) => m.name),
			[...METHODS]
		);
		assert.deepStrictEqual(
			head.events.map((e) =>
				e.method === HEAD_REVOKE_NOTIFICATION_METHOD
					? ROLE_GRANT_REVOKED_NOTIFICATION_METHOD
					: e.method
			),
			role_grant_offer_notification_specs.map((e) => e.method)
		);
		assert.deepStrictEqual(head.diagnostics, []);
	});

	test('the RPC entries are the Zod-era ones but for the declared moves', () => {
		assert.deepStrictEqual(surface.rpc_endpoints[0]!.methods, with_declared_moves(head.rpc));
	});

	test('the events are the Zod-era ones but for the declared moves', () => {
		const expected = (with_declared_moves(head.events) as SurfaceCapture['events']).map((e) =>
			e.method === HEAD_REVOKE_NOTIFICATION_METHOD
				? {
						...e,
						method: ROLE_GRANT_REVOKED_NOTIFICATION_METHOD,
						params_schema: with_revoke_scope_kind(e.params_schema)
					}
				: e
		);
		assert.deepStrictEqual(surface.events, expected);
	});

	test('the WS entries are the Zod-era ones, then the notifications', () => {
		const methods = surface.ws_endpoints[0]!.methods;
		const protocol = protocol_actions.length;
		assert.deepStrictEqual(
			methods.slice(protocol, protocol + METHODS.size),
			with_declared_moves(head.ws)
		);
		const notifications = methods.slice(protocol + METHODS.size);
		// every notification, `role_grant_revoked` among them
		assert.deepStrictEqual(
			notifications.map((m) => m.name),
			role_grant_offer_notification_actions.map((a) => a.spec.method)
		);
		assert.include(
			notifications.map((m) => m.name),
			ROLE_GRANT_REVOKED_NOTIFICATION_METHOD
		);
		for (const entry of notifications) {
			const event = surface.events.find((e) => e.method === entry.name)!;
			assert.deepStrictEqual(entry, {
				name: entry.name,
				kind: 'remote_notification',
				auth: null,
				input_schema: event.params_schema,
				output_schema: null,
				description: event.description,
				side_effects: true,
				rate_limit_key: null
			});
		}
	});

	test('the diagnostics are the pairing check of each grant input', () => {
		assert.deepStrictEqual(surface.diagnostics, [
			check_diagnostic('/api/rpc role_grant_offer_create input'),
			check_diagnostic('/api/rpc role_grant_assign input'),
			check_diagnostic('/ws role_grant_offer_create input'),
			check_diagnostic('/ws role_grant_assign input')
		]);
	});
});

describe('to_ws_actions without the role_grant_offer actions', () => {
	test('appends no notification to an RPC list that lacks role_grant_offer_create', () => {
		const others = all_role_grant_offer_action_specs
			.filter((spec) => spec.method !== 'role_grant_offer_create')
			.map((spec) => ({ spec, handler: () => null }));
		for (const rpc of [[], others]) {
			assert.deepStrictEqual(
				to_ws_actions(rpc).map((a) => a.spec.method),
				[...protocol_actions, ...rpc].map((a) => a.spec.method)
			);
		}
	});
});
