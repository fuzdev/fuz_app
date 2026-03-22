/**
 * Action spec types — the canonical source of truth for action contracts.
 *
 * Extracted from zzz's action system. Action specs define method, kind,
 * auth, side effects, and input/output schemas. Bridge functions in
 * `action_bridge.ts` derive `RouteSpec` and `SseEventSpec` from them.
 *
 * TODO @action-system-review The action system (action_spec, action_registry,
 * action_codegen, action_bridge) will evolve significantly with the saes-rpc quest.
 * Current state: bridge is stable, registry and codegen are partially stub API.
 * Search for `@action-system-review` across the actions/ and routes/ modules.
 *
 * @module
 */

import {z} from 'zod';

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

export const ActionSideEffects = z.union([z.literal(true), z.null()]);
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
	side_effects: z.literal(true).nullable().default(true),
	output: z.custom<z.ZodVoid>((v) => v instanceof z.ZodVoid),
	async: z.literal(true).default(true),
});
export type RemoteNotificationActionSpec = z.infer<typeof RemoteNotificationActionSpec>;

/**
 * Local calls can wrap synchronous or asynchronous actions,
 * and are the escape hatch for remote APIs that do not support SAES.
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
