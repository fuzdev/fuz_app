/**
 * Production-mode coverage for handler-error messages in `ActionEvent`.
 *
 * A handler that throws while answering a remote caller (`receive_request`)
 * must not put the raw exception message on the wire in production — it can
 * carry paths or secrets. Local phases keep the message in every mode, since
 * it never leaves the process. Vitest runs with `DEV=true`, so this imports
 * the module fresh under a scoped `esm-env` mock. Sibling of the DEV-mode
 * assertions in `action_event.test.ts`.
 *
 * @module
 */

import { test, assert, afterEach, vi } from 'vitest';
import { z } from 'zod';

import type { ActionEventEnvironment } from '$lib/actions/action_event_types.ts';
import type { ActionSpecUnion } from '$lib/actions/action_spec.ts';

afterEach(() => {
	vi.doUnmock('esm-env');
	vi.resetModules();
});

const echo_spec = {
	method: 'echo',
	kind: 'request_response',
	initiator: 'both',
	auth: { account: 'none', actor: 'none' },
	side_effects: false,
	input: z.strictObject({ text: z.string() }),
	output: z.strictObject({ text: z.string() }),
	async: true,
	description: 'Echo'
} satisfies ActionSpecUnion;

const create_env = (phase: string): ActionEventEnvironment => ({
	executor: 'frontend',
	lookup_action_spec: (method) => (method === echo_spec.method ? echo_spec : undefined),
	lookup_action_handler: (method, p) =>
		method === echo_spec.method && p === phase
			? () => {
					throw new Error('secret path /home/x');
				}
			: undefined
});

const import_fresh = async (): Promise<typeof import('$lib/actions/action_event.ts')> => {
	vi.resetModules();
	vi.doMock('esm-env', () => ({ DEV: false, BROWSER: false }));
	return import('$lib/actions/action_event.ts');
};

test('a throw answering a remote request is redacted in production', async () => {
	const { create_action_event } = await import_fresh();
	const event = create_action_event(
		create_env('receive_request'),
		echo_spec,
		{ text: 'hi' },
		'receive_request'
	);
	event.set_request({ jsonrpc: '2.0', id: 1, method: 'echo', params: { text: 'hi' } });
	await event.parse().handle_async();
	assert.strictEqual(event.data.phase, 'send_error');
	assert.ok(event.data.error);
	assert.notInclude(event.data.error.message, 'secret');
	assert.strictEqual(event.data.error.message, 'internal server error');
});

test('a throw in a local phase keeps its message in production', async () => {
	const { create_action_event } = await import_fresh();
	const event = create_action_event(create_env('send_request'), echo_spec, { text: 'hi' });
	await event.parse().handle_async();
	assert.strictEqual(event.data.phase, 'send_error');
	assert.strictEqual(event.data.error?.message, 'secret path /home/x');
});
