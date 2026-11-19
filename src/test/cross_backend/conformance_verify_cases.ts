/**
 * The dead credentials on `GET /verify`, the nginx `auth_request` shim — the
 * route where accepting a dead credential matters most, since a 200 there
 * admits a request to whatever nginx fronts.
 *
 * TS spines only: the Rust account router doesn't mount `/verify`
 * (`ACCOUNT_ROUTER_PATHS`), so these rows run in the in-process leg, on the
 * TS cross projects (`TS_SPINE_ONLY_CROSS_TESTS` in
 * `cross_backend_projects.ts`), and in the Node-vs-Bun differential — never
 * against the Rust stub or in the TS-vs-Rust differential.
 *
 * @module
 */

import type { ConformanceCase } from '#lib/testing/cross_backend/conformance_case.ts';

import { create_dead_credential_rows } from './conformance_dead_credential_cases.ts';

export const conformance_verify_cases: ReadonlyArray<ConformanceCase> = create_dead_credential_rows(
	{
		label: 'GET /verify',
		request: { method: '/verify', verb: 'GET' },
		equivalence_group: 'dead_credential_verify_401',
		anonymous_row: true
	}
);
