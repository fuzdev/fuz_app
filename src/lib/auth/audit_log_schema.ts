/**
 * Audit log database schema and types.
 *
 * Records auth mutations (login, logout, grant, revoke, etc.) for
 * security monitoring and operational visibility.
 *
 * @module
 */

import {z} from 'zod';

import {AuthSessionJson} from './account_schema.js';

/** All tracked auth event types. */
export const AUDIT_EVENT_TYPES = [
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
	'invite_create',
	'invite_delete',
	'app_settings_update',
] as const;

/** Zod schema for audit event types. */
export const AuditEventType = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = z.infer<typeof AuditEventType>;

/** Zod schema for audit event outcomes. */
export const AuditOutcome = z.enum(['success', 'failure']);
export type AuditOutcome = z.infer<typeof AuditOutcome>;

/**
 * Per-event-type metadata Zod schemas.
 *
 * Uses `z.looseObject` so consumers can add extra fields
 * (e.g. visiones `self_service`) while known fields are validated.
 * Events with outcome-dependent metadata use a union with `z.null()`.
 */
export const AUDIT_METADATA_SCHEMAS = {
	login: z.looseObject({username: z.string()}).nullable(),
	logout: z.null(),
	bootstrap: z.looseObject({error: z.string()}).nullable(),
	signup: z.looseObject({
		username: z.string(),
		invite_id: z.string().optional(),
		open_signup: z.boolean().optional(),
	}),
	password_change: z.looseObject({sessions_revoked: z.number()}).nullable(),
	session_revoke: z.looseObject({session_id: z.string()}),
	session_revoke_all: z.looseObject({count: z.number()}),
	token_create: z.looseObject({token_id: z.string(), name: z.string()}),
	token_revoke: z.looseObject({token_id: z.string()}),
	token_revoke_all: z.looseObject({count: z.number()}),
	permit_grant: z.looseObject({role: z.string(), permit_id: z.string()}),
	permit_revoke: z.looseObject({role: z.string(), permit_id: z.string()}),
	invite_create: z.looseObject({
		invite_id: z.string(),
		email: z.string().nullable(),
		username: z.string().nullable(),
	}),
	invite_delete: z.looseObject({invite_id: z.string()}),
	app_settings_update: z.looseObject({
		setting: z.string(),
		old_value: z.unknown(),
		new_value: z.unknown(),
	}),
} satisfies Record<AuditEventType, z.ZodType>;

/** Mapped type of metadata shapes per event type, derived from Zod schemas. */
export type AuditMetadataMap = {
	[K in AuditEventType]: z.infer<(typeof AUDIT_METADATA_SCHEMAS)[K]>;
};

/** Audit log row from the database. */
export interface AuditLogEvent {
	id: string;
	seq: number;
	event_type: AuditEventType;
	outcome: AuditOutcome;
	actor_id: string | null;
	account_id: string | null;
	target_account_id: string | null;
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
export interface AuditLogInput<T extends AuditEventType = AuditEventType> {
	event_type: T;
	outcome?: AuditOutcome;
	actor_id?: string | null;
	account_id?: string | null;
	target_account_id?: string | null;
	ip?: string | null;
	metadata?: (AuditMetadataMap[T] & Record<string, unknown>) | null;
}

/** Options for listing audit log entries. */
export interface AuditLogListOptions {
	limit?: number;
	offset?: number;
	event_type?: AuditEventType;
	event_type_in?: Array<AuditEventType>;
	account_id?: string;
	outcome?: AuditOutcome;
	/** When set, only return events with `seq` greater than this value. Enables SSE reconnection gap fill. */
	since_seq?: number;
}

/** Zod schema for client-safe audit log event. */
export const AuditLogEventJson = z.strictObject({
	id: z.string(),
	seq: z.number().int(),
	event_type: AuditEventType,
	outcome: AuditOutcome,
	actor_id: z.string().nullable(),
	account_id: z.string().nullable(),
	target_account_id: z.string().nullable(),
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

export const AUDIT_LOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq SERIAL NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'success',
  actor_id UUID REFERENCES actor(id) ON DELETE SET NULL,
  account_id UUID REFERENCES account(id) ON DELETE SET NULL,
  target_account_id UUID REFERENCES account(id) ON DELETE SET NULL,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB
)`;

export const AUDIT_LOG_INDEXES = [
	`CREATE INDEX IF NOT EXISTS idx_audit_log_seq ON audit_log(seq DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_account ON audit_log(account_id)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_target_account ON audit_log(target_account_id)`,
];
