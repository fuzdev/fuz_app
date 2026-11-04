/**
 * Action spec types — the canonical source of truth for action contracts.
 *
 * Extracted from zzz's action system. Action specs define method, kind,
 * auth, side effects, and input/output schemas. `actions/action_bridge.ts`
 * derives the SSE `EventSpec` of a notification from one.
 *
 * A spec is a plain object typed by these interfaces, written with
 * `satisfies` (`satisfies RequestResponseActionSpec`) so its literal types
 * survive; nothing parses a spec at runtime. Its `input` and `output` are
 * schemas of either library, Zod or `@fuzdev/fuz_schema` (`ValidationSchema`).
 * The registration-time checks live in `actions/compile_action_registry.ts`.
 *
 * @see `actions/action_rpc.ts` for the JSON-RPC dispatcher
 * @see `actions/register_action_ws.ts` for the WebSocket dispatcher
 *
 * @module
 */

import { z } from 'zod';
import type { void as fuz_void } from '@fuzdev/fuz_schema/schema.ts';

import type { RateLimitKey } from '../http/error_schemas.ts';
import type { RouteAuth } from '../http/auth_shape.ts';
import type { ValidationSchema } from '../schema_issues.ts';

/** The action kinds, in declaration order — what `ActionKind` and `is_action_spec` read. */
export const ACTION_KINDS = ['request_response', 'remote_notification', 'local_call'] as const;
export const ActionKind = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof ActionKind>;

/** Which side initiates an action — what `ActionInitiator` reads. */
export const ACTION_INITIATORS = ['frontend', 'backend', 'both'] as const;
export const ActionInitiator = z.enum(ACTION_INITIATORS);
export type ActionInitiator = z.infer<typeof ActionInitiator>;

/** The fields every action spec carries; each kind narrows some of them. */
export interface ActionSpec {
	method: string;
	kind: ActionKind;
	initiator: ActionInitiator;
	/**
	 * The flat auth shape (canonical schema in `http/auth_shape.ts`).
	 * `null` for `remote_notification` and `local_call` — those don't
	 * dispatch through the request/response auth gate.
	 *
	 * See `http/auth_shape.ts` for the design rationale (orthogonal
	 * authentication / account-resolution / actor-resolution / role-and-
	 * credential authorization axes). `required_scope` is the one field an
	 * action may not set — `compile_action_registry` rejects it, since
	 * nothing on the RPC path mounts a guard from it; the dispatcher derives
	 * the same `rpc:<method>` capability from `spec.method` instead.
	 */
	auth: RouteAuth | null;
	side_effects: boolean;
	/** The input schema, Zod or `@fuzdev/fuz_schema`. */
	input: ValidationSchema;
	/** The output schema, Zod or `@fuzdev/fuz_schema`. */
	output: ValidationSchema;
	async: boolean;
	description: string;
	/**
	 * Names the notification method this action emits as request-scoped
	 * progress. Forward-compatible handshake — transport-agnostic, does not
	 * imply a specific delivery mechanism. Registry-time validation (e.g.,
	 * ensuring the named method is a `remote_notification` spec) is a
	 * consumer-side concern.
	 */
	streams?: string;
	/**
	 * Error reason codes this action may surface via `error.data.reason` on
	 * failure. Declarative metadata mirroring the `streams` precedent —
	 * codegen, UI form-state matching, and docs read it off the spec instead
	 * of scanning handler implementations. Reuses the same `as const` string
	 * constants the handler throws (e.g. `ERROR_ROLE_GRANT_OFFER_*`) so call sites can
	 * import either side. Optional — actions that surface only standard
	 * transport errors leave it unset.
	 */
	error_reasons?: ReadonlyArray<string>;
	/**
	 * Rate limit key the RPC dispatcher consults for this action. Optional —
	 * actions without it skip the rate-limit hook entirely.
	 *
	 * - `'ip'` — keyed on the resolved client IP (`get_client_ip(c)`).
	 * - `'account'` — keyed on the post-auth account id (`request_context.account.id`).
	 *   Registration-time error if paired with `auth.account !== 'required'`
	 *   (no account to key on).
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
	rate_limit?: RateLimitKey;
}

/** A request answered with a response, through the auth gate. */
export interface RequestResponseActionSpec extends ActionSpec {
	kind: 'request_response';
	auth: RouteAuth;
	async: true;
}

/** A one-way message; its output is a void schema, Zod's `z.void()` or fuz_schema's `s.void`. */
export interface RemoteNotificationActionSpec extends ActionSpec {
	kind: 'remote_notification';
	auth: null;
	side_effects: true;
	output: z.ZodVoid | typeof fuz_void;
	async: true;
}

/**
 * Local calls can wrap synchronous or asynchronous actions, and are the
 * escape hatch for remote APIs that do not support SAES.
 */
export interface LocalCallActionSpec extends ActionSpec {
	kind: 'local_call';
	auth: null;
}

/** Any action spec, discriminated by `kind`. */
export type ActionSpecUnion =
	RequestResponseActionSpec | RemoteNotificationActionSpec | LocalCallActionSpec;

/** Structural type guard for any `ActionSpecUnion` variant — checks `kind` is one of `ACTION_KINDS`. */
export const is_action_spec = (value: unknown): value is ActionSpecUnion =>
	value !== null &&
	typeof value === 'object' &&
	'method' in value &&
	'kind' in value &&
	(ACTION_KINDS as ReadonlyArray<unknown>).includes(value.kind);

/** The action event phases — what `ActionEventPhase` reads. */
export const ACTION_EVENT_PHASES = [
	'send_request',
	'receive_request',
	'send_response',
	'receive_response',
	'send_error',
	'receive_error',
	'send',
	'receive',
	'execute'
] as const;
export const ActionEventPhase = z.enum(ACTION_EVENT_PHASES);
export type ActionEventPhase = z.infer<typeof ActionEventPhase>;
