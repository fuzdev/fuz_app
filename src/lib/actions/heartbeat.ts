/**
 * Shared heartbeat action — a fuz_app protocol action carrying both a spec
 * and a handler in one tuple. Consumers spread `heartbeat_action` (or the
 * `protocol_actions` bundle from `actions/protocol.ts`) into the server's
 * `actions` array so disconnect detection works identically across every
 * repo without per-consumer ping plumbing.
 *
 * The client's activity-aware heartbeat timer (in
 * `FrontendWebsocketClient`) issues a `heartbeat` request whenever the
 * connection has been idle for its configured interval; server-side the
 * dispatcher tracks receive time, so incoming heartbeats keep the socket
 * alive without any handler-level state.
 *
 * Nullary input/output today. `{client_ts, server_ts}` fields can be added
 * later if clock-skew telemetry ever matters — the `Action` container
 * is open for additions without churning consumer call sites.
 *
 * @module
 */

import {z} from 'zod';

import type {RequestResponseActionSpec} from './action_spec.js';
import type {Action} from './action_types.js';

/**
 * `ActionSpec` for the shared heartbeat. `authenticated` auth — upgrade-time
 * auth has already admitted the socket; heartbeats don't need role gating.
 * `side_effects: false` keeps it orthogonal to state changes.
 */
export const heartbeat_action_spec = {
	method: 'heartbeat',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: false,
	input: z.strictObject({}),
	output: z.strictObject({}),
	async: true,
	description: 'Shared activity ping — keeps the socket alive and exercises the dispatch path.',
} satisfies RequestResponseActionSpec;

/** Handler — nullary echo. Stateless, suitable for high-frequency pings. */
export const heartbeat_handler = (): Record<string, never> => ({});

/**
 * Protocol-action tuple — spread into the server's `actions` array for
 * dispatch (or via `protocol_actions` from `actions/protocol.ts`) so the
 * dispatcher resolves the heartbeat handler. The frontend-side spread
 * happens via `protocol_action_specs` — the client doesn't run the echo
 * handler, but the spec must be in `ActionRegistry` so `create_rpc_client`
 * types `app.api.heartbeat()` against the shared spec.
 */
export const heartbeat_action: Action = {
	spec: heartbeat_action_spec,
	handler: heartbeat_handler,
};
