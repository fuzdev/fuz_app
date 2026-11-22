/**
 * The transcript differential's ledger of known differences
 * (`transcript_differential.ts`), TS spine against the Rust
 * `testing_spine_stub`. Each row names the paths within one entry where the
 * two differ and why; the closing test fails a row that matched nothing, so a
 * row is deleted as soon as the spines converge. The Node-against-Bun leg has
 * no ledger: one implementation on two runtimes, so any difference there is
 * normalizer noise or a runtime quirk.
 *
 * @module
 */

import {
	ERROR_INVALID_QUERY_PARAMS,
	ERROR_INVALID_REQUEST_BODY,
	ERROR_INVALID_ROUTE_PARAMS
} from '#lib/http/error_schemas.ts';
import { JSONRPC_INVALID_PARAMS, JSONRPC_INVALID_REQUEST } from '#lib/http/jsonrpc.ts';

import type { TranscriptKnownDivergence } from './transcript_differential.ts';

/** Every transcript divergence between the TS spine and the Rust stub. */
export const transcript_known_divergences: ReadonlyArray<TranscriptKnownDivergence> = [
	{
		tracking_id: 'ts-dev-rest-issues',
		reason:
			'TS keeps the validation issues on a REST schema 400 — body, route params or query — ' +
			'in DEV only (`dev_only` in `route_spec.ts`); Rust never sends them',
		where: {
			status: 400,
			body_error: [
				ERROR_INVALID_REQUEST_BODY,
				ERROR_INVALID_ROUTE_PARAMS,
				ERROR_INVALID_QUERY_PARAMS
			]
		},
		what_differs: [{ path: 'response.body.issues', b: undefined }]
	},
	{
		tracking_id: 'ts-dev-rpc-issues',
		reason:
			'TS keeps the validation issues on a JSON-RPC schema refusal — `invalid_params`, and ' +
			'`invalid_request` on a malformed envelope — in DEV only (`dev_only`); Rust never sends them',
		where: { status: 400, rpc_code: [JSONRPC_INVALID_PARAMS, JSONRPC_INVALID_REQUEST] },
		what_differs: [{ path: 'response.body.error.data.issues', b: undefined }]
	}
];
