/**
 * The assembled app's `onError` — what a throw that escapes every route catch
 * answers.
 *
 * Route handlers and the RPC dispatcher map their own throws
 * (`http/route_spec.ts`, `actions/perform_action.ts`); what reaches here is a
 * throw from middleware — above all the credential legs, whose failed read
 * ends the request rather than reading as anonymous. Two answers:
 *
 * - a failed pool checkout (`DbCheckoutError`) is the database unavailable:
 *   503 `{"error": "service_unavailable"}`, the Rust spine's
 *   `fuz_http::db_unavailable_response` (and its `CredentialReadFault` of the
 *   checkout kind);
 * - anything else is Hono's default error handler, reproduced byte for byte —
 *   an `HTTPException`'s own response, else 500 `text/plain; charset=UTF-8`
 *   `Internal Server Error`, the body the Rust `CredentialReadFault` of the
 *   query kind answers with.
 *
 * @module
 */

import type { Context, ErrorHandler } from 'hono';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { is_db_checkout_error } from '../db/db_checkout_error.ts';
import { ERROR_SERVICE_UNAVAILABLE } from '../http/error_schemas.ts';

/**
 * Build the app's `onError` handler (module doc).
 *
 * @param log - receives each failed checkout and each unhandled error
 * @returns the handler `create_app_server` registers with `app.onError`
 */
export const create_app_error_handler =
	(log: Logger): ErrorHandler =>
	(err: Error, c: Context): Response => {
		if (is_db_checkout_error(err)) {
			log.error('pool checkout failed:', err);
			return c.json({ error: ERROR_SERVICE_UNAVAILABLE }, 503);
		}
		// Hono's default handler (`hono-base.js` `errorHandler`), byte for byte
		if ('getResponse' in err) {
			const res = (err as { getResponse: () => Response }).getResponse();
			return c.newResponse(res.body, res);
		}
		log.error('unhandled error:', err);
		return c.text('Internal Server Error', 500);
	};
