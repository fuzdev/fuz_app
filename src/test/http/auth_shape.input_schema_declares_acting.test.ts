/**
 * Unit tests for `input_schema_declares_acting`.
 *
 * Reference-equality check — the predicate looks for the canonical
 * `ActingActor` schema in the input's `.shape.acting` slot. Pinned here
 * because the dispatcher's authorization phase keys on it
 * (`actions/action_rpc.ts`, `http/route_spec.ts`,
 * `server/app_server.ts`) and registry-time invariant 2
 * (`auth.actor !== 'none' ⟺ input or query declares
 * acting?: ActingActor`) is enforced via this predicate inside
 * `assert_route_auth_acting_biconditional`. The canonical shape must
 * keep tripping the predicate — a regression here breaks both the
 * authorization phase's actor resolution and the registration-time
 * invariant assert.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {z} from 'zod';

import {input_schema_declares_acting, ActingActor} from '$lib/http/auth_shape.js';

describe('input_schema_declares_acting', () => {
	test('canonical strictObject({acting: ActingActor}) returns true', () => {
		// The audit-actor migration's standard shape — every listing-style
		// admin / role-grant-offer / account / audit spec uses this.
		const schema = z.strictObject({acting: ActingActor});
		assert.strictEqual(input_schema_declares_acting(schema), true);
	});

	test('strictObject with required field plus acting returns true', () => {
		// Mixed required + acting — admin_session_revoke_all,
		// audit_log_role_grant_history, etc. The predicate fires on any
		// object schema that has the canonical `acting` slot.
		const schema = z.strictObject({account_id: z.string(), acting: ActingActor});
		assert.strictEqual(input_schema_declares_acting(schema), true);
	});

	test('object without acting returns false', () => {
		const schema = z.strictObject({something_else: z.string()});
		assert.strictEqual(input_schema_declares_acting(schema), false);
	});

	test('object with locally-defined acting (not the canonical export) returns false', () => {
		// Reference equality — a consumer schema with an unrelated `acting`
		// field must not trip the predicate. The dispatcher's authorization
		// phase only resolves an actor when the input declares the canonical
		// `ActingActor` slot.
		const schema = z.strictObject({acting: z.string().optional()});
		assert.strictEqual(input_schema_declares_acting(schema), false);
	});

	test('z.void() input returns false', () => {
		assert.strictEqual(input_schema_declares_acting(z.void()), false);
	});

	test('z.null() input returns false', () => {
		assert.strictEqual(input_schema_declares_acting(z.null()), false);
	});

	test('non-object schema returns false', () => {
		assert.strictEqual(input_schema_declares_acting(z.string()), false);
	});

	// --- Wrapper tolerance ---
	//
	// `zod_unwrap_to_object` peels `optional` / `nullable` / `default` /
	// `transform` / `pipe` / `prefault` before the shape lookup. A spec that
	// wraps `z.strictObject({acting: ActingActor})` for any reason still
	// declares the canonical acting slot, so the dispatcher must resolve
	// the actor. A missed declaration would mean an actor-required spec
	// fails the registry-time invariant-2 assert, or — if the predicate
	// is bypassed at runtime — the handler runs without `ctx.auth`.

	test('z.optional wrapper around the canonical strictObject still returns true', () => {
		const schema = z.optional(z.strictObject({acting: ActingActor}));
		assert.strictEqual(input_schema_declares_acting(schema), true);
	});

	test('z.nullable wrapper around the canonical strictObject still returns true', () => {
		const schema = z.nullable(z.strictObject({acting: ActingActor}));
		assert.strictEqual(input_schema_declares_acting(schema), true);
	});

	test('default-wrapped strictObject still returns true', () => {
		const schema = z.strictObject({acting: ActingActor}).default({});
		assert.strictEqual(input_schema_declares_acting(schema), true);
	});

	test('wrapper around an unrelated-acting object still returns false (reference equality preserved)', () => {
		// Reference equality on `ActingActor` is the security-critical part of
		// the predicate. Wrapper peeling must not weaken it — a consumer
		// schema with a locally-defined `acting` field does not trip the
		// predicate even when wrapped.
		const schema = z.optional(z.strictObject({acting: z.string().optional()}));
		assert.strictEqual(input_schema_declares_acting(schema), false);
	});
});
