/**
 * Audit log types and client-safe Zod schemas.
 *
 * Records auth mutations (login, logout, grant, revoke, etc.) for
 * security monitoring and operational visibility.
 *
 * Table DDL and indexes live in `auth/audit_log_ddl.ts`.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';
import {Blake3Hash} from '@fuzdev/fuz_util/hash_blake3.js';

import {AuthSessionJson} from './account_schema.js';
import {Email} from '../primitive_schemas.js';
import {ApiTokenId} from './api_token.js';

/**
 * All tracked auth event types. Frozen to convert accidental in-process
 * mutation (test cross-contamination, cast escapes) into loud TypeErrors.
 * Not a security boundary — in-process code has many other paths to subvert
 * audit logging.
 */
export const AUDIT_EVENT_TYPES = Object.freeze([
	'login',
	'logout',
	'bootstrap',
	'signup',
	'password_change',
	'session_revoke',
	'session_revoke_all',
	'token_create',
	'token_revoke',
	'token_revoke_all',
	'role_grant_create',
	'role_grant_revoke',
	'role_grant_offer_create',
	'role_grant_offer_accept',
	'role_grant_offer_decline',
	'role_grant_offer_retract',
	'role_grant_offer_expire',
	'role_grant_offer_supersede',
	'invite_create',
	'invite_delete',
	'app_settings_update',
] as const);

/** Zod schema for audit event types. */
export const AuditEventType = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = z.infer<typeof AuditEventType>;

/**
 * Letter start, then letters, digits, `_`, `.`, `/`, `-`. Accepts snake_case,
 * dotted, and namespaced consumer conventions; rejects empty strings, leading
 * separators, whitespace, and control characters.
 */
export const AUDIT_EVENT_TYPE_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_./-]*$/;

/** Zod schema for valid audit event-type name strings. */
export const AuditEventTypeName = z.string().regex(AUDIT_EVENT_TYPE_NAME_REGEX, {
	message: 'must start with a letter; only letters, digits, _ . / - allowed',
});
export type AuditEventTypeName = z.infer<typeof AuditEventTypeName>;

/** Zod schema for audit event outcomes. */
export const AuditOutcome = z.enum(['success', 'failure']);
export type AuditOutcome = z.infer<typeof AuditOutcome>;

/**
 * Per-event-type metadata Zod schemas. `z.looseObject` so consumers can
 * add fields while known ones are validated. The record is frozen to
 * catch mutation bugs at the key level (e.g. tests that try to swap in a
 * stub schema); the Zod schemas themselves are reachable and mutable —
 * freeze isn't a security boundary.
 */
export const audit_metadata_schemas = Object.freeze({
	login: z
		.looseObject({
			username: z.string().meta({description: 'Username submitted with the login attempt.'}),
		})
		.nullable(),
	logout: z.null(),
	bootstrap: z
		.looseObject({
			error: z.string().meta({description: 'Error message for a failed bootstrap attempt.'}),
		})
		.nullable(),
	signup: z.looseObject({
		username: z.string().meta({description: 'Username submitted at signup.'}),
		invite_id: Uuid.optional().meta({
			description:
				'Invite consumed by this signup. Set on success and on `race_lost` / `signup_conflict` failure rows when an invite was matched at attempt time.',
		}),
		open_signup: z.boolean().optional().meta({
			description:
				'True when the signup occurred via the `open_signup` setting (no invite required). Set on success rows under `open_signup` and on failure rows when the attempt was made under `open_signup`.',
		}),
		reason: z.string().optional().meta({
			description:
				'Failure category: `no_match` (no unclaimed invite matched), `race_lost` (invite was claimed between find and claim), `signup_conflict` (username/email already exists). Set only on `outcome=failure`.',
		}),
		email: Email.optional().meta({
			description:
				'Email submitted at signup — recorded on failure rows for forensic correlation. Omitted on success rows because the email is already tied to the resulting account.',
		}),
	}),
	password_change: z
		.looseObject({
			sessions_revoked: z.number().optional().meta({
				description:
					'Number of sessions revoked as a side effect of the password change. Present on `outcome=success`.',
			}),
			tokens_revoked: z.number().optional().meta({
				description:
					'Number of API tokens revoked as a side effect of the password change. Present on `outcome=success`.',
			}),
			reason: z.enum(['concurrent_change']).optional().meta({
				description:
					'Failure category. `concurrent_change` indicates another password change committed first against the same starting hash (verify-write race loser). Absent for typed-wrong-password failures.',
			}),
		})
		.nullable(),
	session_revoke: z.looseObject({
		session_id: Blake3Hash.meta({description: 'Blake3 hash identifying the revoked session row.'}),
	}),
	session_revoke_all: z.looseObject({
		// Omitted on `outcome='failure'` (no revocation attempted — e.g. target
		// account not found); `reason` carries the failure category, and
		// `attempted_account_id` preserves the probed id (the `target_account_id`
		// column is null in that case because it's a FK to `account`).
		count: z.number().optional().meta({
			description:
				'Number of sessions revoked. Omitted on `outcome=failure` because no revocation was attempted.',
		}),
		reason: z
			.string()
			.optional()
			.meta({description: 'Failure category. Set only on `outcome=failure`.'}),
		attempted_account_id: Uuid.optional().meta({
			description:
				'Probed account id when the target lookup missed (FK constraint forces `target_account_id` to null).',
		}),
	}),
	token_create: z.looseObject({
		token_id: ApiTokenId.meta({description: 'Public id of the created API token (`tok_…`).'}),
		name: z.string().meta({description: 'Operator-supplied label for the token.'}),
	}),
	token_revoke: z.looseObject({
		token_id: ApiTokenId.meta({description: 'Public id of the revoked API token (`tok_…`).'}),
	}),
	token_revoke_all: z.looseObject({
		// Same shape as `session_revoke_all` for failures.
		count: z.number().optional().meta({
			description:
				'Number of tokens revoked. Omitted on `outcome=failure` because no revocation was attempted.',
		}),
		reason: z
			.string()
			.optional()
			.meta({description: 'Failure category. Set only on `outcome=failure`.'}),
		attempted_account_id: Uuid.optional().meta({
			description:
				'Probed account id when the target lookup missed (FK constraint forces `target_account_id` to null).',
		}),
	}),
	// `role_grant_id` is optional on `role_grant_create` because failed grants
	// (e.g. admin-grant-path denied) never produce a role_grant row.
	// `self_service: true` is set by the self-service role toggle in
	// `self_service_role_actions.ts` — declared explicitly rather than
	// riding on `z.looseObject` permissiveness so the field is part of
	// the documented schema surface.
	role_grant_create: z.looseObject({
		role: z.string().meta({description: 'Role being granted.'}),
		role_grant_id: Uuid.optional().meta({
			description:
				'Id of the resulting role_grant row. Omitted when the grant failed (e.g. admin-grant-path denial).',
		}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the granted role_grant; null for global role_grants.',
		}),
		source_offer_id: Uuid.optional().meta({
			description: 'Offer this grant resolved, when the grant originated from an accepted offer.',
		}),
		self_service: z.boolean().optional().meta({
			description: 'True when the grant came from the self-service role toggle.',
		}),
	}),
	role_grant_revoke: z.looseObject({
		role: z.string().meta({description: 'Role being revoked.'}),
		role_grant_id: Uuid.meta({description: 'Id of the revoked role_grant row.'}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the revoked role_grant; null for global role_grants.',
		}),
		reason: z
			.string()
			.optional()
			.meta({description: 'Optional admin-supplied or self-service reason text.'}),
		self_service: z.boolean().optional().meta({
			description: 'True when the revoke came from the self-service role toggle.',
		}),
	}),
	// `offer_id` is optional because failed creates (e.g. admin-grant-path
	// denied, `authorize` callback denied) never produce an offer row.
	role_grant_offer_create: z.looseObject({
		offer_id: Uuid.optional().meta({
			description: 'Id of the created offer row. Omitted when the create failed before insert.',
		}),
		role: z.string().meta({description: 'Role being offered.'}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the offered role; null for global offers.',
		}),
		to_account_id: Uuid.meta({description: 'Account the offer is directed to.'}),
	}),
	// `role_grant_create` is emitted alongside on accept — two events per accept by
	// design: offer-lifecycle audit + role-grant-lifecycle audit.
	role_grant_offer_accept: z.looseObject({
		offer_id: Uuid.meta({description: 'Id of the accepted offer.'}),
		role_grant_id: Uuid.meta({description: 'Id of the resulting role_grant row.'}),
		role: z.string().meta({description: 'Role granted by the offer.'}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the resulting role_grant; null for global role_grants.',
		}),
	}),
	role_grant_offer_decline: z.looseObject({
		offer_id: Uuid.meta({description: 'Id of the declined offer.'}),
		role: z.string().meta({description: 'Role that was offered.'}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the offered role; null for global offers.',
		}),
		reason: z
			.string()
			.optional()
			.meta({description: 'Optional decline reason text from the recipient.'}),
	}),
	role_grant_offer_retract: z.looseObject({
		offer_id: Uuid.meta({description: 'Id of the retracted offer.'}),
		role: z.string().meta({description: 'Role that was offered.'}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the offered role; null for global offers.',
		}),
	}),
	role_grant_offer_expire: z.looseObject({
		offer_id: Uuid.meta({description: 'Id of the expired offer.'}),
		role: z.string().meta({description: 'Role that was offered.'}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the offered role; null for global offers.',
		}),
	}),
	// Emitted when an offer is obsoleted by an external event. `reason`
	// distinguishes the trigger; `cause_id` points to the accepted offer
	// (for `sibling_accepted`), the revoked role_grant (for `role_grant_revoked`),
	// or the destroyed parent scope row (for `scope_destroyed`).
	role_grant_offer_supersede: z.looseObject({
		offer_id: Uuid.meta({description: 'Id of the superseded offer.'}),
		role: z.string().meta({description: 'Role that was offered.'}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the offered role; null for global offers.',
		}),
		reason: z.enum(['sibling_accepted', 'role_grant_revoked', 'scope_destroyed']).meta({
			description:
				'Trigger that obsoleted the offer: a sibling offer was accepted, the resulting role_grant was revoked, or the parent scope row was destroyed.',
		}),
		cause_id: Uuid.meta({
			description:
				'Row that caused the supersede: accepted offer (`sibling_accepted`), revoked role_grant (`role_grant_revoked`), or destroyed parent scope row (`scope_destroyed`).',
		}),
	}),
	invite_create: z.looseObject({
		invite_id: Uuid.meta({description: 'Id of the created invite.'}),
		email: z.string().nullable().meta({description: 'Invited email address; null when not set.'}),
		username: z.string().nullable().meta({description: 'Invited username; null when not set.'}),
	}),
	invite_delete: z.looseObject({
		invite_id: Uuid.meta({description: 'Id of the deleted invite.'}),
	}),
	app_settings_update: z.looseObject({
		setting: z.string().meta({description: 'Name of the setting that changed.'}),
		old_value: z.unknown().meta({description: 'Setting value before the update.'}),
		new_value: z.unknown().meta({description: 'Setting value after the update.'}),
	}),
}) satisfies Record<AuditEventType, z.ZodType>;

/** Mapped type of metadata shapes per event type, derived from Zod schemas. */
export type AuditMetadataMap = {
	[K in AuditEventType]: z.infer<(typeof audit_metadata_schemas)[K]>;
};

/** Audit log row from the database. See `AuditLogEventJson` for `event_type` widening rationale. */
export interface AuditLogEvent {
	id: Uuid;
	seq: number;
	event_type: AuditEventTypeName;
	outcome: AuditOutcome;
	/**
	 * Operator (the actor that initiated the event) — populated when the
	 * request resolved an acting actor.
	 *
	 * Resolution is driven per-request by the route-spec wrapper / RPC
	 * dispatcher; a route gets an acting actor when its input schema
	 * declares `acting?: ActingActor` or its auth requires role_grants
	 * (`role` / `keeper`). Account-grain operations declare neither,
	 * so no actor is resolved and `actor_id` is null: login (also
	 * pre-credential), logout, signup, bootstrap, password_change,
	 * session/token revoke, app_settings_update, invite events.
	 * Role grant events, admin actions, and actor-targeted offers
	 * populate this with the initiator's actor.
	 */
	actor_id: Uuid | null;
	account_id: Uuid | null;
	target_account_id: Uuid | null;
	/**
	 * Actor-grain target — populated when the event subject is bound to
	 * a specific actor.
	 *
	 * Concretely:
	 * - Always populated: `role_grant_revoke` and `role_grant_create`
	 *   (admin direct-grant, self-service toggle, and in-tx
	 *   `role_grant_offer_accept` all populate both target columns — the
	 *   role_grant's grantee is the actor-grain subject regardless of who
	 *   initiated the grant), `role_grant_offer_accept` on accept (the
	 *   accept binds the actor deterministically), `role_grant_offer_decline`
	 *   (the grantor actor — decline is *to* the offering actor).
	 * - Conditionally populated: offer-shape events
	 *   (`role_grant_offer_create`, `_expire`, `_retract`, `_supersede`)
	 *   carry the actor when the offer was actor-targeted at create time
	 *   (`role_grant_offer.to_actor_id` set), null when the offer was
	 *   account-grain (any actor on `to_account_id` may accept).
	 * - Not populated: admin actions, account-shape events (login,
	 *   logout, signup, bootstrap, password_change, session/token
	 *   revoke, app_settings_update, invite events) — subject is the
	 *   account or no specific resource, not an actor-bound role_grant.
	 * - Not populated: events whose principal isn't an actor-bound
	 *   resource (e.g. consumer events that name a non-actor scope in
	 *   metadata).
	 *
	 * Multi-actor invariants this column relies on: when both
	 * `target_actor_id` and `target_account_id` are populated they refer
	 * to the same account (`actor.account_id`-derivable). The invariant
	 * holds uniformly across every populated event including decline
	 * (the grantor's account is joined into the decline RETURNING) and
	 * the supersede cascade (the recipient account is known on
	 * `role_grant_offer.to_account_id`). `target_account_id` stays the
	 * SSE/WS socket-close key because sessions remain account-grain
	 * after multi-actor lands.
	 */
	target_actor_id: Uuid | null;
	ip: string | null;
	created_at: string;
	metadata: Record<string, unknown> | null;
}

/**
 * Narrow metadata type for a known event type.
 *
 * Use after checking `event_type` to get typed metadata access.
 */
export const get_audit_metadata = <T extends AuditEventType>(
	event: AuditLogEvent & {event_type: T},
): AuditMetadataMap[T] | null => {
	return event.metadata as AuditMetadataMap[T] | null;
};

/** Input for creating an audit log entry. */
export interface AuditLogInput<T extends string = AuditEventType> {
	event_type: T;
	outcome?: AuditOutcome;
	actor_id?: Uuid | null;
	account_id?: Uuid | null;
	target_account_id?: Uuid | null;
	target_actor_id?: Uuid | null;
	ip?: string | null;
	/**
	 * Per-event-type metadata. Builtin `T` narrows to `AuditMetadataMap[T]`;
	 * consumer strings widen to a generic record (validation runs against
	 * `AuditLogConfig.metadata_schemas` at insert time).
	 */
	metadata?: T extends AuditEventType
		? (AuditMetadataMap[T] & Record<string, unknown>) | null
		: Record<string, unknown> | null;
}

/**
 * Configuration bundle for audit-log event types and metadata schemas.
 *
 * Lets consumers extend the closed `AUDIT_EVENT_TYPES` enum with their own
 * event strings (and metadata Zod schemas) without forking. Pass to
 * `create_audit_emitter` (or `query_audit_log` for in-tx call sites) as the
 * optional `config` argument; both default to `builtin_audit_log_config`.
 *
 * The DB column is `TEXT NOT NULL` and never enforced an enum, so consumer
 * event types round-trip through `query_audit_log_list` and SSE identically
 * to builtins.
 *
 * Constructed configs are deep-frozen (wrapper, `event_types`,
 * `metadata_schemas`) to catch accidental mutation bugs early. Not a
 * security boundary against in-process code, which can subvert audit
 * logging through other paths.
 */
export interface AuditLogConfig {
	/** All recognized event-type strings — fuz_app builtins plus consumer extras. */
	readonly event_types: ReadonlyArray<string>;
	/**
	 * Per-event-type metadata schemas. Missing entries skip metadata
	 * validation for that type (row still written; metadata stored as raw JSONB).
	 */
	readonly metadata_schemas: Readonly<Record<string, z.ZodType>>;
}

/** Builtin fuz_app audit-log config — every existing event type and its metadata schema. */
export const builtin_audit_log_config: AuditLogConfig = Object.freeze({
	event_types: AUDIT_EVENT_TYPES,
	metadata_schemas: audit_metadata_schemas,
});

/** Options for `create_audit_log_config`. */
export interface CreateAuditLogConfigOptions {
	/**
	 * Extra event types keyed by event-type string. Value is a Zod metadata
	 * schema, or `null` to register the type without validation (row still
	 * written, metadata stored as raw JSONB).
	 *
	 * Collisions with builtin event-type strings throw at construction.
	 * Schemas are run via `safeParse` at insert time; mismatches log + count
	 * but never throw (fail-open — see the drift counters in `auth/audit_log_queries.ts`).
	 */
	extra_events?: Readonly<Record<string, z.ZodType | null>>;
}

/**
 * Build an `AuditLogConfig` by merging fuz_app builtins with consumer extras.
 *
 * Throws when an `extra_events` key collides with a builtin event type, or
 * fails `AuditEventTypeName` format validation.
 *
 * Call once at startup; pass the result to `create_app_backend` (which
 * threads it into `AppDeps.audit`). Builtin handlers omit the
 * `audit_log_config` slot and pick up `builtin_audit_log_config`.
 *
 * @throws Error when an `extra_events` key collides with a builtin event type or fails `AuditEventTypeName` format validation
 */
export const create_audit_log_config = (options?: CreateAuditLogConfigOptions): AuditLogConfig => {
	const extras = options?.extra_events;
	if (!extras) return builtin_audit_log_config;
	const extra_entries = Object.entries(extras);
	if (extra_entries.length === 0) return builtin_audit_log_config;
	const builtin_set: ReadonlySet<string> = new Set(AUDIT_EVENT_TYPES);
	const extra_keys: Array<string> = [];
	const metadata_schemas: Record<string, z.ZodType> = {...audit_metadata_schemas};
	for (const [t, schema] of extra_entries) {
		if (builtin_set.has(t)) {
			throw new Error(
				`extra_events key "${t}" collides with a builtin event type — pick a distinct string (e.g. "app_${t}")`,
			);
		}
		const name_check = AuditEventTypeName.safeParse(t);
		if (!name_check.success) {
			throw new Error(
				`extra_events key "${t}" has invalid format: ${name_check.error.issues[0]!.message}`,
			);
		}
		extra_keys.push(t);
		if (schema !== null) metadata_schemas[t] = schema;
	}
	return Object.freeze({
		event_types: Object.freeze([...AUDIT_EVENT_TYPES, ...extra_keys]),
		metadata_schemas: Object.freeze(metadata_schemas),
	});
};

/** Default page size for audit log listings. */
export const AUDIT_LOG_DEFAULT_LIMIT = 50;

/** Options for listing audit log entries. */
export interface AuditLogListOptions {
	limit?: number;
	offset?: number;
	/**
	 * Event-type filter. Accepts any string — builtins or consumer-registered
	 * via `create_audit_log_config({extra_events})`. The DB column is
	 * `TEXT NOT NULL` with no CHECK, so unknown strings simply match nothing.
	 */
	event_type?: string;
	event_type_in?: Array<string>;
	account_id?: Uuid;
	outcome?: AuditOutcome;
	/** When set, only return events with `seq` greater than this value. Enables SSE reconnection gap fill. */
	since_seq?: number;
}

/**
 * Zod schema for client-safe audit log event.
 *
 * `event_type` is `AuditEventTypeName` (regex-validated string) — matches
 * the `AuditLogEvent` row and the DB's `TEXT NOT NULL` column. Consumer
 * types registered via `create_audit_log_config({extra_events})` round-trip
 * through queries, `on_audit_event` callbacks, and JSON-RPC responses
 * identically to builtins. `AuditLogInput<T>` stays parameterized on the
 * write side so `AuditMetadataMap` narrowing via `get_audit_metadata` works.
 */
export const AuditLogEventJson = z.strictObject({
	id: Uuid,
	seq: z.number().int(),
	event_type: AuditEventTypeName,
	outcome: AuditOutcome,
	actor_id: Uuid.nullable(),
	account_id: Uuid.nullable(),
	target_account_id: Uuid.nullable(),
	target_actor_id: Uuid.nullable(),
	ip: z.string().nullable(),
	created_at: z.string(),
	metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditLogEventJson = z.infer<typeof AuditLogEventJson>;

/** Zod schema for audit log events with resolved usernames. */
export const AuditLogEventWithUsernamesJson = AuditLogEventJson.extend({
	username: z.string().nullable(),
	target_username: z.string().nullable(),
});
export type AuditLogEventWithUsernamesJson = z.infer<typeof AuditLogEventWithUsernamesJson>;

/** Zod schema for role_grant history events with resolved usernames. */
export const RoleGrantHistoryEventJson = AuditLogEventJson.extend({
	username: z.string().nullable(),
	target_username: z.string().nullable(),
});
export type RoleGrantHistoryEventJson = z.infer<typeof RoleGrantHistoryEventJson>;

/** Zod schema for admin session listing (session + username). */
export const AdminSessionJson = AuthSessionJson.extend({
	username: z.string(),
});
export type AdminSessionJson = z.infer<typeof AdminSessionJson>;
