/**
 * Composable startup summary helpers.
 *
 * Logs a human-readable summary from an `AppSurface`.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { format_env_display_value } from '../env/mask.ts';
import type { AppSurface } from '../http/surface.ts';

/**
 * Log a startup summary from an `AppSurface`.
 *
 * Logs route count, middleware count, env breakdown (when non-empty),
 * and event/channel counts (when non-empty). When `env_values` is provided,
 * non-secret values are logged and secrets are masked with `***`.
 *
 * @param env_values - optional env values to log (secrets are masked)
 */
export const log_startup_summary = (
	surface: AppSurface,
	log: Logger,
	env_values?: Record<string, unknown>
): void => {
	log.info(
		`Surface: ${surface.routes.length} routes, ${surface.middleware.length} middleware layers`
	);

	// Endpoint surfaces — logged when non-empty so operators can confirm
	// auto-mount picked up the expected actions (and so a factory that
	// silently returns `[]` is loud at boot instead of a method_not_found
	// at first call).
	if (surface.rpc_endpoints.length) {
		const rpc_method_count = surface.rpc_endpoints.reduce((sum, ep) => sum + ep.methods.length, 0);
		log.info(`RPC: ${surface.rpc_endpoints.length} endpoint(s), ${rpc_method_count} method(s)`);
	}
	if (surface.ws_endpoints.length) {
		const ws_method_count = surface.ws_endpoints.reduce((sum, ep) => sum + ep.methods.length, 0);
		log.info(`WS: ${surface.ws_endpoints.length} endpoint(s), ${ws_method_count} method(s)`);
	}

	if (surface.env.length) {
		const required = surface.env.filter((e) => !e.optional);
		const secret = surface.env.filter((e) => e.sensitivity === 'secret');
		log.info(
			`Env: ${surface.env.length} vars (${required.length} required, ${secret.length} secret)`
		);

		if (env_values) {
			for (const entry of surface.env) {
				const value = env_values[entry.name];
				if (value === undefined) continue;
				log.info(
					`  ${entry.name}=${format_env_display_value(value, entry.sensitivity === 'secret')}`
				);
			}
		}
	}

	if (surface.events.length) {
		const channels = new Set(surface.events.map((e) => e.channel).filter(Boolean));
		log.info(`Events: ${surface.events.length} types, ${channels.size} channels`);
	}

	if (surface.diagnostics.length) {
		const warnings = surface.diagnostics.filter((d) => d.level === 'warning');
		if (warnings.length) {
			log.warn(`Diagnostics: ${warnings.length} warning(s)`);
			for (const d of warnings) {
				log.warn(`  [${d.category}] ${d.message}${d.source ? ` (${d.source})` : ''}`);
			}
		}
	}
};
