/**
 * App settings types and client-safe schemas.
 *
 * Single-row table for global app configuration (e.g. open signup toggle).
 *
 * @module
 */

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.ts';

/** App settings row from the database. */
export interface AppSettings {
	open_signup: boolean;
	updated_at: string | null;
	updated_by: Uuid | null;
}

/** Zod schema for client-safe app settings data. */
export const AppSettingsJson = z.strictObject({
	open_signup: z.boolean(),
	updated_at: z.string().nullable(),
	updated_by: Uuid.nullable(),
});
export type AppSettingsJson = z.infer<typeof AppSettingsJson>;

/** Zod schema for admin app settings with resolved updater username. */
export const AppSettingsWithUsernameJson = AppSettingsJson.extend({
	updated_by_username: z.string().nullable(),
});
export type AppSettingsWithUsernameJson = z.infer<typeof AppSettingsWithUsernameJson>;

/** Zod schema for updating app settings. */
export const UpdateAppSettingsInput = z.strictObject({
	open_signup: z.boolean(),
});
export type UpdateAppSettingsInput = z.infer<typeof UpdateAppSettingsInput>;
