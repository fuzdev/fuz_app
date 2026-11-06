/**
 * Invite types and client-safe schemas.
 *
 * Defines the runtime types for the invite system: invite creation,
 * matching, and claiming.
 *
 * @module
 */

import { nullable, object, string, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import {
	Email,
	Timestamp,
	UsernameCanonical,
	Uuid,
	type Username
} from '../primitive_schemas_fuz.ts';

/** Invite row from the database. */
export interface Invite {
	id: Uuid;
	email: Email | null;
	username: Username | null;
	claimed_by: Uuid | null;
	claimed_at: string | null;
	created_at: string;
	created_by: Uuid | null;
}

/**
 * Client-safe invite data, a `@fuzdev/fuz_schema` schema. Its `username` is
 * `UsernameCanonical`, the lowercase every creation path stores.
 */
export const InviteJson = object({
	id: Uuid,
	email: nullable(Email),
	username: nullable(UsernameCanonical),
	claimed_by: nullable(Uuid),
	claimed_at: nullable(Timestamp),
	created_at: Timestamp,
	created_by: nullable(Uuid)
});
export type InviteJson = Infer<typeof InviteJson>;

/**
 * Invite data with resolved creator/claimer usernames, a `@fuzdev/fuz_schema`
 * schema. The resolved names are plain strings.
 */
export const InviteWithUsernamesJson = object({
	...InviteJson.def,
	created_by_username: nullable(string),
	claimed_by_username: nullable(string)
});
export type InviteWithUsernamesJson = Infer<typeof InviteWithUsernamesJson>;

/** Input for creating an invite. */
export interface CreateInviteInput {
	email?: Email | null;
	username?: Username | null;
	created_by: Uuid | null;
}
