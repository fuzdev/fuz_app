/**
 * Invite types and client-safe schemas.
 *
 * Defines the runtime types for the invite system: invite creation,
 * matching, and claiming.
 *
 * @module
 */

import {z} from 'zod';

import {Username, Email} from './account_schema.js';

/** Invite row from the database. */
export interface Invite {
	id: string;
	email: Email | null;
	username: Username | null;
	claimed_by: string | null;
	claimed_at: string | null;
	created_at: string;
	created_by: string | null;
}

/** Zod schema for client-safe invite data. */
export const InviteJson = z.strictObject({
	id: z.string(),
	email: Email.nullable(),
	username: Username.nullable(),
	claimed_by: z.string().nullable(),
	claimed_at: z.string().nullable(),
	created_at: z.string(),
	created_by: z.string().nullable(),
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
	created_by: string | null;
}
