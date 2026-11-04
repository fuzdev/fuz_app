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

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import {
	loose_object,
	nullable,
	object,
	optional,
	pipe,
	string,
	transform,
	void as fuz_void,
	with_default
} from '@fuzdev/fuz_schema/schema.ts';

import {
	assert_route_auth_acting_biconditional,
	input_schema_declares_acting,
	ActingActor
} from '#lib/http/auth_shape.ts';
import { ActingActor as ActingActorFuz } from '#lib/primitive_schemas_fuz.ts';

describe('input_schema_declares_acting', () => {
	test('canonical strictObject({acting: ActingActor}) returns true', () => {
		// The audit-actor migration's standard shape — every listing-style
		// admin / role-grant-offer / account / audit spec uses this.
		const schema = z.strictObject({ acting: ActingActor });
		assert.strictEqual(input_schema_declares_acting(schema), true);
	});

	test('strictObject with required field plus acting returns true', () => {
		// Mixed required + acting — admin_session_revoke_all,
		// audit_log_role_grant_history, etc. The predicate fires on any
		// object schema that has the canonical `acting` slot.
		const schema = z.strictObject({ account_id: z.string(), acting: ActingActor });
		assert.strictEqual(input_schema_declares_acting(schema), true);
	});

	test('object without acting returns false', () => {
		const schema = z.strictObject({ something_else: z.string() });
		assert.strictEqual(input_schema_declares_acting(schema), false);
	});

	test('object with locally-defined acting (not the canonical export) returns false', () => {
		// Reference equality — a consumer schema with an unrelated `acting`
		// field must not trip the predicate. The dispatcher's authorization
		// phase only resolves an actor when the input declares the canonical
		// `ActingActor` slot.
		const schema = z.strictObject({ acting: z.string().optional() });
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
		const schema = z.optional(z.strictObject({ acting: ActingActor }));
		assert.strictEqual(input_schema_declares_acting(schema), true);
	});

	test('z.nullable wrapper around the canonical strictObject still returns true', () => {
		const schema = z.nullable(z.strictObject({ acting: ActingActor }));
		assert.strictEqual(input_schema_declares_acting(schema), true);
	});

	test('default-wrapped strictObject still returns true', () => {
		const schema = z.strictObject({ acting: ActingActor }).default({});
		assert.strictEqual(input_schema_declares_acting(schema), true);
	});

	test('wrapper around an unrelated-acting object still returns false (reference equality preserved)', () => {
		// Reference equality on `ActingActor` is the security-critical part of
		// the predicate. Wrapper peeling must not weaken it — a consumer
		// schema with a locally-defined `acting` field does not trip the
		// predicate even when wrapped.
		const schema = z.optional(z.strictObject({ acting: z.string().optional() }));
		assert.strictEqual(input_schema_declares_acting(schema), false);
	});

	test('a fuz_schema input without the twin declares no acting', () => {
		assert.strictEqual(input_schema_declares_acting(fuz_void), false);
		assert.strictEqual(input_schema_declares_acting(string), false);
		assert.strictEqual(input_schema_declares_acting(object({ acting: optional(string) })), false);
		assert.strictEqual(input_schema_declares_acting(object({ other: ActingActorFuz })), false);
	});

	test('a fuz_schema object declaring the twin ActingActor declares acting', () => {
		assert.strictEqual(input_schema_declares_acting(object({ acting: ActingActorFuz })), true);
		assert.strictEqual(
			input_schema_declares_acting(loose_object({ id: string, acting: ActingActorFuz })),
			true
		);
		// through the wrappers `get_schema_entries` sees through
		assert.strictEqual(
			input_schema_declares_acting(optional(object({ acting: ActingActorFuz }))),
			true
		);
		assert.strictEqual(
			input_schema_declares_acting(nullable(object({ acting: ActingActorFuz }))),
			true
		);
		assert.strictEqual(
			input_schema_declares_acting(with_default(object({ acting: ActingActorFuz }), {})),
			true
		);
		// and a pipe that starts with the object, as Zod's peels a pipe
		assert.strictEqual(
			input_schema_declares_acting(
				pipe(
					object({ acting: ActingActorFuz }),
					transform((v) => v)
				)
			),
			true
		);
	});

	test('each library finds its own twin only', () => {
		// reference equality per library: the Zod `ActingActor` in a fuz_schema
		// object, or the twin in a Zod one, is no declaration
		assert.strictEqual(
			input_schema_declares_acting(object({ acting: ActingActor as unknown as typeof string })),
			false
		);
		assert.strictEqual(
			input_schema_declares_acting(
				z.strictObject({ acting: ActingActorFuz as unknown as z.ZodOptional<z.ZodString> })
			),
			false
		);
	});

	test('a fuz_schema void input passes the biconditional on actor: none and refuses it otherwise', () => {
		assert_route_auth_acting_biconditional(
			{ account: 'none', actor: 'none' },
			{ input: fuz_void },
			'test'
		);
		assert.throws(
			() =>
				assert_route_auth_acting_biconditional(
					{ account: 'required', actor: 'required' },
					{ input: fuz_void },
					'test'
				),
			/to declare 'acting\?: ActingActor', the Zod one or its fuz_schema twin/
		);
	});

	test('a fuz_schema input declaring the twin passes on actor: required and refuses actor: none', () => {
		const input = object({ acting: ActingActorFuz });
		assert_route_auth_acting_biconditional(
			{ account: 'required', actor: 'required' },
			{ input },
			'test'
		);
		assert_route_auth_acting_biconditional(
			{ account: 'required', actor: 'optional' },
			{ input },
			'test'
		);
		assert.throws(
			() =>
				assert_route_auth_acting_biconditional(
					{ account: 'none', actor: 'none' },
					{ input },
					'test'
				),
			/declares 'acting\?: ActingActor' \(Zod or fuz_schema\) but auth\.actor === 'none'/
		);
		assert.throws(
			() =>
				assert_route_auth_acting_biconditional(
					{ account: 'required', actor: 'none' },
					{ input: z.null(), query: input },
					'test'
				),
			/input or query schema declares/
		);
	});
});
