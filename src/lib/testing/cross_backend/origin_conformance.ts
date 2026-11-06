import '../assert_dev_env.ts';

/**
 * The origin allowlist conformance table, and the cross-backend suite that
 * runs it against each backend over the wire.
 *
 * `origin_conformance.json` (beside this module) is the one statement of the
 * allowlist grammar and matcher both spines implement. It holds two tables:
 *
 * - **parse** rows — `{raw, ok: true}` or `{raw, errors: [{index?, kind}]}`:
 *   an allowlist value (as `FUZ_ALLOWED_ORIGINS` would carry it) and whether
 *   it parses, or every refusal with its 1-based entry position (absent for a
 *   list-level refusal) and its `AllowedOriginsErrorKind`.
 * - **match** rows — `{patterns, origin, allowed}`: a valid allowlist, one
 *   `Origin` value (`null` for none), and the request-level answer.
 *
 * A row may carry a `note` for the reader. The TS unit test reads the table
 * directly; `describe_origin_conformance_cross_tests` sends every row to a
 * backend's `_testing_origin_check` action and compares the answer, so the
 * Rust spine is held to the same rows without reading this file.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { assert, describe, test } from 'vitest';
import {
	array,
	boolean,
	literal,
	min_length,
	min_value,
	nullable,
	number,
	object,
	optional,
	parse,
	parse_or_throw,
	pipe,
	safe_integer,
	string,
	union,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { AllowedOriginsErrorKind } from '../../http/origin.ts';
import { cross_rpc_call } from './cross_rpc.ts';
import type { RpcPathCrossSuiteOptions } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';
import {
	TestingOriginCheckOutput,
	testing_origin_check_action_spec,
	type TestingOriginCheckInput
} from './testing_origin_check.ts';

/** One expected refusal of a parse row. */
export const OriginConformanceError = object({
	index: optional(pipe(number, safe_integer, min_value(1))),
	kind: AllowedOriginsErrorKind
});
export type OriginConformanceError = Infer<typeof OriginConformanceError>;

/** A parse row: the value parses (`ok: true`), or is refused with `errors`. */
export const OriginConformanceParseRow = union([
	object({ raw: string, ok: literal(true), note: optional(string) }),
	object({
		raw: string,
		errors: pipe(array(OriginConformanceError), min_length(1)),
		note: optional(string)
	})
]);
export type OriginConformanceParseRow = Infer<typeof OriginConformanceParseRow>;

/** A match row: a valid allowlist, one `Origin` value or `null`, and the answer. */
export const OriginConformanceMatchRow = object({
	patterns: string,
	origin: nullable(string),
	allowed: boolean,
	note: optional(string)
});
export type OriginConformanceMatchRow = Infer<typeof OriginConformanceMatchRow>;

/** The conformance table, a `@fuzdev/fuz_schema` `object`. */
export const OriginConformance = object({
	parse: pipe(array(OriginConformanceParseRow), min_length(1)),
	match: pipe(array(OriginConformanceMatchRow), min_length(1))
});
export type OriginConformance = Infer<typeof OriginConformance>;

/** The committed table, resolved relative to this module. */
export const ORIGIN_CONFORMANCE_URL: URL = new URL('./origin_conformance.json', import.meta.url);

/**
 * Read and validate the committed conformance table.
 *
 * @returns the parsed table
 * @throws Error when the file doesn't match `OriginConformance`
 */
export const load_origin_conformance = (): OriginConformance =>
	parse_or_throw(OriginConformance, JSON.parse(readFileSync(ORIGIN_CONFORMANCE_URL, 'utf8')));

/** One table row as the action input that checks it. */
export interface OriginConformanceCheck {
	/** A short label naming the row, for a failure message. */
	readonly label: string;
	readonly input: TestingOriginCheckInput;
	readonly expected: TestingOriginCheckOutput;
}

/**
 * Flatten the table into action inputs and the answers they must get. A parse
 * row sends a `null` origin, so a value that parses answers
 * `{ok: true, allowed: true}`.
 *
 * @param table - the conformance table
 * @returns one check per row, parse rows first
 */
export const to_origin_conformance_checks = (
	table: OriginConformance
): Array<OriginConformanceCheck> => [
	...table.parse.map((row): OriginConformanceCheck => ({
		label: `parse ${JSON.stringify(row.raw)}`,
		input: { patterns: row.raw, origin: null },
		expected:
			'errors' in row
				? { ok: false, errors: row.errors.map((e) => ({ ...e })) }
				: { ok: true, allowed: true }
	})),
	...table.match.map((row): OriginConformanceCheck => ({
		label: `match ${JSON.stringify(row.patterns)} × ${JSON.stringify(row.origin)}`,
		input: { patterns: row.patterns, origin: row.origin },
		expected: { ok: true, allowed: row.allowed }
	}))
];

/**
 * Compare each check's answer with its expectation and fail once, listing
 * every row that disagrees.
 *
 * @param checks - the table's checks
 * @param answer - the answer each check got, in order
 * @param backend - the name the failure message gives the answerer
 */
export const assert_origin_conformance = (
	checks: ReadonlyArray<OriginConformanceCheck>,
	answer: ReadonlyArray<unknown>,
	backend: string
): void => {
	const failures: Array<string> = [];
	checks.forEach((check, i) => {
		const got = answer[i];
		try {
			assert.deepStrictEqual(got, check.expected);
		} catch {
			failures.push(
				`${check.label}: expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(got)}`
			);
		}
	});
	assert.ok(
		failures.length === 0,
		`${backend}: ${failures.length} of ${checks.length} origin conformance rows disagree:\n` +
			failures.join('\n')
	);
};

/** Options for `describe_origin_conformance_cross_tests`. */
export type OriginConformanceCrossTestOptions = RpcPathCrossSuiteOptions;

/**
 * Register the origin conformance suite: every row of the committed table,
 * sent to the backend's `_testing_origin_check` action over the keeper's
 * daemon-token channel, must get the answer the table names. The action is on
 * every spine test binary, so the suite is ungated.
 */
export const describe_origin_conformance_cross_tests = (
	options: OriginConformanceCrossTestOptions
): void => {
	const { setup_test } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const checks = to_origin_conformance_checks(load_origin_conformance());

	describe('origin allowlist conformance', () => {
		test('every table row gets the answer it names', async () => {
			const fixture = await setup_test();
			// Origin-free: the daemon-token middleware discards the credential in a
			// browser context, and the cross-process transport adds an `Origin`
			const transport = fixture.fresh_transport({ origin: null });
			const headers = fixture.create_daemon_token_headers();
			const answers: Array<unknown> = [];
			for (const check of checks) {
				const res = await cross_rpc_call(
					transport,
					rpc_path,
					testing_origin_check_action_spec.method,
					check.input,
					headers
				);
				assert.ok(res.ok, `${check.label}: RPC failed: ${JSON.stringify(res.error)}`);
				const parsed = parse(TestingOriginCheckOutput, res.result);
				answers.push(parsed.ok ? parsed.value : res.result);
			}
			assert_origin_conformance(checks, answers, 'backend');
		});
	});
};
