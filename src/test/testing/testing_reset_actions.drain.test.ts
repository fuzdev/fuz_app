/**
 * `create_testing_actions` binds `_testing_drain_effects` to `deps.audit` —
 * the emitter the backend's handlers emit through — and `deps.request_tracker`,
 * and the handler awaits the emitter's `drain_inflight` and the tracker's
 * effect flushes. The cross case can't see this wiring fail (an audit write
 * on a local database beats the drain's HTTP round trip), so it is pinned here.
 *
 * @module
 */

import { test, assert, describe } from 'vitest';
import { create_deferred, wait } from '@fuzdev/fuz_util/async.ts';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import { create_testing_actions } from '#lib/testing/cross_backend/testing_reset_actions.ts';
import { create_stub_app_deps, create_test_audit_emitter } from '#lib/testing/stubs.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import type { DaemonTokenState } from '#lib/auth/daemon_token.ts';

describe('create_testing_actions — _testing_drain_effects', () => {
	test('awaits deps.audit.drain_inflight', async () => {
		const gate = create_deferred<void>();
		let drain_calls = 0;
		const deps = {
			...create_stub_app_deps(),
			audit: {
				...create_test_audit_emitter(),
				drain_inflight: async () => {
					drain_calls++;
					await gate.promise;
				}
			}
		};
		const actions = create_testing_actions(deps, {
			session_options: create_session_config('test_session'),
			daemon_token_state: {} as DaemonTokenState
		});
		const drain = actions.find((a) => a.spec.method === '_testing_drain_effects');
		assert.ok(drain, '_testing_drain_effects is bundled');

		let done = false;
		const result = Promise.resolve(drain.handler(undefined, null as never)).then((r) => {
			done = true;
			return r;
		});
		await wait();
		assert.strictEqual(drain_calls, 1, 'the bundled drain drains deps.audit');
		assert.ok(!done, 'the bundled drain answered before deps.audit drained');

		gate.resolve();
		assert.deepStrictEqual(await result, { ok: true });
	});

	test("awaits deps.request_tracker's flushes, and an audit write a flush starts", async () => {
		const deps = create_stub_app_deps();
		const flush_gate = create_deferred<void>();
		const write_gate = create_deferred<void>();
		let audit_writes = 0;
		deps.audit = {
			...deps.audit,
			drain_inflight: async () => {
				if (audit_writes > 0) await write_gate.promise;
				audit_writes = 0;
			},
			inflight_count: () => audit_writes
		};
		// a flush whose post-commit thunk starts an audit write as it settles
		deps.request_tracker.accept()!.finish(
			flush_gate.promise.then(() => {
				audit_writes = 1;
			})
		);
		const actions = create_testing_actions(deps, {
			session_options: create_session_config('test_session'),
			daemon_token_state: {} as DaemonTokenState
		});
		const drain = actions.find((a) => a.spec.method === '_testing_drain_effects');
		assert.ok(drain);

		let done = false;
		const result = Promise.resolve(drain.handler(undefined, null as never)).then((r) => {
			done = true;
			return r;
		});
		await wait();
		assert.ok(!done, 'the drain answered with a flush still running');
		flush_gate.resolve();
		await wait();
		assert.ok(!done, 'the drain answered with the audit write the flush started');
		write_gate.resolve();
		assert.deepStrictEqual(await result, { ok: true });
	});

	test('answers {ok: true}, every emitter counting its writes', async () => {
		const deps = { ...create_stub_app_deps(), audit: create_test_audit_emitter() };
		const actions = create_testing_actions(deps, {
			session_options: create_session_config('test_session'),
			daemon_token_state: {} as DaemonTokenState
		});
		const drain = actions.find((a) => a.spec.method === '_testing_drain_effects');
		assert.ok(drain);
		const result = await drain.handler(undefined, null as never);
		assert.deepStrictEqual(result, { ok: true });
		// the answer satisfies the spec's strict output schema
		assert.ok(parse(drain.spec.output, result).ok);
	});
});
