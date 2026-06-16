import '../assert_dev_env.ts';

/**
 * Cross-backend effect suite for the `open_signup` app setting.
 *
 * The declarative conformance table pins the admin gate on
 * `app_settings_get` / `app_settings_update` (401 / 403 / 200). This suite
 * pins the **behavioral effect** of the toggle end to end: an admin flips
 * `open_signup` via `app_settings_update`, and a subsequent anonymous
 * `POST /signup` observes the new value.
 *
 * - **toggle on → anonymous signup without an invite succeeds (200)** — with
 *   `open_signup: true`, the invite gate is skipped.
 * - **toggle off → anonymous signup is refused (403 `no_matching_invite`)** —
 *   flipping it back restores the invite requirement, proving the gate keys
 *   on the live value rather than a one-time read.
 *
 * The signup handler reads the toggle fresh from the database on every
 * request, so the admin's write is visible to the next signup. This suite
 * runs in a single process, so it validates the read-through *mechanism* —
 * not multi-process consistency (which the fresh-read shape provides by
 * construction but no single-binary test can observe).
 *
 * Cites `security.md` §Signup. Runs both legs via the shared `{setup_test}`
 * protocol: in-process (`auth/app_settings_parity.db.test.ts`) +
 * cross-process (`cross_backend/app_settings.cross.test.ts`, TS spine
 * binaries + Rust `testing_spine_stub`). Mounted on every spine, so the
 * suite is ungated.
 *
 * `$lib`-free by contract (relative specifiers only).
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {app_settings_update_action_spec} from '../../auth/admin_action_specs.ts';
import {ERROR_NO_MATCHING_INVITE} from '../../http/error_schemas.ts';
import type {RpcPathCrossSuiteOptions} from './setup.ts';
import {SPINE_RPC_PATH} from './default_spine_surface.ts';

/** Options for the app-settings effect suite (the standard RPC-dispatched shape). */
export type AppSettingsCrossTestOptions = RpcPathCrossSuiteOptions;

/** REST signup path on the spine surface (`/api/account` prefix + `/signup`). */
const SIGNUP_PATH = '/api/account/signup';

/** A password that satisfies the creation-strength schema (min 12). */
const SIGNUP_PASSWORD = 'securepassword123';

/** Build the JSON-RPC envelope for an `app_settings_update` call. */
const update_envelope = (open_signup: boolean, id: string): string =>
	JSON.stringify({
		jsonrpc: '2.0',
		method: app_settings_update_action_spec.method,
		params: {open_signup},
		id,
	});

export const describe_app_settings_cross_tests = (options: AppSettingsCrossTestOptions): void => {
	const {setup_test} = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('app_settings open_signup effect', () => {
		test('admin enables open_signup → anonymous signup without invite succeeds', async () => {
			const fixture = await setup_test();

			const enable = await fixture.transport(rpc_path, {
				method: 'POST',
				headers: {...fixture.create_session_headers(), 'content-type': 'application/json'},
				body: update_envelope(true, 'enable-open-signup'),
			});
			assert.strictEqual(enable.status, 200, 'admin app_settings_update must succeed');

			const res = await fixture.fresh_transport()(SIGNUP_PATH, {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({username: 'open_signup_user', password: SIGNUP_PASSWORD}),
			});
			assert.strictEqual(res.status, 200, 'open signup must admit an anonymous account');
			const body = (await res.json()) as {ok?: unknown};
			assert.strictEqual(body.ok, true, 'signup response reports success');
		});

		test('admin disables open_signup → anonymous signup is refused (no_matching_invite)', async () => {
			const fixture = await setup_test();

			// Enable then disable so the assertion proves the *flip back* takes
			// effect, not merely the closed default.
			const enable = await fixture.transport(rpc_path, {
				method: 'POST',
				headers: {...fixture.create_session_headers(), 'content-type': 'application/json'},
				body: update_envelope(true, 'enable-before-disable'),
			});
			assert.strictEqual(enable.status, 200, 'admin app_settings_update (enable) must succeed');

			const disable = await fixture.transport(rpc_path, {
				method: 'POST',
				headers: {...fixture.create_session_headers(), 'content-type': 'application/json'},
				body: update_envelope(false, 'disable-open-signup'),
			});
			assert.strictEqual(disable.status, 200, 'admin app_settings_update (disable) must succeed');

			const res = await fixture.fresh_transport()(SIGNUP_PATH, {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({username: 'closed_signup_user', password: SIGNUP_PASSWORD}),
			});
			assert.strictEqual(
				res.status,
				403,
				'closed signup must refuse a no-invite anonymous account',
			);
			const body = (await res.json()) as {error?: unknown};
			assert.strictEqual(
				body.error,
				ERROR_NO_MATCHING_INVITE,
				'rejection carries the no-matching-invite reason',
			);
		});
	});
};
