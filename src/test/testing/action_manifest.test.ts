/**
 * Unit tests for `build_action_manifest` — the spec → normalized
 * `ActionManifestEntry` mapper the cross-impl manifest-parity gate dumps.
 *
 * Pins the normalization contract both impls must match: `input` reads
 * `'void'` for a void input (`s.void`) and `'object'`
 * for anything else, auth axes pass through, `roles` / `credential_types` flatten to sorted arrays (absent and
 * empty both → `[]`), `side_effects` passes through, `rate_limit` is always
 * present (`null` when undeclared), and entries sort by `method`. A drift in
 * any of these would surface as a spurious cross-impl diff, so they're pinned
 * here in-process.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { is, object, string, void as fuz_void, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';

import {
	ActionManifestEntry,
	action_manifest_entry,
	build_action_manifest
} from '#lib/testing/cross_backend/action_manifest.ts';
import type { RouteAuth } from '#lib/http/auth_shape.ts';
import type { RateLimitKey } from '#lib/rate_limiter.ts';
import { all_room_action_specs } from '#lib/actions/room_action_specs.ts';
import { build_full_spine_rpc_actions } from '#lib/testing/cross_backend/full_spine_mount.ts';
import { create_stub_app_deps } from '#lib/testing/stubs.ts';

const spec = (
	method: string,
	auth: RouteAuth,
	side_effects = false,
	rate_limit?: RateLimitKey,
	input: AnySchema = object({})
): {
	method: string;
	input: AnySchema;
	auth: RouteAuth;
	side_effects: boolean;
	rate_limit?: RateLimitKey;
} => ({ method, input, auth, side_effects, rate_limit });

describe('action_manifest_entry', () => {
	test('passes the auth axes + side_effects through', () => {
		const entry = action_manifest_entry(
			spec(
				'admin_account_list',
				{ account: 'required', actor: 'required', roles: ['admin'] },
				false
			)
		);
		assert.deepStrictEqual(entry, {
			method: 'admin_account_list',
			input: 'object',
			side_effects: false,
			account: 'required',
			actor: 'required',
			roles: ['admin'],
			credential_types: [],
			rate_limit: null
		});
	});

	test('an undeclared rate_limit normalizes to an explicit null, never absent', () => {
		const entry = action_manifest_entry(
			spec('account_verify', { account: 'required', actor: 'none' })
		);
		assert.strictEqual(entry.rate_limit, null);
		// The column is required, not optional: a backend that omits it fails
		// the manifest capture's strict parse rather than reading as a default.
		const { rate_limit: _omitted, ...without_rate_limit } = entry;
		assert.ok(!is(ActionManifestEntry, without_rate_limit));
	});

	test('a declared rate_limit class passes through', () => {
		for (const key of ['ip', 'account', 'both'] as const) {
			const entry = action_manifest_entry(
				spec('x', { account: 'required', actor: 'none' }, false, key)
			);
			assert.strictEqual(entry.rate_limit, key);
		}
	});

	test('absent roles + credential_types normalize to empty arrays', () => {
		const entry = action_manifest_entry(
			spec('account_verify', { account: 'required', actor: 'none' })
		);
		assert.deepStrictEqual(entry.roles, []);
		assert.deepStrictEqual(entry.credential_types, []);
	});

	test('roles + credential_types are sorted (order-independent across impls)', () => {
		const entry = action_manifest_entry(
			spec('x', {
				account: 'required',
				actor: 'required',
				roles: ['keeper', 'admin'],
				credential_types: ['session', 'daemon_token']
			})
		);
		assert.deepStrictEqual(entry.roles, ['admin', 'keeper']);
		assert.deepStrictEqual(entry.credential_types, ['daemon_token', 'session']);
	});

	test('a void input is void and every other input is an object', () => {
		const auth: RouteAuth = { account: 'required', actor: 'none' };
		const entry_input = (input: AnySchema) =>
			action_manifest_entry(spec('x', auth, false, undefined, input)).input;
		assert.strictEqual(entry_input(fuz_void), 'void');
		assert.strictEqual(entry_input(meta(fuz_void, { description: 'no params' })), 'void');
		// `object({})` admits the same calls but is an object schema
		for (const input of [object({}), object({ id: string })]) {
			assert.strictEqual(entry_input(input), 'object');
		}
	});

	test('side_effects passes through for mutations', () => {
		const entry = action_manifest_entry(
			spec('account_token_create', { account: 'required', actor: 'none' }, true)
		);
		assert.strictEqual(entry.side_effects, true);
	});
});

describe('build_action_manifest', () => {
	test('empty input produces an empty manifest', () => {
		assert.deepStrictEqual(build_action_manifest([]), { methods: [] });
	});

	test('entries are sorted by method (byte-lexicographic, matching the Rust stub)', () => {
		const manifest = build_action_manifest([
			spec('zebra', { account: 'none', actor: 'none' }),
			spec('alpha', { account: 'none', actor: 'none' }),
			spec('_testing_action_manifest', {
				account: 'required',
				actor: 'none',
				credential_types: ['daemon_token']
			})
		]);
		assert.deepStrictEqual(
			manifest.methods.map((m) => m.method),
			['_testing_action_manifest', 'alpha', 'zebra']
		);
	});
});

describe('the transport key', () => {
	test('a WebSocket-only method says so; every other entry has no `transport` key', () => {
		const manifest = build_action_manifest(
			[spec('zeta_read', { account: 'required', actor: 'none' })],
			[spec('room_send', { account: 'required', actor: 'required' })]
		);
		const [room_send, zeta_read] = manifest.methods;
		assert.strictEqual(room_send?.transport, 'ws');
		// the key set of a both-transport entry is the one a consumer's published
		// schema parses, exactly — as the Rust stub's entry pins it
		assert.deepStrictEqual(Object.keys(zeta_read!).sort(), [
			'account',
			'actor',
			'credential_types',
			'input',
			'method',
			'rate_limit',
			'roles',
			'side_effects'
		]);
		assert.ok(is(ActionManifestEntry, room_send));
		assert.ok(is(ActionManifestEntry, zeta_read));
		assert.notOk(is(ActionManifestEntry, { ...zeta_read, transport: 'both' }));
	});

	test("the spine's full mount lists the room verbs as WebSocket-only, and nothing else", async () => {
		const actions = build_full_spine_rpc_actions(create_stub_app_deps(), {
			daemon_token_state: {
				current_token: 'stub',
				previous_token: null,
				rotated_at: new Date(0),
				keeper_account_id: null
			}
		});
		const manifest_action = actions.find((a) => a.spec.method === '_testing_action_manifest')!;
		const manifest = (await manifest_action.handler(undefined, {} as never)) as {
			methods: Array<ActionManifestEntry>;
		};
		const ws_only = manifest.methods.filter((m) => m.transport === 'ws').map((m) => m.method);
		assert.deepStrictEqual(ws_only.sort(), all_room_action_specs.map((s) => s.method).sort());
		for (const room_spec of all_room_action_specs) {
			const entry = manifest.methods.find((m) => m.method === room_spec.method);
			assert.deepStrictEqual(entry, {
				method: room_spec.method,
				input: 'object',
				side_effects: false,
				account: 'required',
				actor: 'required',
				roles: [],
				credential_types: [],
				rate_limit: 'rate_limit' in room_spec ? room_spec.rate_limit : null,
				transport: 'ws'
			});
		}
		// the room verbs stay off the RPC endpoint
		for (const room_spec of all_room_action_specs) {
			assert.notOk(
				actions.some((a) => a.spec.method === room_spec.method),
				room_spec.method
			);
		}
		assert.notProperty(
			manifest.methods.find((m) => m.method === '_testing_room_evict'),
			'transport'
		);
	});
});
