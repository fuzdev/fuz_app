/**
 * Cross-process role-grant-offer WS notification suite for fuz_app's own spine
 * over real HTTP.
 *
 * Companion to `ws.cross.test.ts` (which drives the consumer-agnostic
 * `heartbeat`-only transport suite): this one drives the seven role-grant-offer
 * lifecycle notifications (received / accepted / declined / retracted / flat
 * revoke + supersede on both the accept and revoke cascades) end-to-end against
 * the spawned spine binary. It is the spine self-test proof that fuz_app's own
 * `notification_sender` wiring fans these out over a real socket — the same
 * shared suite the fuz_forge twin-impl consumer runs against its two backends.
 *
 * Runs under every `cross_backend_*` project: the TS spine binary
 * (`testing_spine_server`, which now threads its `ws_transport` as the
 * `notification_sender`) and the Rust `testing_spine_stub` (which already wires
 * the sender + mounts role-grant actions on `/api/ws`). The keeper holds
 * `ROLE_ADMIN` by default (the `_testing_reset` cradle seeds
 * `[ROLE_KEEPER, ROLE_ADMIN]`), so it can both open the socket and offer
 * `ROLE_ADMIN`. Gated on `capabilities.ws`.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '$lib/testing/cross_backend/setup.ts';
import { describe_role_grant_offer_notification_ws_tests } from '$lib/testing/cross_backend/role_grant_offer_notification_ws.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { capabilities, base_url, ws_path } = handle.config;

describe_role_grant_offer_notification_ws_tests({
	setup_test,
	capabilities,
	base_url,
	ws_path
});
