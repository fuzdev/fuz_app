/**
 * Cross-process SSE suite for fuz_app's own spine over real HTTP.
 *
 * Companion to `auth.cross.test.ts` (HTTP + RPC) and `ws.cross.test.ts` (live
 * WebSocket): this one drives the live audit-log SSE path via a real
 * streaming `fetch` against the spawned spine binary. Runs under every
 * `cross_backend_*` project, but only the TS spines advertise
 * `capabilities.sse` (they wire `audit_log_sse`); the Rust `spine_stub`
 * leaves `sse: false`, so the suite's cases surface as `.skip` there.
 *
 * The fresh-per-test keeper holds `ROLE_ADMIN` by default, so it can
 * subscribe to the admin-gated stream and drive the revoke RPCs the
 * data-frame + close cases need.
 *
 * On the spine that does *not* advertise `sse`, one `xfail_until` row pins
 * the deferred divergence explicitly: the spine serves no end-to-end
 * audit-log SSE stream, so opening the stream fails. The capability `.skip`
 * above is the right signal for a consumer that simply chose not to wire
 * SSE; this marker is the self-cleaning tripwire for the spine that *should*
 * gain it — it flips red the moment the stream starts connecting, forcing
 * removal of both the marker and the `sse: false` capability.
 *
 * @module
 */

import {inject} from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '$lib/testing/cross_backend/setup.js';
import {describe_cross_process_sse_tests} from '$lib/testing/cross_backend/sse_round_trip.js';
import {create_sse_transport} from '$lib/testing/transports/sse_transport.js';
import {xfail_until} from '$lib/testing/cross_backend/xfail.js';

import './cross_test_types.js';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const {capabilities} = handle.config;
const base_url = handle.config.base_url;
const sse_path = handle.config.sse_path ?? '/api/admin/audit/stream';
const origin = base_url;

describe_cross_process_sse_tests({
	setup_test,
	capabilities,
	base_url,
	sse_path: handle.config.sse_path,
	rpc_path: handle.config.rpc_path,
});

// Spines without an end-to-end SSE stream advertise `sse: false` and skip the
// suite above. For such a spine, assert the absence loudly: opening the stream
// must fail (the endpoint serves no `text/event-stream`). Self-cleaning — once
// the spine grows real SSE, the connect succeeds and this `test.fails` turns
// red, forcing the marker + the capability flag to be removed together.
if (!capabilities.sse) {
	xfail_until(
		'audit-log-sse-rust-spine',
		'spine advertises no audit-log SSE stream',
		'opening the audit-log SSE stream fails on a spine without sse',
		async () => {
			const fixture = await setup_test();
			const sse = await create_sse_transport({
				base_url,
				sse_path,
				cookies: fixture.transport.cookies(),
				origin,
			});
			await sse.close();
		},
	);
}
