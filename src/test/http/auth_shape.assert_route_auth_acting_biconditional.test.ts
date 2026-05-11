/**
 * Unit tests for `assert_route_auth_acting_biconditional`.
 *
 * Pins registry-time invariant 2 (`auth.actor !== 'none' ⟺ some slot
 * declares acting?: ActingActor`) at the helper level. The full
 * registration loops (`apply_route_specs`, `compile_action_registry`)
 * cover the happy path via every spec they register, but the per-axis
 * shapes — the "false alarm" path (acting declared on a public spec),
 * the message-format split between REST (input or query) and actions
 * (input only), and the missing-query-slot case — are only covered
 * here. A regression in this helper would either break every keeper
 * route registration or silently let actor-required actions ship
 * without an `acting` slot.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {z} from 'zod';

import {
	ActingActor,
	assert_route_auth_acting_biconditional,
	type RouteAuth,
} from '$lib/http/auth_shape.js';

const actor_required: RouteAuth = {
	account: 'required',
	actor: 'required',
};

const public_auth: RouteAuth = {
	account: 'none',
	actor: 'none',
};

const canonical_input = z.strictObject({acting: ActingActor});

describe('assert_route_auth_acting_biconditional', () => {
	test('actor: required + acting declared on input passes', () => {
		assert.doesNotThrow(() =>
			assert_route_auth_acting_biconditional(actor_required, {input: canonical_input}, 'Test'),
		);
	});

	test('actor: required + acting declared on query passes', () => {
		// REST GETs bi-locate `acting` on `query` — declaring it on either
		// slot satisfies the invariant.
		assert.doesNotThrow(() =>
			assert_route_auth_acting_biconditional(
				actor_required,
				{input: z.null(), query: canonical_input},
				'Test',
			),
		);
	});

	test('actor: required + neither slot declares acting (REST shape) throws with input-or-query message', () => {
		// Two-slot call site (query supplied) — error message names both
		// slots so the operator knows where they can declare `acting`.
		const err = assert.throws(
			() =>
				assert_route_auth_acting_biconditional(
					actor_required,
					{input: z.null(), query: z.strictObject({other: z.string()})},
					'Route "GET /items"',
				),
			Error,
		) as unknown as Error;
		assert.match(err.message, /Route "GET \/items"/);
		assert.match(err.message, /auth\.actor === 'required'/);
		assert.match(err.message, /requires the input or query schema to declare/);
		assert.match(err.message, /registry-time invariant 2/);
	});

	test('actor: required + action shape (input-only) throws with input-only message', () => {
		// `compile_action_registry` passes `{input}` because `ActionSpec` has
		// no `query` shape. The error message must point at `input` only —
		// pointing at `query` would send the operator looking for a slot
		// that doesn't exist on their spec.
		const err = assert.throws(
			() =>
				assert_route_auth_acting_biconditional(
					actor_required,
					{input: z.null()},
					'RPC action "foo"',
				),
			Error,
		) as unknown as Error;
		assert.match(err.message, /RPC action "foo"/);
		assert.match(err.message, /auth\.actor === 'required'/);
		assert.match(err.message, /requires the input schema to declare/);
		assert.notMatch(err.message, /or query/);
	});

	test('actor: none + acting on input (REST shape) throws false-alarm with input-or-query message', () => {
		// Public spec that accidentally declares `acting?: ActingActor`.
		// Without this check, the authorization phase would not run
		// (auth.actor === 'none') but the input would carry a slot
		// suggesting it does — quiet drift.
		const err = assert.throws(
			() =>
				assert_route_auth_acting_biconditional(
					public_auth,
					{input: canonical_input, query: z.null()},
					'Test',
				),
			Error,
		) as unknown as Error;
		assert.match(err.message, /input or query schema declares 'acting\?: ActingActor'/);
		assert.match(err.message, /auth\.actor === 'none'/);
	});

	test('actor: none + acting on input (action shape) throws false-alarm with input-only message', () => {
		const err = assert.throws(
			() =>
				assert_route_auth_acting_biconditional(public_auth, {input: canonical_input}, 'Test'),
			Error,
		) as unknown as Error;
		assert.match(err.message, /input schema declares 'acting\?: ActingActor'/);
		assert.notMatch(err.message, /or query/);
	});

	test('actor: none + acting on query throws false-alarm message', () => {
		assert.throws(
			() =>
				assert_route_auth_acting_biconditional(
					public_auth,
					{input: z.null(), query: canonical_input},
					'Test',
				),
			/declares 'acting\?: ActingActor'/,
		);
	});

	test('actor: none + neither slot declares acting passes', () => {
		assert.doesNotThrow(() =>
			assert_route_auth_acting_biconditional(public_auth, {input: z.null()}, 'Test'),
		);
	});

	test('actor: none + query explicitly undefined passes', () => {
		// REST mutations call apply_route_specs with `{input, query: spec.query}`
		// where `spec.query` is undefined. The helper must treat that as
		// "no query slot" rather than tripping on the property's presence.
		assert.doesNotThrow(() =>
			assert_route_auth_acting_biconditional(
				public_auth,
				{input: z.null(), query: undefined},
				'Test',
			),
		);
	});

	test('actor: optional + acting declared passes (optional counts as needs-actor)', () => {
		// `needs_actor` treats `'optional'` like `'required'` — the
		// dispatcher's authorization phase runs when the spec might
		// produce an actor binding, and the input must carry `acting`
		// so the phase has something typed to read.
		assert.doesNotThrow(() =>
			assert_route_auth_acting_biconditional(
				{account: 'required', actor: 'optional'},
				{input: canonical_input},
				'Test',
			),
		);
	});

	test('actor: optional + acting missing throws', () => {
		assert.throws(
			() =>
				assert_route_auth_acting_biconditional(
					{account: 'required', actor: 'optional'},
					{input: z.null()},
					'Test',
				),
			/auth\.actor === 'optional'/,
		);
	});

	test('context string appears verbatim in both error branches', () => {
		const context = 'action.contrived_method';
		const missing_err = assert.throws(
			() => assert_route_auth_acting_biconditional(actor_required, {input: z.null()}, context),
			Error,
		) as unknown as Error;
		assert.match(missing_err.message, new RegExp(`^${context}:`));
		const false_alarm_err = assert.throws(
			() =>
				assert_route_auth_acting_biconditional(public_auth, {input: canonical_input}, context),
			Error,
		) as unknown as Error;
		assert.match(false_alarm_err.message, new RegExp(`^${context}:`));
	});
});
