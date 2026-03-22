/**
 * Admin app settings route specs.
 *
 * GET and PATCH routes for managing global app settings (e.g. open signup toggle).
 * All routes require the `admin` role.
 *
 * @module
 */

import {z} from 'zod';

import {get_route_input, type RouteSpec} from '../http/route_spec.js';
import {require_request_context} from './request_context.js';
import {get_client_ip} from '../http/proxy.js';
import {audit_log_fire_and_forget} from './audit_log_queries.js';
import {
	query_app_settings_load_with_username,
	query_app_settings_update,
} from './app_settings_queries.js';
import {
	AppSettingsWithUsernameJson,
	UpdateAppSettingsInput,
	type AppSettings,
} from './app_settings_schema.js';
import type {RouteFactoryDeps} from './deps.js';

/**
 * Per-factory configuration for app settings route specs.
 */
export interface AppSettingsRouteOptions {
	/** Mutable ref to the in-memory app settings — mutated on PATCH. */
	app_settings: AppSettings;
}

/**
 * Create admin app settings route specs.
 *
 * @param deps - stateless capabilities (log, on_audit_event)
 * @param options - per-factory configuration
 * @returns route specs for app settings management
 */
export const create_app_settings_route_specs = (
	deps: Pick<RouteFactoryDeps, 'log' | 'on_audit_event'>,
	options: AppSettingsRouteOptions,
): Array<RouteSpec> => {
	const {app_settings} = options;

	return [
		{
			method: 'GET',
			path: '/settings',
			auth: {type: 'role', role: 'admin'},
			description: 'Get app settings',
			input: z.null(),
			output: z.strictObject({settings: AppSettingsWithUsernameJson}),
			handler: async (c, route) => {
				const settings = await query_app_settings_load_with_username(route);
				return c.json({settings});
			},
		},
		{
			method: 'PATCH',
			path: '/settings',
			auth: {type: 'role', role: 'admin'},
			description: 'Update app settings',
			input: UpdateAppSettingsInput,
			output: z.strictObject({ok: z.literal(true), settings: AppSettingsWithUsernameJson}),
			handler: async (c, route) => {
				const ctx = require_request_context(c);
				const {open_signup} = get_route_input<{open_signup: boolean}>(c);

				const old_value = app_settings.open_signup;
				const updated = await query_app_settings_update(route, open_signup, ctx.actor.id);

				// Mutate the in-memory ref so GET reads are consistent
				app_settings.open_signup = updated.open_signup;
				app_settings.updated_at = updated.updated_at;
				app_settings.updated_by = updated.updated_by;

				void audit_log_fire_and_forget(
					route,
					{
						event_type: 'app_settings_update',
						actor_id: ctx.actor.id,
						account_id: ctx.account.id,
						ip: get_client_ip(c),
						metadata: {setting: 'open_signup', old_value, new_value: open_signup},
					},
					deps.log,
					deps.on_audit_event,
				);
				const settings_with_username = await query_app_settings_load_with_username(route);
				return c.json({ok: true, settings: settings_with_username});
			},
		},
	];
};
