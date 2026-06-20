import '../assert_dev_env.ts';

/**
 * Declarative conformance-case schema for the cross-backend behavioral +
 * security suite.
 *
 * A conformance case is a single request → expected-response assertion,
 * carried as **data**. The case references a `method` (an RPC method name
 * or a REST auth-route suffix); the runner
 * (`describe_conformance_table_tests`) resolves the `input` / `output`
 * Zod schemas from the live action-spec registry / `RouteSpec` — the case
 * never carries a schema. This is the opinionated behavioral/security
 * layer on top of the spec-derived auto-enumeration
 * (`describe_rpc_round_trip_tests` / `describe_rpc_attack_surface_tests`):
 * the same case definition runs in-process (fast, every `gro test`) and
 * cross-process (the conformance gate) against each impl's real auth
 * resolution.
 *
 * The table is for single-request matrices (credential-type ceiling,
 * privilege gates, IDOR masks, enumeration-equivalence, validation).
 * Multi-step flows stay imperative in their own `describe_*` suites,
 * sharing assertion primitives — there is deliberately no declarative
 * setup DSL.
 *
 * @module
 */

import {z} from 'zod';

/**
 * Closed enum of fixture-provisioned principals a case runs `as`. Each
 * value maps to a `TestFixture` accessor (or a seeded `extra_accounts`
 * entry) in the runner's `resolve_principal` — there is **no** inline
 * credential minting in a case (that would be the setup-DSL trap).
 *
 * - `keeper` — the per-test bootstrapped keeper (holds `ROLE_KEEPER` +
 *   `ROLE_ADMIN`), session credential.
 * - `daemon` — the keeper authenticated via the daemon-token header.
 * - `token` — the keeper authenticated via a bearer api-token (non-browser
 *   context; the runner suppresses `Origin` so the token isn't discarded).
 * - `anonymous` — no credential, fresh cookie jar.
 * - `fresh_non_admin` — a freshly minted account with no roles, session
 *   credential (via the production invite → signup → login flow).
 * - `role_holder` — a seeded `extra_accounts` principal holding a specific
 *   role; the runner reads it by the username named in
 *   `ConformanceTableOptions.principals.role_holder`.
 * - `wrong_role` — a seeded `extra_accounts` principal holding a role
 *   other than the one a route requires; named via
 *   `ConformanceTableOptions.principals.wrong_role`.
 * - `expired_session` — the keeper account presented via an *expired
 *   server-side session* cookie (minted by `fixture.mint_expired_session()`:
 *   a backdated `auth_session` row behind a still-valid signed cookie
 *   payload, so the authoritative DB-row expiry gate is what refuses it).
 */
export const ConformancePrincipal = z.enum([
	'keeper',
	'daemon',
	'token',
	'anonymous',
	'fresh_non_admin',
	'role_holder',
	'wrong_role',
	'expired_session',
]);
export type ConformancePrincipal = z.infer<typeof ConformancePrincipal>;

/** The request a conformance case issues. */
export const ConformanceCaseRequest = z.strictObject({
	method: z.string().meta({
		description:
			'RPC method name (e.g. `admin_account_list`) or a REST auth-route suffix ' +
			'(e.g. `/login`). A leading `/` selects the REST branch; otherwise the ' +
			'runner resolves the RPC action from the spec registry.',
	}),
	params: z
		.unknown()
		.optional()
		.meta({description: 'Request params / body. Omit for nullary methods.'}),
	as: ConformancePrincipal,
	verb: z
		.enum(['POST', 'GET'])
		.optional()
		.meta({description: 'HTTP verb. Defaults to POST; use GET for `side_effects: false` reads.'}),
});
export type ConformanceCaseRequest = z.infer<typeof ConformanceCaseRequest>;

/** The expected response shape a conformance case asserts. */
export const ConformanceCaseExpectation = z.strictObject({
	status: z.number().int().meta({description: 'Expected HTTP status code.'}),
	error_reason: z
		.string()
		.optional()
		.meta({
			description:
				'Expected error reason — pass the IMPORTED `ERROR_*` constant from ' +
				'`http/error_schemas.ts`, never a string literal. Asserted against the RPC ' +
				'`error.data.reason` (when the denial carries one) or the REST flat-body ' +
				'`error` field. The pre-validation 401 carries `data.reason` too; a denial ' +
				'that genuinely omits it falls back to the `status` assertion to pin the class.',
		}),
	fields: z
		.record(z.string(), z.unknown())
		.optional()
		.meta({
			description:
				'Specific field-value assertions on the success `result` (2xx) or the error ' +
				'`error.data` (non-2xx). Each key must deep-equal the corresponding response field.',
		}),
	equivalence_group: z
		.string()
		.optional()
		.meta({
			description:
				'Tags this case as a member of an indistinguishability group. After all cases ' +
				'run, the runner asserts every member of a group produced a BYTE-IDENTICAL ' +
				'normalized response (`{status, body}`) — checked per impl. This promotes a ' +
				'masked pair (found-but-unauthorized ≡ not-found, wrong-password ≡ ' +
				'account-not-found) from "same status + reason" to "wire-indistinguishable", ' +
				'and holds BOTH impls to it: a prober hitting either spine cannot tell the ' +
				'members apart. A group needs >= 2 members; a member may still set `fields`. ' +
				'The negative-space twin of the positive `output`-schema parity the runner ' +
				'already asserts.',
		}),
});
export type ConformanceCaseExpectation = z.infer<typeof ConformanceCaseExpectation>;

/**
 * Marks a case as a deferred-by-design gap. The runner routes it through
 * `xfail_until` instead of a normal `test` — visible (distinct from pass)
 * and self-cleaning (flips red when the impl starts passing, forcing the
 * marker's removal). Use for declared gaps (e.g. facts), never for
 * in-scope gaps (those fail loud as a red `test`).
 */
export const ConformanceCaseXfail = z.strictObject({
	tracking_id: z
		.string()
		.meta({description: 'Tracking id for the deferred gap (issue id or tracking slug).'}),
	reason: z.string().meta({description: 'Why this case is deferred-by-design.'}),
});
export type ConformanceCaseXfail = z.infer<typeof ConformanceCaseXfail>;

/**
 * A single conformance case. `name` is the assertion; the optional
 * free-text `note` is printed in the test label / failure output. A
 * security case's `note` should reference a **public** fuz_app doc
 * property (`security.md` / `architecture.md` / module TSDoc), since the
 * table ships in a public package — not an internal planning doc. The note
 * is documentation, not a gate: it stays free-text by design because a
 * non-empty-string check never catches a *wrong* citation — the citation
 * is verified in review.
 */
export const ConformanceCase = z.strictObject({
	name: z.string().meta({description: 'The assertion, used as the test label.'}),
	request: ConformanceCaseRequest,
	expect: ConformanceCaseExpectation,
	note: z
		.string()
		.optional()
		.meta({description: 'Free-text note printed in the label / failure output.'}),
	xfail: ConformanceCaseXfail.optional(),
});
export type ConformanceCase = z.infer<typeof ConformanceCase>;
