/**
 * Invite types and client-safe schemas.
 *
 * Defines the runtime types for the invite system: invite creation,
 * matching, and claiming.
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.ts';

import {Username, Email} from '../primitive_schemas.ts';

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

/** Zod schema for client-safe invite data. */
export const InviteJson = z.strictObject({
	id: Uuid,
	email: Email.nullable(),
	username: Username.nullable(),
	claimed_by: Uuid.nullable(),
	claimed_at: z.string().nullable(),
	created_at: z.string(),
	created_by: Uuid.nullable(),
});
export type InviteJson = z.infer<typeof InviteJson>;

/** Zod schema for invite data with resolved creator/claimer usernames. */
export const InviteWithUsernamesJson = InviteJson.extend({
	created_by_username: z.string().nullable(),
	claimed_by_username: z.string().nullable(),
});
export type InviteWithUsernamesJson = z.infer<typeof InviteWithUsernamesJson>;

/** Input for creating an invite. */
export interface CreateInviteInput {
	email?: Email | null;
	username?: Username | null;
	created_by: Uuid | null;
}
