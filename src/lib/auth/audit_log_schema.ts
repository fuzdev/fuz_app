/**
 * Audit log database schema and types.
 *
 * Records auth mutations (login, logout, grant, revoke, etc.) for
 * security monitoring and operational visibility.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import {AuthSessionJson} from './account_schema.js';

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
	'permit_grant',
	'permit_revoke',
	'permit_offer_create',
	'permit_offer_accept',
	'permit_offer_decline',
	'permit_offer_retract',
	'permit_offer_expire',
	'permit_offer_supersede',
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
export const AUDIT_METADATA_SCHEMAS = Object.freeze({
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
		username: z.string().meta({description: 'Username chosen at signup.'}),
		invite_id: Uuid.optional().meta({
			description: 'Invite consumed by this signup, when one was matched.',
		}),
		open_signup: z.boolean().optional().meta({
			description:
				'True when the signup occurred via the `open_signup` setting (no invite required).',
		}),
	}),
	password_change: z
		.looseObject({
			sessions_revoked: z
				.number()
				.meta({description: 'Number of sessions revoked as a side effect of the password change.'}),
		})
		.nullable(),
	session_revoke: z.looseObject({
		session_id: z.string().meta({description: 'Blake3 hash identifying the revoked session row.'}),
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
		token_id: z.string().meta({description: 'Public id of the created API token (`tok_…`).'}),
		name: z.string().meta({description: 'Operator-supplied label for the token.'}),
	}),
	token_revoke: z.looseObject({
		token_id: z.string().meta({description: 'Public id of the revoked API token (`tok_…`).'}),
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
	// `permit_id` is optional on `permit_grant` because failed grants
	// (e.g. `web_grantable` denied) never produce a permit row.
	// `self_service: true` is set by the self-service role toggle in
	// `self_service_role_actions.ts` — declared explicitly rather than
	// riding on `z.looseObject` permissiveness so the field is part of
	// the documented schema surface.
	permit_grant: z.looseObject({
		role: z.string().meta({description: 'Role being granted.'}),
		permit_id: Uuid.optional().meta({
			description:
				'Id of the resulting permit row. Omitted when the grant failed (e.g. `web_grantable` denial).',
		}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the granted permit; null for global permits.',
		}),
		source_offer_id: Uuid.optional().meta({
			description: 'Offer this grant resolved, when the grant originated from an accepted offer.',
		}),
		self_service: z.boolean().optional().meta({
			description: 'True when the grant came from the self-service role toggle.',
		}),
	}),
	permit_revoke: z.looseObject({
		role: z.string().meta({description: 'Role being revoked.'}),
		permit_id: Uuid.meta({description: 'Id of the revoked permit row.'}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the revoked permit; null for global permits.',
		}),
		reason: z
			.string()
			.optional()
			.meta({description: 'Optional admin-supplied or self-service reason text.'}),
		self_service: z.boolean().optional().meta({
			description: 'True when the revoke came from the self-service role toggle.',
		}),
	}),
	// `offer_id` is optional because failed creates (e.g. `web_grantable`
	// denied, `authorize` callback denied) never produce an offer row.
	permit_offer_create: z.looseObject({
		offer_id: Uuid.optional().meta({
			description: 'Id of the created offer row. Omitted when the create failed before insert.',
		}),
		role: z.string().meta({description: 'Role being offered.'}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the offered role; null for global offers.',
		}),
		to_account_id: Uuid.meta({description: 'Account the offer is directed to.'}),
	}),
	// `permit_grant` is emitted alongside on accept — two events per accept by
	// design: offer-lifecycle audit + permit-lifecycle audit.
	permit_offer_accept: z.looseObject({
		offer_id: Uuid.meta({description: 'Id of the accepted offer.'}),
		permit_id: Uuid.meta({description: 'Id of the resulting permit row.'}),
		role: z.string().meta({description: 'Role granted by the offer.'}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the resulting permit; null for global permits.',
		}),
	}),
	permit_offer_decline: z.looseObject({
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
	permit_offer_retract: z.looseObject({
		offer_id: Uuid.meta({description: 'Id of the retracted offer.'}),
		role: z.string().meta({description: 'Role that was offered.'}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the offered role; null for global offers.',
		}),
	}),
	permit_offer_expire: z.looseObject({
		offer_id: Uuid.meta({description: 'Id of the expired offer.'}),
		role: z.string().meta({description: 'Role that was offered.'}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the offered role; null for global offers.',
		}),
	}),
	// Emitted when an offer is obsoleted by an external event. `reason`
	// distinguishes the trigger; `cause_id` points to the accepted offer
	// (for `sibling_accepted`), the revoked permit (for `permit_revoked`),
	// or the destroyed parent scope row (for `scope_destroyed`).
	permit_offer_supersede: z.looseObject({
		offer_id: Uuid.meta({description: 'Id of the superseded offer.'}),
		role: z.string().meta({description: 'Role that was offered.'}),
		scope_id: Uuid.nullish().meta({
			description: 'Scope of the offered role; null for global offers.',
		}),
		reason: z.enum(['sibling_accepted', 'permit_revoked', 'scope_destroyed']).meta({
			description:
				'Trigger that obsoleted the offer: a sibling offer was accepted, the resulting permit was revoked, or the parent scope row was destroyed.',
		}),
		cause_id: Uuid.meta({
			description:
				'Row that caused the supersede: accepted offer (`sibling_accepted`), revoked permit (`permit_revoked`), or destroyed parent scope row (`scope_destroyed`).',
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
	[K in AuditEventType]: z.infer<(typeof AUDIT_METADATA_SCHEMAS)[K]>;
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
	 * declares `acting?: ActingActor` or its auth requires permits
	 * (`role` / `keeper`). Account-grain operations declare neither,
	 * so no actor is resolved and `actor_id` is null: login (also
	 * pre-credential), logout, signup, bootstrap, password_change,
	 * session/token revoke, app_settings_update, invite events.
	 * Permit events, admin actions, and actor-targeted offers
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
	 * - Always populated: `permit_revoke` and `permit_grant`
	 *   (admin direct-grant, self-service toggle, and in-tx
	 *   `permit_offer_accept` all populate both target columns — the
	 *   permit's grantee is the actor-grain subject regardless of who
	 *   initiated the grant), `permit_offer_accept` on accept (the
	 *   accept binds the actor deterministically), `permit_offer_decline`
	 *   (the grantor actor — decline is *to* the offering actor).
	 * - Conditionally populated: offer-shape events
	 *   (`permit_offer_create`, `_expire`, `_retract`, `_supersede`)
	 *   carry the actor when the offer was actor-targeted at create time
	 *   (`permit_offer.to_actor_id` set), null when the offer was
	 *   account-grain (any actor on `to_account_id` may accept).
	 * - Not populated: admin actions, account-shape events (login,
	 *   logout, signup, bootstrap, password_change, session/token
	 *   revoke, app_settings_update, invite events) — subject is the
	 *   account or no specific resource, not an actor-bound permit.
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
	 * `permit_offer.to_account_id`). `target_account_id` stays the
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
 * `audit_log_fire_and_forget` / `query_audit_log` as the optional `config`
 * argument; both default to `BUILTIN_AUDIT_LOG_CONFIG`.
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
export const BUILTIN_AUDIT_LOG_CONFIG: AuditLogConfig = Object.freeze({
	event_types: AUDIT_EVENT_TYPES,
	metadata_schemas: AUDIT_METADATA_SCHEMAS,
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
 * Call once at startup; pass the result to consumer-emitted
 * `audit_log_fire_and_forget` calls. Builtin handlers omit the argument and
 * pick up `BUILTIN_AUDIT_LOG_CONFIG`.
 *
 * @throws Error when an `extra_events` key collides with a builtin event type or fails `AuditEventTypeName` format validation
 */
export const create_audit_log_config = (options?: CreateAuditLogConfigOptions): AuditLogConfig => {
	const extras = options?.extra_events;
	if (!extras) return BUILTIN_AUDIT_LOG_CONFIG;
	const extra_entries = Object.entries(extras);
	if (extra_entries.length === 0) return BUILTIN_AUDIT_LOG_CONFIG;
	const builtin_set: ReadonlySet<string> = new Set(AUDIT_EVENT_TYPES);
	const extra_keys: Array<string> = [];
	const metadata_schemas: Record<string, z.ZodType> = {...AUDIT_METADATA_SCHEMAS};
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

/** Zod schema for permit history events with resolved usernames. */
export const PermitHistoryEventJson = AuditLogEventJson.extend({
	username: z.string().nullable(),
	target_username: z.string().nullable(),
});
export type PermitHistoryEventJson = z.infer<typeof PermitHistoryEventJson>;

/** Zod schema for admin session listing (session + username). */
export const AdminSessionJson = AuthSessionJson.extend({
	username: z.string(),
});
export type AdminSessionJson = z.infer<typeof AdminSessionJson>;

// Schema DDL
//
// Multi-actor invariants the envelope columns assume:
// - `actor_id` + `account_id`, when both populated, refer to the same
//   account (derivable via `actor.account_id`). Denormalized for
//   indexed audit queries; do not let them disagree.
// - `target_actor_id` + `target_account_id`, same rule when both populated.
// - `target_account_id` is the SSE/WS socket-close key — sessions stay
//   account-grain after multi-actor lands, so this column carries
//   the routing identity even on actor-bound events.
// - `target_actor_id` is populated iff the event subject is actor-bound
//   (see `AuditLogEvent.target_actor_id` doc-comment for the rule).

export const AUDIT_LOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq SERIAL NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'success',
  actor_id UUID REFERENCES actor(id) ON DELETE SET NULL,
  account_id UUID REFERENCES account(id) ON DELETE SET NULL,
  target_account_id UUID REFERENCES account(id) ON DELETE SET NULL,
  target_actor_id UUID REFERENCES actor(id) ON DELETE SET NULL,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB
)`;

export const AUDIT_LOG_INDEXES = [
	`CREATE INDEX IF NOT EXISTS idx_audit_log_seq ON audit_log(seq DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_account ON audit_log(account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_target_account ON audit_log(target_account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_target_actor ON audit_log(target_actor_id)`,
];
