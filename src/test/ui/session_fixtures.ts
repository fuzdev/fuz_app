/**
 * Shared session fixtures for UI state-class tests. Both
 * `account_sessions_state.svelte.test.ts` and
 * `admin_sessions_state.svelte.test.ts` stub session rows against mocked RPC
 * adapters, so the wire-shape fixture lives once here — a session-shape
 * change is one edit, not two in lockstep.
 *
 * Not itself a test file — no `.test.` infix means vitest does not pick
 * it up.
 *
 * @module
 */

import type { AuthSessionJson } from '$lib/auth/account_schema.ts';
import type { AdminSessionJson } from '$lib/auth/audit_log_schema.ts';

/**
 * `id` widens back to `string` so fixtures read as `'sess-1'` rather than 64
 * hex chars. These tests drive state against mocked rpcs, so nothing parses.
 */
export type SessionOverrides = Omit<Partial<AuthSessionJson>, 'id'> & { id?: string };

/** Build a default-shaped `AuthSessionJson` for stubs; override any field. */
export const make_auth_session = (overrides: SessionOverrides = {}): AuthSessionJson =>
	({
		id: 'sess-1',
		account_id: 'acct-1',
		created_at: '2026-01-01T00:00:00.000Z',
		expires_at: '2026-02-01T00:00:00.000Z',
		...overrides
	}) as AuthSessionJson;

/** The same widening for the admin variant (`AuthSessionJson` + `username`). */
export type AdminSessionOverrides = Omit<Partial<AdminSessionJson>, 'id'> & { id?: string };

/** Build a default-shaped `AdminSessionJson` for stubs; override any field. */
export const make_admin_session = (overrides: AdminSessionOverrides = {}): AdminSessionJson =>
	({
		...make_auth_session(),
		username: 'alice',
		...overrides
	}) as AdminSessionJson;
