/**
 * Read the resolved client IP off the Hono context.
 *
 * Split from `proxy.ts` (which pulls `hono/utils/ipaddr` for trusted-proxy
 * CIDR matching) so dispatch + route modules that only need to *read* the IP
 * stay free of that value import — and the cross-process test surface that
 * imports them stays free of the optional `hono` peer. The IP itself is set on
 * the context by the trusted-proxy middleware in `proxy.ts`.
 *
 * @module
 */

import type {Context} from 'hono';

/** Client IP resolved by the trusted-proxy middleware, or `'unknown'` if unset. */
export const get_client_ip = (c: Context): string => c.get('client_ip') || 'unknown';
