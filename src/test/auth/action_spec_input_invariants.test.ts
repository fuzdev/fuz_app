/**
 * fuz_app's own registry under `describe_action_spec_invariants`
 * (`testing/action_spec_invariants.ts`, where the invariants and the
 * `empty_input_handler_guarded` exemption are explained).
 *
 * Iterates `all_fuz_auth_action_spec_registries` (auth-domain registries),
 * the cell registries (`all_cell_action_specs` spreads the relation verbs;
 * opt-in, outside the auth-domain list), plus
 * `protocol_action_specs` (transport-level — excluded from the
 * auth-domain registry-of-registries). A new auth-domain bundle picked
 * up via the registry list is covered automatically; a new cell or
 * transport-level wire bundle must be spread here explicitly.
 *
 * @module
 */

import { assert, test } from 'vitest';

import { all_fuz_auth_action_spec_registries } from '#lib/auth/all_action_spec_registries.ts';
import { protocol_action_specs } from '#lib/actions/protocol.ts';
import { is_empty_input_handler_guarded } from '#lib/schema_meta.ts';
import { all_cell_action_specs } from '#lib/auth/cell_action_specs.ts';
import { describe_action_spec_invariants } from '#lib/testing/action_spec_invariants.ts';

const all_specs = [
	...all_fuz_auth_action_spec_registries.flatMap((r) => r.specs),
	...all_cell_action_specs,
	...protocol_action_specs
];

describe_action_spec_invariants({ specs: all_specs });

// the cell reads carry the exemption, so the suite's guarded check walks something
test('some walked spec marks its input handler-guarded', () => {
	assert.ok(all_specs.some((spec) => is_empty_input_handler_guarded(spec.input)));
});
