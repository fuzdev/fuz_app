/**
 * Cross-registry property test for action spec input shapes.
 *
 * The asymmetry "schema accepts `{}` but rejects `undefined`" is a bug
 * class. `action_codegen.ts:430-431` probes both — when only `{}` parses,
 * the typed `FrontendActionsApi` method signature emits `input:` required.
 * Adapter authors then write `() => api.foo()` (no args) and trip
 * `ActionEvent.parse` because `safeParse(undefined)` fails before the
 * call reaches the wire (`to_jsonrpc_params` only normalizes on the
 * wire side, which the client-side parse never reaches).
 *
 * Two principled fixes; this test passes when either applies:
 *
 * - `.default({})` at the schema root — when `{}` is a meaningful call
 *   (no-arg list/get). `safeParse(undefined)` then succeeds.
 * - `.refine(...)` to reject `{}` — when empty is meaningless and the
 *   caller must supply data. The typed surface correctly reports
 *   `input:` required and the handler's runtime check becomes
 *   redundant-but-defensive.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {all_admin_action_specs} from '$lib/auth/admin_action_specs.js';
import {all_role_grant_offer_action_specs} from '$lib/auth/role_grant_offer_action_specs.js';
import {all_account_action_specs} from '$lib/auth/account_action_specs.js';
import {all_self_service_role_action_specs} from '$lib/auth/self_service_role_action_specs.js';
import {all_actor_lookup_action_specs} from '$lib/auth/actor_lookup_action_specs.js';
import {protocol_action_specs} from '$lib/actions/protocol.js';

describe('action spec input invariants', () => {
	test('every spec input that accepts {} also accepts undefined', () => {
		const all_specs = [
			...all_admin_action_specs,
			...all_role_grant_offer_action_specs,
			...all_account_action_specs,
			...all_self_service_role_action_specs,
			...all_actor_lookup_action_specs,
			...protocol_action_specs,
		];
		for (const spec of all_specs) {
			const accepts_empty = spec.input.safeParse({}).success;
			if (!accepts_empty) continue;
			const accepts_undefined = spec.input.safeParse(undefined).success;
			assert.ok(
				accepts_undefined,
				`${spec.method}: input accepts {} but rejects undefined — apply .default({}) at the schema root (or .refine() if {} should be rejected too)`,
			);
		}
	});
});
