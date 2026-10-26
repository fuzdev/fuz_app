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
 * One exemption, by design: an input marked `empty_input_handler_guarded`
 * (`SchemaFieldMeta` — today `cell_get`, `cell_field_list`, `cell_item_list`)
 * accepts `{}` at the schema and rejects `undefined`, because the handler
 * refuses `{}` with a declared reason; codegen keeps its input required
 * (`action_input_is_optional`). The test holds each marked input to that
 * shape, and holds codegen's rule to the invariant for every spec.
 *
 * Iterates `all_fuz_auth_action_spec_registries` (auth-domain registries),
 * the cell registries (opt-in, outside the auth-domain list), plus
 * `protocol_action_specs` (transport-level — excluded from the
 * auth-domain registry-of-registries). A new auth-domain bundle picked
 * up via the registry list is covered automatically; a new cell or
 * transport-level wire bundle must be spread here explicitly.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { all_fuz_auth_action_spec_registries } from '#lib/auth/all_action_spec_registries.ts';
import { protocol_action_specs } from '#lib/actions/protocol.ts';
import { action_input_is_optional } from '#lib/actions/action_codegen.ts';
import { is_empty_input_handler_guarded } from '#lib/schema_meta.ts';
import { all_cell_action_specs } from '#lib/auth/cell_action_specs.ts';
import { all_cell_grant_action_specs } from '#lib/auth/cell_grant_action_specs.ts';
import { all_cell_field_action_specs } from '#lib/auth/cell_field_action_specs.ts';
import { all_cell_item_action_specs } from '#lib/auth/cell_item_action_specs.ts';
import { all_cell_audit_action_specs } from '#lib/auth/cell_audit_action_specs.ts';

const all_specs = [
	...all_fuz_auth_action_spec_registries.flatMap((r) => r.specs),
	...all_cell_action_specs,
	...all_cell_grant_action_specs,
	...all_cell_field_action_specs,
	...all_cell_item_action_specs,
	...all_cell_audit_action_specs,
	...protocol_action_specs
];

describe('action spec input invariants', () => {
	test('the handler-guarded inputs accept {} and reject undefined', () => {
		const guarded = all_specs.filter((spec) => is_empty_input_handler_guarded(spec.input));
		assert.ok(guarded.length > 0, 'no walked spec marks its input');
		for (const spec of guarded) {
			const { method } = spec;
			assert.ok(spec.input.safeParse({}).success, `${method}: {} must reach the handler guard`);
			assert.ok(!spec.input.safeParse(undefined).success, `${method}: undefined is no call`);
			assert.ok(!action_input_is_optional(spec), `${method}: codegen must keep input required`);
		}
	});

	test('codegen makes an input optional exactly when it accepts undefined', () => {
		for (const spec of all_specs) {
			assert.strictEqual(
				action_input_is_optional(spec),
				spec.input.safeParse(undefined).success,
				`${spec.method}: the typed surface and the schema disagree on an omitted input`
			);
		}
	});

	test('every spec input that accepts {} also accepts undefined', () => {
		for (const spec of all_specs) {
			if (is_empty_input_handler_guarded(spec.input)) continue;
			const accepts_empty = spec.input.safeParse({}).success;
			if (!accepts_empty) continue;
			const accepts_undefined = spec.input.safeParse(undefined).success;
			assert.ok(
				accepts_undefined,
				`${
					spec.method
				}: input accepts {} but rejects undefined — apply .default({}) at the schema root (or .refine() if {} should be rejected too)`
			);
		}
	});
});
