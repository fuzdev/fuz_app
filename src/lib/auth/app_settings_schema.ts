/**
 * App settings types and client-safe schemas, `@fuzdev/fuz_schema` schemas.
 *
 * Single-row table for global app configuration (e.g. open signup toggle).
 *
 * @module
 */

import { boolean, nullable, object, string, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import { Uuid } from '../primitive_schemas_fuz.ts';

/** App settings row from the database. */
export interface AppSettings {
	open_signup: boolean;
	updated_at: string | null;
	updated_by: Uuid | null;
}

/** Client-safe app settings data. */
export const AppSettingsJson = object({
	open_signup: boolean,
	updated_at: nullable(string),
	updated_by: nullable(Uuid)
});
export type AppSettingsJson = Infer<typeof AppSettingsJson>;

/** Admin app settings with the updater's username resolved. */
export const AppSettingsWithUsernameJson = object({
	...AppSettingsJson.def,
	updated_by_username: nullable(string)
});
export type AppSettingsWithUsernameJson = Infer<typeof AppSettingsWithUsernameJson>;
