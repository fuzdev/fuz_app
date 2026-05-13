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
 * Iterates `all_fuz_auth_action_spec_registries` (auth-domain registries)
 * plus `protocol_action_specs` (transport-level — excluded from the
 * auth-domain registry-of-registries). A new auth-domain bundle picked
 * up via the registry list is covered automatically; a new
 * transport-level wire bundle must be spread here explicitly.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {all_fuz_auth_action_spec_registries} from '$lib/auth/all_action_spec_registries.js';
import {protocol_action_specs} from '$lib/actions/protocol.js';

describe('action spec input invariants', () => {
	test('every spec input that accepts {} also accepts undefined', () => {
		const all_specs = [
			...all_fuz_auth_action_spec_registries.flatMap((r) => r.specs),
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
