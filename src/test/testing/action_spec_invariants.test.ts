/**
 * `describe_action_spec_invariants` over registries that break each invariant:
 * the test holding it is flagged `fails` before it runs, as `test.fails`
 * would, so the run passes only when the suite refuses the registry. Each
 * broken registry's other tests pass as usual. fuz_app's own registry runs the
 * suite in `src/test/auth/action_spec_input_invariants.test.ts`.
 *
 * @module
 */

import { assert, beforeAll, describe } from 'vitest';
import { meta } from '@fuzdev/fuz_schema/meta.ts';
import { object, optional, string, with_default } from '@fuzdev/fuz_schema/schema.ts';

import type { ActionSpecUnion } from '#lib/actions/action_spec.ts';
import { describe_action_spec_invariants } from '#lib/testing/action_spec_invariants.ts';

/** A spec carrying only what the suite reads. */
const fake_spec = (method: string, input: unknown): ActionSpecUnion =>
	({ method, input }) as unknown as ActionSpecUnion;

const required = object({ name: string });
const defaulted = with_default(object({ name: optional(string) }), {});

/**
 * Flag the test named `name` in the suite's describe to fail. The suite's
 * tests exist once collection ends, so the flag is set in a `beforeAll`.
 */
const expect_failure = (name: string): void => {
	// vitest requires the hook's context argument to be a destructuring pattern
	// eslint-disable-next-line no-empty-pattern
	beforeAll(({}, suite) => {
		const inner = suite.tasks.find((t) => t.name === 'action spec invariants');
		assert.ok(inner?.type === 'suite');
		const found = inner.tasks.find((t) => t.name === name);
		assert.ok(found?.type === 'test', `no test '${name}'`);
		found.fails = true;
	});
};

describe('a sound registry passes every check', () => {
	const specs = [fake_spec('a', required), fake_spec('b', defaulted)];
	describe_action_spec_invariants({
		specs,
		method_enum: { def: ['a', 'b'] },
		collections: { a: specs[0], b: specs[1] }
	});
});

describe('a repeated method', () => {
	describe_action_spec_invariants({ specs: [fake_spec('a', required), fake_spec('a', required)] });
	expect_failure('methods are unique');
});

describe('a method enum naming a method no spec carries', () => {
	describe_action_spec_invariants({
		specs: [fake_spec('a', required)],
		method_enum: { def: ['a', 'b'] }
	});
	expect_failure("the method enum names exactly the specs' methods");
});

describe('a method enum missing a spec', () => {
	describe_action_spec_invariants({
		specs: [fake_spec('a', required), fake_spec('b', required)],
		method_enum: { def: ['a'] }
	});
	expect_failure("the method enum names exactly the specs' methods");
});

describe('collections holding another spec object under a method', () => {
	describe_action_spec_invariants({
		specs: [fake_spec('a', required)],
		collections: { a: fake_spec('a', required) }
	});
	expect_failure('the collections hold exactly the specs');
});

describe('collections missing a spec', () => {
	const specs = [fake_spec('a', required), fake_spec('b', required)];
	describe_action_spec_invariants({ specs, collections: { a: specs[0] } });
	expect_failure('the collections hold exactly the specs');
});

describe('an input accepting {} and rejecting undefined', () => {
	describe_action_spec_invariants({ specs: [fake_spec('a', object({}))] });
	expect_failure('every input accepting {} also accepts undefined');
});

describe('a handler-guarded input accepting undefined', () => {
	const guarded = meta(with_default(object({}), {}), { empty_input_handler_guarded: true });
	describe_action_spec_invariants({ specs: [fake_spec('a', guarded)] });
	expect_failure('the handler-guarded inputs accept {} and reject undefined');
});

describe('a handler-guarded input refusing {}', () => {
	const guarded = meta(object({ name: string }), { empty_input_handler_guarded: true });
	describe_action_spec_invariants({ specs: [fake_spec('a', guarded)] });
	expect_failure('the handler-guarded inputs accept {} and reject undefined');
});

describe('a handler-guarded input is exempt from the {} rule', () => {
	const guarded = meta(object({}), { empty_input_handler_guarded: true });
	describe_action_spec_invariants({ specs: [fake_spec('a', guarded)] });
});
