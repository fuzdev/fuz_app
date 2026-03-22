/**
 * App settings database queries.
 *
 * Single-row table queries for global app configuration.
 *
 * @module
 */

import type {QueryDeps} from '../db/query_deps.js';
import type {AppSettings, AppSettingsWithUsernameJson} from './app_settings_schema.js';

/**
 * Load the current app settings.
 *
 * @param deps - query dependencies
 * @returns the app settings row
 */
export const query_app_settings_load = async (deps: QueryDeps): Promise<AppSettings> => {
	const row = await deps.db.query_one<AppSettings>(
		`SELECT open_signup, updated_at, updated_by FROM app_settings WHERE id = 1`,
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
 */
export const query_app_settings_load_with_username = async (
	deps: QueryDeps,
): Promise<AppSettingsWithUsernameJson> => {
	const row = await deps.db.query_one<AppSettingsWithUsernameJson>(
		`SELECT s.open_signup, s.updated_at, s.updated_by, act.name AS updated_by_username
		 FROM app_settings s
		 LEFT JOIN actor act ON act.id = s.updated_by
		 WHERE s.id = 1`,
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
 */
export const query_app_settings_update = async (
	deps: QueryDeps,
	open_signup: boolean,
	actor_id: string,
): Promise<AppSettings> => {
	const row = await deps.db.query_one<AppSettings>(
		`UPDATE app_settings SET open_signup = $1, updated_at = NOW(), updated_by = $2 WHERE id = 1 RETURNING open_signup, updated_at, updated_by`,
		[open_signup, actor_id],
	);
	if (!row) {
		throw new Error('app_settings row not found — migration may not have run');
	}
	return row;
};
