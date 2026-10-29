/**
 * The liveness route's path and response shape — browser-safe, so the server
 * route spec (`http/common_routes.ts`) and the client probe
 * (`ui/backend_probe.svelte.ts`) share one definition.
 *
 * @module
 */

import { z } from 'zod';

/** The public liveness route both spines mount. */
export const HEALTH_PATH = '/health';

/** The liveness route's response body. */
export const HealthResponse = z.strictObject({ status: z.literal('ok') });
export type HealthResponse = z.infer<typeof HealthResponse>;
