/**
 * Unit tests for `input_schema_declares_acting`.
 *
 * Reference-equality check — the predicate looks for the canonical
 * `ActingActor` schema in the input's `acting` entry. Pinned here
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
import { meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	literal,
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
	input_schema_declares_acting
} from '#lib/http/auth_shape.ts';
import { ACTING_ACTOR_DESCRIPTION, ActingActor, Uuid } from '#lib/primitive_schemas.ts';

describe('input_schema_declares_acting', () => {
	test('the canonical object({acting: ActingActor}) declares acting', () => {
		// The audit-actor migration's standard shape — every listing-style
		// admin / role-grant-offer / account / audit spec uses this.
		assert.strictEqual(input_schema_declares_acting(object({ acting: ActingActor })), true);
	});

	test('an object with a required field beside acting declares acting', () => {
		// Mixed required + acting — admin_session_revoke_all,
		// audit_log_role_grant_history, etc. The predicate fires on any
		// object schema that has the canonical `acting` entry.
		assert.strictEqual(
			input_schema_declares_acting(object({ account_id: string, acting: ActingActor })),
			true
		);
		assert.strictEqual(
			input_schema_declares_acting(loose_object({ id: string, acting: ActingActor })),
			true
		);
	});

	test('an input without the canonical acting declares no acting', () => {
		assert.strictEqual(input_schema_declares_acting(fuz_void), false);
		assert.strictEqual(input_schema_declares_acting(literal(null)), false);
		assert.strictEqual(input_schema_declares_acting(string), false);
		assert.strictEqual(input_schema_declares_acting(object({ something_else: string })), false);
		assert.strictEqual(input_schema_declares_acting(object({ other: ActingActor })), false);
	});

	test('an object with a locally-defined acting declares no acting', () => {
		// Reference equality — a consumer schema with an unrelated `acting`
		// field must not trip the predicate. The dispatcher's authorization
		// phase only resolves an actor when the input declares the canonical
		// `ActingActor` entry.
		assert.strictEqual(input_schema_declares_acting(object({ acting: optional(string) })), false);
	});

	test('a copy of ActingActor declares no acting: only the canonical schema is matched', () => {
		// a schema built the same way is another object, and no declaration
		const copy = meta(optional(Uuid), { description: ACTING_ACTOR_DESCRIPTION });
		assert.strictEqual(input_schema_declares_acting(object({ acting: copy })), false);
	});

	// --- Wrapper tolerance ---
	//
	// `get_schema_entries` sees through `optional` / `nullable` / the
	// defaults and a `pipe` to the schema it starts with. A spec that wraps
	// `object({acting: ActingActor})` for any reason still declares the
	// canonical acting entry, so the dispatcher must resolve the actor. A
	// missed declaration would mean an actor-required spec fails the
	// registry-time invariant-2 assert, or — if the predicate is bypassed at
	// runtime — the handler runs without `ctx.auth`.

	test('a wrapped object declaring ActingActor declares acting', () => {
		assert.strictEqual(
			input_schema_declares_acting(optional(object({ acting: ActingActor }))),
			true
		);
		assert.strictEqual(
			input_schema_declares_acting(nullable(object({ acting: ActingActor }))),
			true
		);
		assert.strictEqual(
			input_schema_declares_acting(with_default(object({ acting: ActingActor }), {})),
			true
		);
		// and a pipe that starts with the object
		assert.strictEqual(
			input_schema_declares_acting(
				pipe(
					object({ acting: ActingActor }),
					transform((v) => v)
				)
			),
			true
		);
	});

	test('a wrapper around an unrelated-acting object declares no acting', () => {
		// Reference equality on `ActingActor` is the security-critical part of
		// the predicate. Wrapper peeling must not weaken it — a consumer
		// schema with a locally-defined `acting` field does not trip the
		// predicate even when wrapped.
		assert.strictEqual(
			input_schema_declares_acting(optional(object({ acting: optional(string) }))),
			false
		);
	});

	test('a void input passes the biconditional on actor: none and refuses it otherwise', () => {
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
			/to declare 'acting\?: ActingActor'/
		);
	});

	test('an input declaring ActingActor passes on actor: required and refuses actor: none', () => {
		const input = object({ acting: ActingActor });
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
			/declares 'acting\?: ActingActor'.* but auth\.actor === 'none'/
		);
		assert.throws(
			() =>
				assert_route_auth_acting_biconditional(
					{ account: 'required', actor: 'none' },
					{ input: literal(null), query: input },
					'test'
				),
			/input or query schema declares/
		);
	});
});
