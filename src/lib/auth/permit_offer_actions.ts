/**
 * Permit offer RPC actions — the consentful-permits action surface.
 *
 * Five actions: create / accept / decline / retract / list. All mount on
 * a consumer's JSON-RPC endpoint via `create_rpc_endpoint`. Mutations
 * declare `side_effects: true` so the RPC dispatcher wraps the handler
 * in a DB transaction; `permit_offer_list` declares `side_effects: false`
 * so it is addressable via GET.
 *
 * Authorization:
 * - `permit_offer_create` — the grantor must hold an active permit for the
 *   role being offered, and that role must be `web_grantable`. Consumers
 *   needing a richer policy (e.g., "teacher may offer student in *their*
 *   classroom") pass an `authorize` callback that overrides the default.
 * - `permit_offer_accept` / `permit_offer_decline` — keyed to the caller's
 *   account; `query_*` helpers enforce the IDOR guard.
 * - `permit_offer_retract` — keyed to the caller's actor.
 * - `permit_offer_list` — self by default; `{account_id}` is admin-only.
 *
 * Audit events are emitted in-transaction by the query layer (atomic with
 * the permit write on accept) or by the handler via `audit_log_fire_and_forget`
 * for single-event lifecycle transitions. `on_audit_event` (SSE broadcast)
 * fires post-commit in both paths.
 *
 * WS notifications are not sent from this file — the notification layer
 * wires into handler return values (`superseded_offer_ids` etc.) in a
 * follow-up commit.
 *
 * @module
 */

import {z} from 'zod';

import {RequestResponseActionSpec} from '../actions/action_spec.js';
import type {ActionContext, RpcAction} from '../actions/action_rpc.js';
import {jsonrpc_errors} from '../http/jsonrpc_errors.js';
import {emit_after_commit} from '../http/pending_effects.js';
import {Uuid} from '../uuid.js';
import {BUILTIN_ROLE_OPTIONS, RoleName, type RoleSchemaResult} from './role_schema.js';
import {
	PERMIT_OFFER_DEFAULT_TTL_MS,
	PERMIT_OFFER_MESSAGE_LENGTH_MAX,
	PermitOfferJson,
	to_permit_offer_json,
} from './permit_offer_schema.js';
import {
	query_permit_offer_create,
	query_permit_offer_decline,
	query_permit_offer_retract,
	query_permit_offer_list,
	query_accept_offer,
	PermitOfferAlreadyTerminalError,
	PermitOfferExpiredError,
	PermitOfferNotFoundError,
	PermitOfferSelfTargetError,
} from './permit_offer_queries.js';
import {query_permit_has_role} from './permit_queries.js';
import {query_actor_by_id} from './account_queries.js';
import {audit_log_fire_and_forget} from './audit_log_queries.js';
import type {AuditLogEvent} from './audit_log_schema.js';
import {has_role, type RequestContext} from './request_context.js';
import type {RouteFactoryDeps} from './deps.js';
import {
	build_permit_offer_accepted_notification,
	build_permit_offer_declined_notification,
	build_permit_offer_received_notification,
	build_permit_offer_retracted_notification,
	build_permit_offer_supersede_notification,
	type NotificationSender,
} from './permit_offer_notifications.js';

/** Error reason — caller tried to offer themselves a permit. */
export const ERROR_OFFER_SELF_TARGET = 'offer_self_target' as const;
/** Error reason — offer is declined, retracted, or superseded. */
export const ERROR_OFFER_TERMINAL = 'offer_terminal' as const;
/** Error reason — offer's `expires_at` has passed. */
export const ERROR_OFFER_EXPIRED = 'offer_expired' as const;
/** Error reason — offer does not exist or belongs to a different recipient (404-over-403 IDOR mask). */
export const ERROR_OFFER_NOT_FOUND = 'offer_not_found' as const;
/** Error reason — the offered role is not `web_grantable` (nobody may offer it via this surface). */
export const ERROR_OFFER_ROLE_NOT_GRANTABLE = 'offer_role_not_grantable' as const;
/** Error reason — caller is not authorized to offer this role (default policy: caller lacks the role; consumer `authorize` callback may add further policy). */
export const ERROR_OFFER_NOT_AUTHORIZED = 'offer_not_authorized' as const;

/**
 * Authorization callback for `permit_offer_create`. Returns `true` to allow,
 * `false` to reject (handler converts to `forbidden`).
 *
 * Provided with the fully-resolved request context and the parsed input
 * (pre-TTL, pre-normalization). Consumers override the default to implement
 * policies like "teacher may offer classroom_student only in classrooms they
 * teach".
 */
export type PermitOfferCreateAuthorize = (
	auth: RequestContext,
	input: {to_account_id: string; role: string; scope_id: string | null},
	deps: Pick<RouteFactoryDeps, 'log'>,
	ctx: ActionContext,
) => boolean | Promise<boolean>;

/** Options for {@link create_permit_offer_actions}. */
export interface PermitOfferActionOptions {
	/**
	 * Role schema result from `create_role_schema()`. Defaults to builtin roles only.
	 * The `role_options` map is read for `web_grantable` lookups.
	 */
	roles?: RoleSchemaResult;
	/** TTL applied to newly-created offers. Defaults to {@link PERMIT_OFFER_DEFAULT_TTL_MS}. */
	default_ttl_ms?: number;
	/**
	 * Custom authorization for `permit_offer_create`. The default requires the
	 * caller to hold an active permit for the offered role *and* the role to
	 * be `web_grantable`. Consumers with richer policies (scope-aware, chained
	 * roles) override this.
	 */
	authorize?: PermitOfferCreateAuthorize;
}

// -- Input/output schemas ---------------------------------------------------

/** Input for `permit_offer_create`. */
export const PermitOfferCreateInput = z.strictObject({
	to_account_id: Uuid.meta({description: 'Account id of the recipient.'}),
	role: RoleName.meta({description: 'Role being offered.'}),
	scope_id: Uuid.nullish().meta({
		description: 'Scope id for resource-scoped grants (e.g. classroom id). `null` for global.',
	}),
	message: z
		.string()
		.max(PERMIT_OFFER_MESSAGE_LENGTH_MAX)
		.nullish()
		.meta({description: 'Optional free-form note from the grantor.'}),
});
export type PermitOfferCreateInput = z.infer<typeof PermitOfferCreateInput>;

/** Input for `permit_offer_accept`. */
export const PermitOfferAcceptInput = z.strictObject({
	offer_id: Uuid.meta({description: 'The offer to accept.'}),
});
export type PermitOfferAcceptInput = z.infer<typeof PermitOfferAcceptInput>;

/** Input for `permit_offer_decline`. */
export const PermitOfferDeclineInput = z.strictObject({
	offer_id: Uuid.meta({description: 'The offer to decline.'}),
	reason: z
		.string()
		.max(PERMIT_OFFER_MESSAGE_LENGTH_MAX)
		.nullish()
		.meta({description: 'Optional free-form reason given on decline.'}),
});
export type PermitOfferDeclineInput = z.infer<typeof PermitOfferDeclineInput>;

/** Input for `permit_offer_retract`. */
export const PermitOfferRetractInput = z.strictObject({
	offer_id: Uuid.meta({description: 'The offer to retract.'}),
});
export type PermitOfferRetractInput = z.infer<typeof PermitOfferRetractInput>;

/** Input for `permit_offer_list`. `account_id` is admin-only (inspect another account's inbox). */
export const PermitOfferListInput = z.strictObject({
	account_id: Uuid.nullish().meta({
		description: 'Admin-only — list offers for another account. Defaults to the caller.',
	}),
});
export type PermitOfferListInput = z.infer<typeof PermitOfferListInput>;

/** Output for `permit_offer_create`. */
export const PermitOfferCreateOutput = z.strictObject({
	offer: PermitOfferJson,
});

/** Output for `permit_offer_accept`. */
export const PermitOfferAcceptOutput = z.strictObject({
	permit_id: Uuid,
	offer: PermitOfferJson,
	superseded_offer_ids: z.array(Uuid),
});

/** Output for `permit_offer_decline` / `permit_offer_retract`. */
export const PermitOfferOkOutput = z.strictObject({ok: z.literal(true)});

/** Output for `permit_offer_list`. */
export const PermitOfferListOutput = z.strictObject({offers: z.array(PermitOfferJson)});

// -- Method names (exported so tests / notification layer can reference) ----

export const PERMIT_OFFER_CREATE_METHOD = 'permit_offer_create';
export const PERMIT_OFFER_ACCEPT_METHOD = 'permit_offer_accept';
export const PERMIT_OFFER_DECLINE_METHOD = 'permit_offer_decline';
export const PERMIT_OFFER_RETRACT_METHOD = 'permit_offer_retract';
export const PERMIT_OFFER_LIST_METHOD = 'permit_offer_list';

// -- Helpers ----------------------------------------------------------------

/** Fire `on_audit_event` for each event — used by accept, whose events were written in-transaction. */
const fan_out_audit_events = (
	events: Array<AuditLogEvent>,
	on_audit_event: (event: AuditLogEvent) => void,
	log: ActionContext['log'],
): void => {
	for (const event of events) {
		try {
			on_audit_event(event);
		} catch (err) {
			log.error('on_audit_event callback failed:', err);
		}
	}
};

const default_authorize: PermitOfferCreateAuthorize = async (auth, input, _deps, ctx) => {
	// Caller must hold an active permit for the offered role. Global (no scope)
	// check — the scope-aware "only in this classroom" policy is consumer-level.
	return query_permit_has_role(ctx, auth.actor.id, input.role);
};

/**
 * Narrow `ctx.auth` to non-null. The RPC dispatcher has already enforced
 * `auth: 'authenticated'` before the handler runs — this is a type narrow,
 * not a runtime check that would otherwise fail.
 */
const require_request_auth = (auth: RequestContext | null): RequestContext => {
	if (!auth) throw new Error('unreachable: action auth guard did not enforce authentication');
	return auth;
};

// -- Action factory ---------------------------------------------------------

/**
 * Dependencies for {@link create_permit_offer_actions}.
 *
 * `notification_sender` is optional — when absent, WS fan-out is silently
 * skipped. Consumers wiring `BackendWebsocketTransport` assign its instance
 * directly (the transport's `send_to_account` signature accepts the broader
 * `JsonrpcMessageFromServerToClient`, which is contravariantly compatible).
 */
export interface PermitOfferActionDeps extends Pick<RouteFactoryDeps, 'log' | 'on_audit_event'> {
	/** Optional WS fan-out primitive. `null` or absent → notifications skipped. */
	notification_sender?: NotificationSender | null;
}

/**
 * Create the five permit-offer RPC actions.
 *
 * @param deps - stateless capabilities; needs `log` and `on_audit_event`; optional `notification_sender` for WS fan-out
 * @param options - role schema, default TTL, authorization override
 * @returns the `RpcAction` array to spread into a `create_rpc_endpoint` call
 */
export const create_permit_offer_actions = (
	deps: PermitOfferActionDeps,
	options: PermitOfferActionOptions = {},
): Array<RpcAction> => {
	const {on_audit_event, log, notification_sender = null} = deps;
	const role_options = options.roles?.role_options ?? BUILTIN_ROLE_OPTIONS;
	const default_ttl_ms = options.default_ttl_ms ?? PERMIT_OFFER_DEFAULT_TTL_MS;
	const authorize = options.authorize ?? default_authorize;

	const create_spec = RequestResponseActionSpec.parse({
		method: PERMIT_OFFER_CREATE_METHOD,
		kind: 'request_response',
		initiator: 'frontend',
		auth: 'authenticated',
		side_effects: true,
		input: PermitOfferCreateInput,
		output: PermitOfferCreateOutput,
		async: true,
		description:
			'Offer a permit to another account. Grantor must hold the offered role (or pass a consumer authorize callback); role must be web_grantable.',
	});

	const create_handler = async (
		input: PermitOfferCreateInput,
		ctx: ActionContext,
	): Promise<z.infer<typeof PermitOfferCreateOutput>> => {
		const auth = require_request_auth(ctx.auth);

		// Role must be web_grantable — same gate as admin direct-grant.
		const rc = role_options.get(input.role);
		if (!rc?.web_grantable) {
			void audit_log_fire_and_forget(
				ctx,
				{
					event_type: 'permit_offer_create',
					outcome: 'failure',
					actor_id: auth.actor.id,
					account_id: auth.account.id,
					target_account_id: input.to_account_id,
					ip: null,
					metadata: {
						role: input.role,
						scope_id: input.scope_id ?? null,
						to_account_id: input.to_account_id,
					},
				},
				log,
				on_audit_event,
			);
			throw jsonrpc_errors.forbidden('role not grantable', {
				reason: ERROR_OFFER_ROLE_NOT_GRANTABLE,
			});
		}

		const authorized = await authorize(
			auth,
			{
				to_account_id: input.to_account_id,
				role: input.role,
				scope_id: input.scope_id ?? null,
			},
			{log},
			ctx,
		);
		if (!authorized) {
			void audit_log_fire_and_forget(
				ctx,
				{
					event_type: 'permit_offer_create',
					outcome: 'failure',
					actor_id: auth.actor.id,
					account_id: auth.account.id,
					target_account_id: input.to_account_id,
					ip: null,
					metadata: {
						role: input.role,
						scope_id: input.scope_id ?? null,
						to_account_id: input.to_account_id,
					},
				},
				log,
				on_audit_event,
			);
			throw jsonrpc_errors.forbidden('not authorized to offer this role', {
				reason: ERROR_OFFER_NOT_AUTHORIZED,
			});
		}

		let offer;
		try {
			offer = await query_permit_offer_create(ctx, {
				from_actor_id: auth.actor.id,
				to_account_id: input.to_account_id,
				role: input.role,
				scope_id: input.scope_id ?? null,
				message: input.message ?? null,
				expires_at: new Date(Date.now() + default_ttl_ms),
			});
		} catch (err) {
			if (err instanceof PermitOfferSelfTargetError) {
				throw jsonrpc_errors.invalid_params('cannot offer to self', {
					reason: ERROR_OFFER_SELF_TARGET,
				});
			}
			throw err;
		}

		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'permit_offer_create',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				target_account_id: input.to_account_id,
				ip: null,
				metadata: {
					offer_id: offer.id,
					role: offer.role,
					scope_id: offer.scope_id,
					to_account_id: offer.to_account_id,
				},
			},
			log,
			on_audit_event,
		);

		const offer_json = to_permit_offer_json(offer);
		if (notification_sender) {
			emit_after_commit(ctx, () => {
				notification_sender.send_to_account(
					offer.to_account_id as Uuid,
					build_permit_offer_received_notification({offer: offer_json}),
				);
			});
		}

		return {offer: offer_json};
	};

	const accept_spec = RequestResponseActionSpec.parse({
		method: PERMIT_OFFER_ACCEPT_METHOD,
		kind: 'request_response',
		initiator: 'frontend',
		auth: 'authenticated',
		side_effects: true,
		input: PermitOfferAcceptInput,
		output: PermitOfferAcceptOutput,
		async: true,
		description:
			'Accept an offer. Atomically marks the offer accepted, inserts the permit, and supersedes sibling pending offers for the same (account, role, scope).',
	});

	const accept_handler = async (
		input: PermitOfferAcceptInput,
		ctx: ActionContext,
	): Promise<z.infer<typeof PermitOfferAcceptOutput>> => {
		const auth = require_request_auth(ctx.auth);
		let result;
		try {
			result = await query_accept_offer(ctx, {
				offer_id: input.offer_id,
				to_account_id: auth.account.id,
				ip: null,
			});
		} catch (err) {
			if (err instanceof PermitOfferNotFoundError) {
				throw jsonrpc_errors.not_found('offer', {reason: ERROR_OFFER_NOT_FOUND});
			}
			if (err instanceof PermitOfferAlreadyTerminalError) {
				throw jsonrpc_errors.invalid_request({reason: ERROR_OFFER_TERMINAL});
			}
			if (err instanceof PermitOfferExpiredError) {
				throw jsonrpc_errors.invalid_request({reason: ERROR_OFFER_EXPIRED});
			}
			throw err;
		}

		// Look up the grantor's account_id inside the transaction so the
		// post-commit notification has a valid target. One cheap SELECT by
		// PK — the alternative (widening `query_accept_offer` again) would
		// bleed transport concerns into the query layer.
		const grantor_actor = notification_sender
			? await query_actor_by_id(ctx, result.offer.from_actor_id)
			: null;
		const grantor_account_id = grantor_actor?.account_id ?? null;

		const offer_json = to_permit_offer_json(result.offer);
		const supersede_payloads = result.superseded_offers.map((sib) => ({
			offer: to_permit_offer_json(sib),
			from_account_id: sib.from_account_id as Uuid,
		}));

		// Audit events are written in-transaction by query_accept_offer; wire
		// them through on_audit_event post-commit so SSE broadcasts fire.
		// WS notifications piggyback on the same post-commit microtask so the
		// grantor sees "accepted" and each superseded grantor sees
		// "supersede" only once the accept has durably committed.
		emit_after_commit(ctx, () => {
			fan_out_audit_events(result.audit_events, on_audit_event, ctx.log);
			if (notification_sender && grantor_account_id) {
				notification_sender.send_to_account(
					grantor_account_id as Uuid,
					build_permit_offer_accepted_notification({offer: offer_json}),
				);
			}
			if (notification_sender) {
				for (const sib of supersede_payloads) {
					notification_sender.send_to_account(
						sib.from_account_id,
						build_permit_offer_supersede_notification({
							offer: sib.offer,
							reason: 'sibling_accepted',
							cause_id: result.offer.id as Uuid,
						}),
					);
				}
			}
		});

		return {
			permit_id: result.permit.id as z.infer<typeof Uuid>,
			offer: offer_json,
			superseded_offer_ids: result.superseded_offers.map((o) => o.id as z.infer<typeof Uuid>),
		};
	};

	const decline_spec = RequestResponseActionSpec.parse({
		method: PERMIT_OFFER_DECLINE_METHOD,
		kind: 'request_response',
		initiator: 'frontend',
		auth: 'authenticated',
		side_effects: true,
		input: PermitOfferDeclineInput,
		output: PermitOfferOkOutput,
		async: true,
		description: 'Decline an offer. Recipient-only.',
	});

	const decline_handler = async (
		input: PermitOfferDeclineInput,
		ctx: ActionContext,
	): Promise<z.infer<typeof PermitOfferOkOutput>> => {
		const auth = require_request_auth(ctx.auth);
		let declined;
		try {
			declined = await query_permit_offer_decline(
				ctx,
				input.offer_id,
				auth.account.id,
				input.reason ?? null,
			);
		} catch (err) {
			if (err instanceof PermitOfferAlreadyTerminalError) {
				throw jsonrpc_errors.invalid_request({reason: ERROR_OFFER_TERMINAL});
			}
			throw err;
		}
		if (!declined) {
			throw jsonrpc_errors.not_found('offer', {reason: ERROR_OFFER_NOT_FOUND});
		}

		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'permit_offer_decline',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: null,
				metadata: {
					offer_id: declined.id,
					role: declined.role,
					scope_id: declined.scope_id,
					reason: input.reason ?? undefined,
				},
			},
			log,
			on_audit_event,
		);

		if (notification_sender) {
			// Look up the grantor's account (SELECT by PK, same tx) for the
			// notification target. The decline reason rides along on
			// `offer.decline_reason` — the DB set it in the RETURNING above.
			const grantor_actor = await query_actor_by_id(ctx, declined.from_actor_id);
			const grantor_account_id = grantor_actor?.account_id ?? null;
			if (grantor_account_id) {
				const offer_json = to_permit_offer_json(declined);
				emit_after_commit(ctx, () => {
					notification_sender.send_to_account(
						grantor_account_id as Uuid,
						build_permit_offer_declined_notification({offer: offer_json}),
					);
				});
			}
		}

		return {ok: true};
	};

	const retract_spec = RequestResponseActionSpec.parse({
		method: PERMIT_OFFER_RETRACT_METHOD,
		kind: 'request_response',
		initiator: 'frontend',
		auth: 'authenticated',
		side_effects: true,
		input: PermitOfferRetractInput,
		output: PermitOfferOkOutput,
		async: true,
		description: 'Retract an offer. Grantor-only, pre-decision.',
	});

	const retract_handler = async (
		input: PermitOfferRetractInput,
		ctx: ActionContext,
	): Promise<z.infer<typeof PermitOfferOkOutput>> => {
		const auth = require_request_auth(ctx.auth);
		let retracted;
		try {
			retracted = await query_permit_offer_retract(ctx, input.offer_id, auth.actor.id);
		} catch (err) {
			if (err instanceof PermitOfferAlreadyTerminalError) {
				throw jsonrpc_errors.invalid_request({reason: ERROR_OFFER_TERMINAL});
			}
			throw err;
		}
		if (!retracted) {
			throw jsonrpc_errors.not_found('offer', {reason: ERROR_OFFER_NOT_FOUND});
		}

		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'permit_offer_retract',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: null,
				metadata: {
					offer_id: retracted.id,
					role: retracted.role,
					scope_id: retracted.scope_id,
				},
			},
			log,
			on_audit_event,
		);

		if (notification_sender) {
			const offer_json = to_permit_offer_json(retracted);
			emit_after_commit(ctx, () => {
				notification_sender.send_to_account(
					retracted.to_account_id as Uuid,
					build_permit_offer_retracted_notification({offer: offer_json}),
				);
			});
		}

		return {ok: true};
	};

	const list_spec = RequestResponseActionSpec.parse({
		method: PERMIT_OFFER_LIST_METHOD,
		kind: 'request_response',
		initiator: 'frontend',
		auth: 'authenticated',
		side_effects: false,
		input: PermitOfferListInput,
		output: PermitOfferListOutput,
		async: true,
		description:
			'List pending, non-expired offers for the caller. Admins may pass `account_id` to inspect another account.',
	});

	const list_handler = async (
		input: PermitOfferListInput,
		ctx: ActionContext,
	): Promise<z.infer<typeof PermitOfferListOutput>> => {
		const auth = require_request_auth(ctx.auth);
		const target = input.account_id ?? auth.account.id;
		if (target !== auth.account.id && !has_role(auth, 'admin')) {
			throw jsonrpc_errors.forbidden('admin required to inspect another account');
		}
		const offers = await query_permit_offer_list(ctx, target);
		return {offers: offers.map(to_permit_offer_json)};
	};

	return [
		{spec: create_spec, handler: create_handler as RpcAction['handler']},
		{spec: accept_spec, handler: accept_handler as RpcAction['handler']},
		{spec: decline_spec, handler: decline_handler as RpcAction['handler']},
		{spec: retract_spec, handler: retract_handler as RpcAction['handler']},
		{spec: list_spec, handler: list_handler as RpcAction['handler']},
	];
};
