/**
 * Small RPC helpers the auth suites share: reading an error's `data.reason`,
 * and a minimal `ActionContext` for invoking a handler directly (no
 * dispatcher, stub db).
 *
 * Not itself a test file — no `.test.` infix means vitest does not pick it up.
 *
 * @module
 */

import { Logger } from '@fuzdev/fuz_util/log.ts';

import type { ActionContext } from '$lib/actions/action_rpc.ts';
import type { RequestContext } from '$lib/auth/request_context.ts';
import { create_stub_db } from '$lib/testing/stubs.ts';

/**
 * Read the `reason` string off a JSON-RPC error response, past the
 * `data: unknown` cast.
 */
export const error_reason = (
	res: { ok: false; error: { data?: unknown } } | { ok: true }
): string | undefined => {
	if (res.ok) return undefined;
	return (res.error.data as { reason?: string } | undefined)?.reason;
};

const log = new Logger('test', { level: 'off' });

/**
 * Minimal `ActionContext` for invoking a handler directly — a stub db, so the
 * handler must refuse (or finish) before its first query.
 */
export const create_test_action_context = (auth: RequestContext): ActionContext => ({
	auth,
	request_id: 'test',
	db: create_stub_db(),
	pending_effects: [],
	post_commit_effects: [],
	client_ip: 'unknown',
	credential_type: 'session',
	log,
	notify: () => {},
	signal: new AbortController().signal
});
