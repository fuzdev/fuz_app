/**
 * The liveness route's path and response shape — browser-safe, so the server
 * route spec (`http/common_routes.ts`) and the client probe
 * (`ui/backend_probe.svelte.ts`) share one definition.
 *
 * @module
 */

import { literal, object, type Infer } from '@fuzdev/fuz_schema/schema.ts';

/** The public liveness route both spines mount. */
export const HEALTH_PATH = '/health';

/** The liveness route's response body, a `@fuzdev/fuz_schema` `object`. */
export const HealthResponse = object({ status: literal('ok') });
export type HealthResponse = Infer<typeof HealthResponse>;
