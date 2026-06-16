/**
 * Spec-level gate check for the `_testing_*` backdoor actions.
 *
 * The six test-binary actions (`_testing_reset`, `_testing_mint_session`,
 * `_testing_put_fact`, `_testing_drain_effects`, `_testing_schema_snapshot`,
 * `_testing_action_manifest`) are privileged: they run direct DB writes or
 * dump internal state the production wire never exposes. Their only structural
 * fence is the daemon-token credential gate
 * on every spec's `auth` axis. This test pins that wiring directly — the
 * dispatcher's *enforcement* of the gate is covered behaviorally
 * (cross-process via `describe_testing_backdoor_cross_tests`, and indirectly
 * via the `account_purge` credential-ceiling conformance rows), but nothing
 * else asserts that each `_testing_*` spec actually *declares* the gate. A
 * future edit that loosened one spec's `credential_types` would slip past
 * the behavioral suites for any method they don't exhaustively enumerate;
 * this characterization test fails loud instead.
 *
 * @module
 */

import {test, assert, describe} from 'vitest';

import {
	testing_reset_action_spec,
	testing_mint_session_action_spec,
	testing_put_fact_action_spec,
	testing_drain_effects_action_spec,
	testing_schema_snapshot_action_spec,
	testing_action_manifest_action_spec,
} from '$lib/testing/cross_backend/testing_reset_actions.ts';
import type {RequestResponseActionSpec} from '$lib/actions/action_spec.ts';

const testing_action_specs: ReadonlyArray<{name: string; spec: RequestResponseActionSpec}> = [
	{name: '_testing_reset', spec: testing_reset_action_spec},
	{name: '_testing_mint_session', spec: testing_mint_session_action_spec},
	{name: '_testing_put_fact', spec: testing_put_fact_action_spec},
	{name: '_testing_drain_effects', spec: testing_drain_effects_action_spec},
	{name: '_testing_schema_snapshot', spec: testing_schema_snapshot_action_spec},
	{name: '_testing_action_manifest', spec: testing_action_manifest_action_spec},
];

describe('_testing_* backdoor action specs carry the daemon-token gate', () => {
	for (const {name, spec} of testing_action_specs) {
		test(`${name} gates on the daemon-token credential only`, () => {
			// The method name carries the reserved backdoor prefix.
			assert.ok(spec.method.startsWith('_testing_'), `${name}: method must start with _testing_`);
			// account: required + actor: none + credential_types: ['daemon_token']
			// is the keeper-only fence — a session / api_token / anonymous caller
			// is refused before any handler logic runs (see security.md
			// §Test Backdoor Actions).
			assert.strictEqual(spec.auth.account, 'required', `${name}: auth.account`);
			assert.strictEqual(spec.auth.actor, 'none', `${name}: auth.actor`);
			assert.deepStrictEqual(
				spec.auth.credential_types,
				['daemon_token'],
				`${name}: auth.credential_types must be exactly ['daemon_token']`,
			);
		});
	}
});

describe('_testing_mint_session can only mint already-expired sessions', () => {
	// The backdoor is daemon-token + loopback + DEV gated, but minting a
	// *valid* session for an arbitrary account_id is more power than its sole
	// use (the `expired_session` conformance principal) needs. Constrain the
	// input so the action is, by construction, incapable of forging a usable
	// session — it can only produce a backdated, already-dead row.
	const valid_input = {account_id: '00000000-0000-0000-0000-000000000000', expires_in_seconds: -60};

	test('accepts a negative expiry (backdated, already-expired row)', () => {
		const parsed = testing_mint_session_action_spec.input.safeParse(valid_input);
		assert.ok(
			parsed.success,
			`negative expiry must parse: ${JSON.stringify(parsed.error?.issues)}`,
		);
	});

	test('rejects a positive expiry (would mint a valid session)', () => {
		const parsed = testing_mint_session_action_spec.input.safeParse({
			...valid_input,
			expires_in_seconds: 60,
		});
		assert.ok(
			!parsed.success,
			'a positive expiry must be rejected — the backdoor must not mint a valid session',
		);
	});

	test('rejects a zero expiry', () => {
		const parsed = testing_mint_session_action_spec.input.safeParse({
			...valid_input,
			expires_in_seconds: 0,
		});
		assert.ok(!parsed.success, 'a zero expiry must be rejected');
	});
});
