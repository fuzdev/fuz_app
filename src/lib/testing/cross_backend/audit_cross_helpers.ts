import '../assert_dev_env.ts';

/**
 * Audit-row reads for the cross-backend suites, behind the
 * `_testing_drain_effects` barrier.
 *
 * Both spines write audit rows off the request path — a WS mutation is
 * answered before its effects flush, and the Rust spine's emits are
 * fire-and-forget — so a suite that reads `audit_log_list` right after the
 * call it audits can miss the row, and an assertion that a row is absent then
 * passes vacuously. `list_audit_events` drains before it lists, so no reader
 * can skip the barrier.
 *
 * @module
 */

import { assert } from 'vitest';

import { AuditLogListOutput } from '../../auth/admin_action_specs.ts';
import type { AuditLogEventWithUsernamesJson } from '../../auth/audit_log_schema.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
import { cross_rpc_call, expect_output } from './cell_cross_helpers.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';

/** The fixture members an audit read uses — every `TestFixture` has them. */
export interface AuditReadFixture {
	readonly fresh_transport: (options?: { readonly origin?: string | null }) => FetchTransport;
	/** The keeper's session headers — the keeper holds the admin role the audit read needs. */
	readonly create_session_headers: (extra?: Record<string, string>) => Record<string, string>;
	readonly create_daemon_token_headers: (extra?: Record<string, string>) => Record<string, string>;
}

/**
 * Await the backend's in-flight audit writes via `_testing_drain_effects`, so
 * a following `audit_log_list` sees every row emitted before the call. The
 * backend must mount the action — every spine test binary does; in-process
 * suites mount `create_testing_drain_effects_action`.
 *
 * @param fixture - the per-test fixture, whose daemon token authorizes the drain
 * @param rpc_path - the RPC endpoint the drain action is mounted on
 */
export const cross_drain_effects = async (
	fixture: AuditReadFixture,
	rpc_path: string = SPINE_RPC_PATH
): Promise<void> => {
	const drained = await cross_rpc_call(
		fixture.fresh_transport({ origin: null }),
		rpc_path,
		'_testing_drain_effects',
		undefined,
		fixture.create_daemon_token_headers()
	);
	assert.ok(drained.ok, `_testing_drain_effects failed: ${JSON.stringify(drained.error)}`);
};

/**
 * Drain the backend's audit writes (`cross_drain_effects`), then list audit rows as
 * the keeper and parse them against `AuditLogListOutput`.
 *
 * @param fixture - the per-test fixture; the list runs on the keeper's session
 * @param params - `audit_log_list` params, e.g. `{event_type: 'login', outcome: 'failure'}`
 * @param rpc_path - the RPC endpoint both actions are mounted on
 * @returns the listed events
 */
export const list_audit_events = async (
	fixture: AuditReadFixture,
	params: Record<string, unknown>,
	rpc_path: string = SPINE_RPC_PATH
): Promise<Array<AuditLogEventWithUsernamesJson>> => {
	await cross_drain_effects(fixture, rpc_path);
	return expect_output(
		await cross_rpc_call(
			fixture.fresh_transport(),
			rpc_path,
			'audit_log_list',
			params,
			fixture.create_session_headers()
		),
		AuditLogListOutput
	).events;
};
