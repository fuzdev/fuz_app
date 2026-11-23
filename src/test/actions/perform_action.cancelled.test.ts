/**
 * The dispatcher's answer to a throw after the request's `signal` aborted,
 * driven directly with a signal aborted for a reason of its own: a handler
 * that rethrows that reason — no `AbortError`, recognized by identity alone —
 * is the cancellation, answered `request_cancelled` and logged at debug; any
 * other throw there is answered the same and logged at warn.
 *
 * @module
 */

import { assert, test, vi } from 'vitest';
import { literal, object, void as fuz_void } from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { perform_action } from '#lib/actions/perform_action.ts';
import { noop_notification_sender } from '#lib/actions/notification_sender.ts';
import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import type { ActionHandler } from '#lib/actions/action_types.ts';
import { Db } from '#lib/db/db.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';

const spec: RequestResponseActionSpec = {
	method: 'cancellable',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'none', actor: 'none' },
	side_effects: false,
	input: fuz_void,
	output: object({ ok: literal(true) }),
	async: true,
	description: 'test — aborts its own signal, then throws'
};

/** A `Db` the handler never reaches — a call would fail the test. */
const unused_db = (): Db =>
	new Db({
		client: { query: () => Promise.reject(new Error('the handler reads no database')) },
		transaction: () => Promise.reject(new Error('the action opens no transaction'))
	});

/** Dispatch `spec` with a handler that aborts the signal for `reason`, then throws `thrown(reason)`. */
const dispatch = async (thrown: (reason: unknown) => unknown) => {
	const log = new Logger('[perform-action-test]', { level: 'off' });
	const debug = vi.spyOn(log, 'debug');
	const warn = vi.spyOn(log, 'warn');
	const controller = new AbortController();
	// a reason of the dispatch's own, no `AbortError`
	const reason = new Error('shutting down');
	const handler: ActionHandler = () => {
		controller.abort(reason);
		throw thrown(reason);
	};
	const result = await perform_action(
		{
			action: { spec, handler },
			raw_params: undefined,
			request_id: 1,
			credential: null,
			client_ip: '127.0.0.1',
			signal: controller.signal,
			notify: () => {}
		},
		{
			db: unused_db(),
			pending_effects: [],
			post_commit_effects: [],
			log,
			notification_sender: noop_notification_sender,
			action_ip_rate_limiter: null,
			action_account_rate_limiter: null
		}
	);
	assert.strictEqual(controller.signal.reason, reason);
	return { result, debug, warn };
};

const was_cancelled = (calls: ReadonlyArray<ReadonlyArray<unknown>>): boolean =>
	calls.some(([line]) => String(line).includes('cancellable: the request was cancelled'));

test("a rethrow of the signal's own reason is the cancellation, logged at debug", async () => {
	const { result, debug, warn } = await dispatch((reason) => reason);
	assert(result.kind === 'error', 'an error answer');
	assert.strictEqual(result.error.code, JSONRPC_ERROR_CODES.request_cancelled);
	assert.strictEqual(result.status, 499);
	assert.ok(was_cancelled(debug.mock.calls), 'logged at debug as the cancellation');
	assert.strictEqual(warn.mock.calls.length, 0, 'not as a fault');
});

test('any other throw after the abort is answered the same and logged at warn', async () => {
	const { result, debug, warn } = await dispatch(() => new Error('a fault after the abort'));
	assert(result.kind === 'error', 'an error answer');
	assert.strictEqual(result.error.code, JSONRPC_ERROR_CODES.request_cancelled);
	assert.strictEqual(warn.mock.calls.length, 1, 'logged at warn');
	assert.ok(!was_cancelled(debug.mock.calls), 'not passed off as the cancellation');
});
