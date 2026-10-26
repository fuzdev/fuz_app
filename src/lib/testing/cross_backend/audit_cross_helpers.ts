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
 * can skip the barrier, and holds every row it lists to its event type's
 * metadata schema (`assert_audit_event_metadata`), so every reader checks the
 * metadata of the rows it reads, on every spine — closed to undeclared keys
 * when the fixture's setup asked for it.
 *
 * @module
 */

import { assert } from 'vitest';

import { AuditLogListOutput } from '../../auth/admin_action_specs.ts';
import type { AuditLogEventWithUsernamesJson } from '../../auth/audit_log_schema.ts';
import { assert_audit_event_metadata } from '../audit_drift_guard.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
import { cross_rpc_call, expect_output } from './cross_rpc.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';

/** The fixture members an audit read uses — every `TestFixture` has them. */
export interface AuditReadFixture {
	readonly fresh_transport: (options?: { readonly origin?: string | null }) => FetchTransport;
	/** The keeper's session headers — the keeper holds the admin role the audit read needs. */
	readonly create_session_headers: (extra?: Record<string, string>) => Record<string, string>;
	readonly create_daemon_token_headers: (extra?: Record<string, string>) => Record<string, string>;
	/** Refuse undeclared metadata keys — see `TestFixture.reject_unknown_audit_metadata_keys`. */
	readonly reject_unknown_audit_metadata_keys?: boolean;
}

/**
 * Await the backend's in-flight audit writes via `_testing_drain_effects`, so
 * a following `audit_log_list` sees every row emitted before the call. The
 * backend must mount the action — every spine test binary does; in-process
 * suites mount `create_testing_drain_effects_action`.
 *
 * Refuses an answer without `tracked: true`. A binary whose audit emitter was
 * built without in-flight tracking answers the drain at once, waiting on
 * nothing, and its audit reads race the writes — an absent row then reads as
 * a pass. Every audit read runs through here, so each one checks the barrier
 * is live.
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
	const tracked =
		typeof drained.result === 'object' && drained.result !== null
			? (drained.result as Record<string, unknown>).tracked
			: undefined;
	assert.strictEqual(
		tracked,
		true,
		"_testing_drain_effects must answer tracked: true — the backend's audit emitter does not " +
			`track in-flight writes, so the drain waits on nothing (got ${JSON.stringify(drained.result)})`
	);
};

/**
 * Assert an audit row's `metadata` carries `expected` — each field compared
 * on its own, so a consumer's added key passes — and none of `absent`. When
 * the fixture's setup closed the world (`reject_unknown_audit_metadata_keys`),
 * the whole object must equal `expected`, so an undeclared key fails too.
 *
 * @param fixture - the per-test fixture, whose flag picks the comparison
 * @param metadata - the row's `metadata`
 * @param expected - the declared fields and their values
 * @param absent - keys the row must not carry, e.g. an optional field left unset
 */
export const assert_audit_metadata_fields = (
	fixture: Pick<AuditReadFixture, 'reject_unknown_audit_metadata_keys'>,
	metadata: Record<string, unknown> | null,
	expected: Record<string, unknown>,
	absent: ReadonlyArray<string> = []
): void => {
	assert.ok(metadata, 'the audit row carries metadata');
	for (const [key, value] of Object.entries(expected)) {
		assert.deepStrictEqual(metadata[key], value, `metadata.${key}`);
	}
	for (const key of absent) assert.notProperty(metadata, key, `metadata.${key} is absent`);
	if (fixture.reject_unknown_audit_metadata_keys) {
		assert.deepStrictEqual(metadata, expected, 'metadata carries only the declared fields');
	}
};

/**
 * Drain the backend's audit writes (`cross_drain_effects`), then list audit rows as
 * the keeper, parse them against `AuditLogListOutput`, and parse each row's
 * `metadata` against its event type's schema (`assert_audit_event_metadata`),
 * with unknown keys refused when `fixture.reject_unknown_audit_metadata_keys`
 * is set. The wire schema leaves `metadata` a loose record, so without this a
 * spine's metadata drift reaches no assertion.
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
	const { events } = expect_output(
		await cross_rpc_call(
			fixture.fresh_transport(),
			rpc_path,
			'audit_log_list',
			params,
			fixture.create_session_headers()
		),
		AuditLogListOutput
	);
	const reject_unknown_keys = fixture.reject_unknown_audit_metadata_keys ?? false;
	for (const event of events) assert_audit_event_metadata(event, { reject_unknown_keys });
	return events;
};
