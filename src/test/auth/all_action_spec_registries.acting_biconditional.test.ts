/**
 * Registry-time invariant 2 — walked at spec-layer time, not at handler
 * registration.
 *
 * The biconditional `auth.actor !== 'none' ⟺ input declares
 * acting?: ActingActor` is enforced at `rpc_action()` binding via
 * `assert_route_auth_acting_biconditional` (see
 * `http/auth_shape.ts`). That throw fires when the handler-
 * factory module is first imported — too late to fail `gro test` before
 * an action-handler test file pulls in the module.
 *
 * This walker iterates `all_fuz_auth_action_spec_registries`
 * (spec-only modules with no handler-side imports) and asserts the
 * biconditional per spec, so violations surface at suite collection
 * regardless of whether any handler test happens to import the broken
 * registry.
 *
 * Detection is `input_schema_declares_acting` from `http/auth_shape.ts`,
 * the check the registration assertion runs, so this test rejects exactly
 * what that assertion would.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { all_fuz_auth_action_spec_registries } from '#lib/auth/all_action_spec_registries.ts';
import { input_schema_declares_acting, needs_actor } from '#lib/http/auth_shape.ts';

describe('fuz_auth registries — acting biconditional', () => {
	for (const registry of all_fuz_auth_action_spec_registries) {
		test(`${
			registry.name
		}: every spec satisfies auth.actor !== 'none' ⟺ input declares acting?: ActingActor`, () => {
			for (const spec of registry.specs) {
				const wants_actor = needs_actor(spec.auth);
				const declares_acting = input_schema_declares_acting(spec.input);
				assert.strictEqual(
					declares_acting,
					wants_actor,
					`${spec.method}: auth.actor=${spec.auth.actor} but input ${
						declares_acting ? 'declares' : 'omits'
					} acting`
				);
			}
		});
	}
});
