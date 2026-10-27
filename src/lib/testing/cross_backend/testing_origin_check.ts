import '../assert_dev_env.ts';

/**
 * `_testing_origin_check` — the testing seam behind the cross-impl origin
 * conformance table (`origin_conformance.json`): its input and output schemas,
 * the pure check it answers with, its spec, and the action builder.
 *
 * Split from `testing_reset_actions.ts`, whose other seams reach the
 * in-process app server and through it the optional `hono` peer. This leaf is
 * hono-free, so a consumer whose backend is a spawned Rust binary can run the
 * conformance table without installing `hono`.
 *
 * @module
 */

import { z } from 'zod';

import { rpc_action, type RpcAction } from '../../actions/action_types.ts';
import type { RequestResponseActionSpec } from '../../actions/action_spec.ts';
import {
	AllowedOriginsErrorKind,
	parse_allowed_origins,
	should_allow_origin
} from '../../http/origin.ts';
import { TESTING_ACTION_AUTH } from './spine_surface_constants.ts';

/** Input of `_testing_origin_check`. */
export const TestingOriginCheckInput = z.strictObject({
	/** An allowlist value, as `FUZ_ALLOWED_ORIGINS` would carry it. */
	patterns: z.string(),
	/** One `Origin` header's value, or `null` for a request without one. */
	origin: z.string().nullable()
});
export type TestingOriginCheckInput = z.infer<typeof TestingOriginCheckInput>;

/**
 * Output of `_testing_origin_check`: the request-level answer when the list
 * parses, else every refusal — `index` the 1-based entry position, absent for
 * a list-level refusal.
 */
export const TestingOriginCheckOutput = z.union([
	z.strictObject({ ok: z.literal(true), allowed: z.boolean() }),
	z.strictObject({
		ok: z.literal(false),
		errors: z.array(
			z.strictObject({ index: z.number().int().min(1).optional(), kind: AllowedOriginsErrorKind })
		)
	})
]);
export type TestingOriginCheckOutput = z.infer<typeof TestingOriginCheckOutput>;

/**
 * Answer one `_testing_origin_check` input: parse `patterns` with
 * `parse_allowed_origins`, then run the request-level check for one `Origin`
 * carrying `origin` (`null` — no `Origin` — passes). The action handler and
 * the conformance table's unit test both call this, so the table checks the
 * same function the wire serves.
 *
 * @param input - the allowlist value and the `Origin` value
 * @returns the answer the Rust twin returns for the same input
 */
export const run_testing_origin_check = (
	input: TestingOriginCheckInput
): TestingOriginCheckOutput => {
	const parsed = parse_allowed_origins(input.patterns);
	if (!parsed.ok) {
		return {
			ok: false,
			errors: parsed.errors.map(({ index, kind }) =>
				index === undefined ? { kind } : { index, kind }
			)
		};
	}
	return {
		ok: true,
		allowed: input.origin === null || should_allow_origin(input.origin, parsed.origins)
	};
};

/**
 * `_testing_origin_check` — run the origin allowlist's parse and request
 * check for one `{patterns, origin}` pair, so the shared conformance table
 * (`origin_conformance.json`) checks each backend's grammar and matcher over
 * the wire, row by row. Pure: no database, no state. The Rust mirror is
 * `fuz_testing::create_testing_origin_check_action_spec`.
 *
 * Like `_testing_action_manifest`, it is **not** bundled by
 * `create_testing_actions`: a consumer whose Rust binary doesn't mount the
 * mirror would fail its action-manifest parity gate. The spine test binary
 * appends it at the full-mount layer (`build_full_spine_rpc_actions`).
 *
 * `auth` gates on the daemon-token credential, matching `_testing_reset`.
 */
export const testing_origin_check_action_spec = {
	method: '_testing_origin_check',
	kind: 'request_response',
	initiator: 'frontend',
	auth: TESTING_ACTION_AUTH,
	side_effects: false,
	input: TestingOriginCheckInput,
	output: TestingOriginCheckOutput,
	async: true,
	description:
		"Test-binary only — answer the origin allowlist's parse and request check for one " +
		'{patterns, origin} pair, for the cross-impl origin conformance table.'
} as const satisfies RequestResponseActionSpec;

/** Build the standalone `_testing_origin_check` action (see the spec doc). */
export const create_testing_origin_check_action = (): RpcAction =>
	rpc_action(testing_origin_check_action_spec, async (input) => run_testing_origin_check(input));
