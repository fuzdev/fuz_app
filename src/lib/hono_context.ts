/**
 * Hono context variable augmentation for fuz_app.
 *
 * Cross-cutting shared vocabulary — defines the Hono `ContextVariableMap`
 * variables used by auth, http, server, and testing modules.
 *
 * Import this module once in your app to get type-safe access to
 * `auth_session_id`, `request_context`, and `credential_type` on the Hono context.
 *
 * In practice, this is auto-loaded by `app_server.ts` (side-effect import)
 * and transitively by auth middleware modules that import `CREDENTIAL_TYPE_KEY`.
 * Consumers don't need a manual import unless bypassing the standard server assembly.
 *
 * @module
 */

import {z} from 'zod';

import type {RequestContext} from './auth/request_context.js';

/** The credential types that can authenticate a request. */
export const CREDENTIAL_TYPES = ['session', 'api_token', 'daemon_token'] as const;

/** Credential type — how a request was authenticated. */
export const CredentialType = z.enum(CREDENTIAL_TYPES);
export type CredentialType = z.infer<typeof CredentialType>;

/** Hono context variable name for the credential type. */
export const CREDENTIAL_TYPE_KEY = 'credential_type';

declare module 'hono' {
	interface ContextVariableMap {
		/** Resolved client IP, set by the trusted proxy middleware. */
		client_ip: string;
		auth_session_id: string | null;
		request_context: RequestContext | null;
		validated_input: unknown;
		validated_params: unknown;
		validated_query: unknown;
		/** How the request was authenticated (`'session'`, `'api_token'`, or `'daemon_token'`). */
		credential_type: CredentialType | null;
		/**
		 * Pending fire-and-forget effects for this request (audit logs, usage tracking, etc.).
		 * Initialized by `create_app_server`. In test mode (`await_pending_effects: true`),
		 * all effects are awaited before the response returns.
		 */
		pending_effects: Array<Promise<void>>;
	}
}
