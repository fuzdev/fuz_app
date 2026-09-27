/**
 * Tests for the shared `heartbeat_action` — the first composable fuz_app
 * primitive carrying both a spec and a handler. Verifies the spec parses
 * under the `RequestResponseActionSpec` schema, that the tuple drops
 * directly into a harness `actions` array, and that a heartbeat request
 * round-trips through the real dispatch path (auth, input validation,
 * handler, output).
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { z } from 'zod';

import { RequestResponseActionSpec } from '$lib/actions/action_spec.ts';
import {
	heartbeat_action,
	heartbeat_action_spec,
	heartbeat_handler
} from '$lib/actions/heartbeat.ts';
import { create_ws_test_harness } from '$lib/testing/ws_round_trip.ts';
import { to_input_params } from '$lib/http/schema_helpers.ts';

describe('heartbeat_action', () => {
	test('spec has the expected method + shape', () => {
		assert.strictEqual(heartbeat_action_spec.method, 'heartbeat');
		assert.strictEqual(heartbeat_action_spec.kind, 'request_response');
		assert.deepStrictEqual(heartbeat_action_spec.auth, { account: 'required', actor: 'none' });
		assert.strictEqual(heartbeat_action_spec.side_effects, false);
	});

	test('input is parameterless: empty shapes are the no-arg call, anything else is refused', () => {
		const { input } = heartbeat_action_spec;
		for (const params of [undefined, null, {}]) {
			assert.ok(input.safeParse(to_input_params(input, params)).success, JSON.stringify(params));
		}
		for (const params of [{ stray: 1 }, [], 0]) {
			assert.ok(!input.safeParse(to_input_params(input, params)).success, JSON.stringify(params));
		}
	});

	test('handler returns empty object', () => {
		assert.deepStrictEqual(heartbeat_handler(), {});
	});

	test('composable tuple carries spec and handler', () => {
		assert.strictEqual(heartbeat_action.spec, heartbeat_action_spec);
		assert.strictEqual(heartbeat_action.handler, heartbeat_handler);
	});

	test('round-trips through the harness with no additional wiring', async () => {
		const harness = create_ws_test_harness({ actions: [heartbeat_action] });
		const client = await harness.connect();

		const result = await client.request(1, heartbeat_action_spec.method, {});
		assert.deepStrictEqual(result, {});
	});

	test('composes alongside consumer actions — both dispatch independently', async () => {
		const consumer_echo_spec = RequestResponseActionSpec.parse({
			method: 'consumer_echo',
			kind: 'request_response',
			initiator: 'frontend',
			auth: { account: 'required', actor: 'none' },
			side_effects: false,
			input: z.strictObject({ value: z.string() }),
			output: z.strictObject({ value: z.string() }),
			async: true,
			description: 'test consumer echo'
		});

		const harness = create_ws_test_harness({
			actions: [
				heartbeat_action,
				{
					spec: consumer_echo_spec,
					handler: (input) => input
				}
			]
		});
		const client = await harness.connect();

		assert.deepStrictEqual(await client.request(1, heartbeat_action_spec.method, {}), {});
		assert.deepStrictEqual(await client.request(2, 'consumer_echo', { value: 'ok' }), {
			value: 'ok'
		});
	});
});
