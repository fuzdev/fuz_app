/**
 * Action spec types — the canonical source of truth for action contracts.
 *
 * Extracted from zzz's action system. Action specs define method, kind,
 * auth, side effects, and input/output schemas. Bridge functions in
 * `actions/action_bridge.ts` derive `RouteSpec` and `EventSpec` from them.
 *
 * @see `actions/action_rpc.ts` for the JSON-RPC dispatcher
 * @see `actions/register_action_ws.ts` for the WebSocket dispatcher
 *
 * @module
 */

import {z} from 'zod';

import {RateLimitKey} from '../http/error_schemas.js';

export const ActionKind = z.enum(['request_response', 'remote_notification', 'local_call']);
export type ActionKind = z.infer<typeof ActionKind>;

export const ActionInitiator = z.enum(['frontend', 'backend', 'both']);
export type ActionInitiator = z.infer<typeof ActionInitiator>;

export const ActionAuth = z.union([
	z.literal('public'),
	z.literal('authenticated'),
	z.literal('keeper'),
	z.strictObject({role: z.string()}),
]);
export type ActionAuth = z.infer<typeof ActionAuth>;

export const ActionSideEffects = z.boolean();
export type ActionSideEffects = z.infer<typeof ActionSideEffects>;

export const ActionSpec = z.strictObject({
	method: z.string(),
	kind: ActionKind,
	initiator: ActionInitiator,
	auth: ActionAuth.nullable(),
	side_effects: ActionSideEffects,
	input: z.custom<z.ZodType>((v) => v instanceof z.ZodType),
	output: z.custom<z.ZodType>((v) => v instanceof z.ZodType),
	async: z.boolean(),
	description: z.string(),
	/**
	 * Names the notification method this action emits as request-scoped
	 * progress. Forward-compatible handshake — transport-agnostic, does not
	 * imply a specific delivery mechanism. Registry-time validation (e.g.,
	 * ensuring the named method is a `remote_notification` spec) is a
	 * consumer-side concern.
	 */
	streams: z.string().optional(),
	/**
	 * Error reason codes this action may surface via `error.data.reason` on
	 * failure. Declarative metadata mirroring the `streams` precedent —
	 * codegen, UI form-state matching, and docs read it off the spec instead
	 * of scanning handler implementations. Reuses the same `as const` string
	 * constants the handler throws (e.g. `ERROR_OFFER_*`) so call sites can
	 * import either side. Optional — actions that surface only standard
	 * transport errors leave it unset.
	 */
	error_reasons: z.array(z.string()).readonly().optional(),
	/**
	 * Rate limit key the RPC dispatcher consults for this action. Optional —
	 * actions without it skip the rate-limit hook entirely.
	 *
	 * - `'ip'` — keyed on the resolved client IP (`get_client_ip(c)`).
	 * - `'account'` — keyed on the post-auth actor id (`request_context.actor.id`).
	 *   Registration-time error if paired with `auth: 'public'` (no actor).
	 * - `'both'` — both checks run; either can block.
	 *
	 * Throttle-requests semantics — every invocation records, regardless of
	 * outcome (different from REST login's throttle-failures, which resets
	 * on success). Suits admin mutation oracles (`invite_create` account-
	 * existence probe) where the *successful* invocation is the threat.
	 *
	 * Today only `RequestResponseActionSpec` is consulted by the RPC
	 * dispatcher. The field is on the base for shape symmetry with
	 * `streams` and `error_reasons`; remote_notification / local_call
	 * dispatchers don't read it.
	 */
	rate_limit: RateLimitKey.optional(),
});
export type ActionSpec = z.infer<typeof ActionSpec>;

export const RequestResponseActionSpec = ActionSpec.extend({
	kind: z.literal('request_response').default('request_response'),
	auth: ActionAuth,
	async: z.literal(true).default(true),
});
export type RequestResponseActionSpec = z.infer<typeof RequestResponseActionSpec>;

export const RemoteNotificationActionSpec = ActionSpec.extend({
	kind: z.literal('remote_notification').default('remote_notification'),
	auth: z.null().default(null),
	side_effects: z.literal(true).default(true),
	output: z.custom<z.ZodVoid>((v) => v instanceof z.ZodVoid),
	async: z.literal(true).default(true),
});
export type RemoteNotificationActionSpec = z.infer<typeof RemoteNotificationActionSpec>;

/**
 * Local calls can wrap synchronous or asynchronous actions, and are the
 * escape hatch for remote APIs that do not support SAES.
 */
export const LocalCallActionSpec = ActionSpec.extend({
	kind: z.literal('local_call').default('local_call'),
	auth: z.null().default(null),
});
export type LocalCallActionSpec = z.infer<typeof LocalCallActionSpec>;

export const ActionSpecUnion = z.union([
	RequestResponseActionSpec,
	RemoteNotificationActionSpec,
	LocalCallActionSpec,
]);
export type ActionSpecUnion = z.infer<typeof ActionSpecUnion>;

/** Structural type guard for any `ActionSpecUnion` variant — checks `kind` is one of the three known values. */
export const is_action_spec = (value: unknown): value is ActionSpecUnion =>
	value !== null &&
	typeof value === 'object' &&
	'method' in value &&
	'kind' in value &&
	(ActionKind.options as ReadonlyArray<string>).includes(value.kind as string);

export const ActionEventPhase = z.enum([
	'send_request',
	'receive_request',
	'send_response',
	'receive_response',
	'send_error',
	'receive_error',
	'send',
	'receive',
	'execute',
]);
export type ActionEventPhase = z.infer<typeof ActionEventPhase>;
