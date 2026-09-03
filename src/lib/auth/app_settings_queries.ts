/**
 * App settings database queries.
 *
 * Single-row table queries for global app configuration.
 *
 * @module
 */

import type { QueryDeps } from '../db/query_deps.ts';
import {
	columns_sql,
	iso8601_timestamp_expr,
	omit_columns,
	qualify_columns
} from '../db/sql_columns.ts';
import type { AppSettings, AppSettingsWithUsernameJson } from './app_settings_schema.ts';

/**
 * The full `app_settings` column set — the singleton `id` (always `1`) plus
 * the settings the row type carries — drift-guarded like every other
 * `*_COLUMNS`. Reads project `APP_SETTINGS_ROW_COLUMNS`, which omits the
 * constant `id` since `AppSettings` doesn't carry it. Keep in sync with
 * `AppSettings` and the `app_settings` DDL in `auth/auth_ddl.ts`.
 */
export const APP_SETTINGS_COLUMNS = ['id', 'open_signup', 'updated_at', 'updated_by'] as const;

/** `APP_SETTINGS_COLUMNS` minus the constant singleton `id` — the `AppSettings` row projection. */
const APP_SETTINGS_ROW_COLUMNS = omit_columns(APP_SETTINGS_COLUMNS, 'id');

/** The `app_settings` timestamp override, by row qualifier (`''` bare, `s` for the username JOIN). */
const app_settings_expr = iso8601_timestamp_expr(APP_SETTINGS_ROW_COLUMNS, ['updated_at']);

/**
 * Load the current app settings.
 *
 * @param deps - query dependencies
 * @returns the app settings row
 * @throws Error if the singleton `app_settings` row is missing (migration drift — should not occur in practice)
 */
export const query_app_settings_load = async (deps: QueryDeps): Promise<AppSettings> => {
	const row = await deps.db.query_one<AppSettings>(
		`SELECT ${columns_sql(APP_SETTINGS_ROW_COLUMNS, app_settings_expr(''))} FROM app_settings WHERE id = 1`
	);
	if (!row) {
		throw new Error('app_settings row not found — migration may not have run');
	}
	return row;
};

/**
 * Load the current app settings with resolved updater username.
 *
 * @param deps - query dependencies
 * @returns the app settings with `updated_by_username`
 * @throws Error if the singleton `app_settings` row is missing
 */
export const query_app_settings_load_with_username = async (
	deps: QueryDeps
): Promise<AppSettingsWithUsernameJson> => {
	const row = await deps.db.query_one<AppSettingsWithUsernameJson>(
		`SELECT ${qualify_columns(APP_SETTINGS_ROW_COLUMNS, 's', app_settings_expr('s'))}, act.name AS updated_by_username
		 FROM app_settings s
		 LEFT JOIN actor act ON act.id = s.updated_by
		 WHERE s.id = 1`
	);
	if (!row) {
		throw new Error('app_settings row not found — migration may not have run');
	}
	return row;
};

/**
 * Update app settings and return the updated row.
 *
 * @param deps - query dependencies
 * @param open_signup - new value for the open_signup toggle
 * @param actor_id - the actor making the change
 * @returns the updated app settings row
 * @mutates `app_settings` row - sets `open_signup`, `updated_at`, and `updated_by`
 * @throws Error if the singleton `app_settings` row is missing
 */
export const query_app_settings_update = async (
	deps: QueryDeps,
	open_signup: boolean,
	actor_id: string
): Promise<AppSettings> => {
	const row = await deps.db.query_one<AppSettings>(
		`UPDATE app_settings SET open_signup = $1, updated_at = NOW(), updated_by = $2 WHERE id = 1 RETURNING ${columns_sql(APP_SETTINGS_ROW_COLUMNS, app_settings_expr(''))}`,
		[open_signup, actor_id]
	);
	if (!row) {
		throw new Error('app_settings row not found — migration may not have run');
	}
	return row;
};
