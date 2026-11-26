import './assert_dev_env.ts';

/**
 * The invariants an action spec registry holds whatever its domain — the suite
 * a consumer runs over the generated registry its frontend client carries, so
 * a copied test can't drift from fuz_app's own.
 *
 * - **Methods are unique.** The registry dispatches by method.
 * - **The generated method enum and collections match the specs.** They come
 *   from generators with their own source lists, so a spec group added to one
 *   and not the other typechecks and then throws "rpc method not found" at the
 *   call. Given, `method_enum` must name exactly the specs' methods and
 *   `collections` hold exactly the specs, each by identity.
 * - **An input accepting `{}` accepts `undefined`.** Codegen
 *   (`action_input_is_optional`) types an input accepting `{}` optional, so
 *   an adapter written `() => api.foo()` typechecks, and then trips
 *   `ActionEvent.parse` on the omitted input before the call reaches the
 *   wire when the schema refuses `undefined`. Two fixes: a default of
 *   `{}` at the schema root when `{}` is a meaningful call, or a check
 *   refusing `{}` when the caller must supply data.
 * - **The one exemption, by design:** an input marked
 *   `empty_input_handler_guarded` (`schema_meta.ts`) accepts `{}` and refuses
 *   `undefined`, because its handler refuses `{}` with a declared reason, and
 *   codegen keeps it required. The suite holds each marked input to that shape.
 *
 * Together the two input checks make codegen's typed surface agree with the
 * schema: `action_input_is_optional` types an input optional exactly when it
 * parses `undefined`.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import type { ActionSpecUnion } from '../actions/action_spec.ts';
import { is_empty_input_handler_guarded } from '../schema_meta.ts';

/** What `describe_action_spec_invariants` holds. */
export interface ActionSpecInvariantsOptions {
	/**
	 * The registry — the specs the frontend client carries, protocol specs
	 * included, so every method a caller can name is held.
	 */
	readonly specs: ReadonlyArray<ActionSpecUnion>;
	/** The generated method enum (`ActionMethod`); given, it names exactly the specs' methods. */
	readonly method_enum?: { readonly def: ReadonlyArray<unknown> };
	/** The generated spec collection keyed by method (`ActionSpecs`); given, it holds exactly `specs`, each by identity. */
	readonly collections?: Readonly<Record<string, unknown>>;
}

/** `[missing, extra]` — what `actual` lacks of `expected`, and what it has beyond it. */
const diff_sets = (
	expected: ReadonlyArray<unknown>,
	actual: ReadonlyArray<unknown>
): [Array<unknown>, Array<unknown>] => {
	const e = new Set(expected);
	const a = new Set(actual);
	return [[...e].filter((x) => !a.has(x)), [...a].filter((x) => !e.has(x))];
};

/**
 * Register the registry invariant tests over `options.specs` in a
 * `describe('action spec invariants')`.
 *
 * @param options - the specs, and the generated enum and collections to hold to them
 */
export const describe_action_spec_invariants = (options: ActionSpecInvariantsOptions): void => {
	const { specs, method_enum, collections } = options;
	const methods = specs.map((spec) => spec.method);

	describe('action spec invariants', () => {
		test('methods are unique', () => {
			const seen: Set<string> = new Set();
			const repeated: Array<string> = [];
			for (const m of methods) {
				if (seen.has(m)) repeated.push(m);
				seen.add(m);
			}
			assert.deepEqual(repeated, [], 'methods registered more than once');
		});

		if (method_enum) {
			test("the method enum names exactly the specs' methods", () => {
				const [missing, extra] = diff_sets(methods, method_enum.def);
				assert.deepEqual(missing, [], 'specs the method enum lacks');
				assert.deepEqual(extra, [], 'enum methods no spec carries');
			});
		}

		if (collections) {
			test('the collections hold exactly the specs', () => {
				const [missing, extra] = diff_sets(methods, Object.keys(collections));
				assert.deepEqual(missing, [], 'specs the collections lack');
				assert.deepEqual(extra, [], 'collection keys no spec carries');
				for (const spec of specs) {
					assert.strictEqual(collections[spec.method], spec, `${spec.method}: another spec object`);
				}
			});
		}

		test('every input accepting {} also accepts undefined', () => {
			for (const spec of specs) {
				if (is_empty_input_handler_guarded(spec.input)) continue;
				if (!parse(spec.input, {}).ok) continue;
				assert.ok(
					parse(spec.input, undefined).ok,
					`${spec.method}: input accepts {} but rejects undefined — default the schema root to {} ` +
						'(or check that refuses {} when the caller must supply data)'
				);
			}
		});

		test('the handler-guarded inputs accept {} and reject undefined', () => {
			for (const spec of specs) {
				if (!is_empty_input_handler_guarded(spec.input)) continue;
				const { method } = spec;
				assert.ok(parse(spec.input, {}).ok, `${method}: {} must reach the handler guard`);
				assert.ok(!parse(spec.input, undefined).ok, `${method}: undefined is no call`);
			}
		});
	});
};
