/**
 * Reactive state for cookie-based authentication.
 *
 * SPA auth pattern: prerendered static HTML served by Hono, no SvelteKit
 * server for SSR sessions. On load, fetches `GET /api/account/status` which
 * returns the current account (200) or 401 with optional `bootstrap_available`.
 * Login sends username + password once, then a signed httpOnly cookie handles
 * all subsequent requests.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 * 	import {AuthState, auth_state_context} from '@fuzdev/fuz_app/ui/auth_state.svelte.ts';
 *
 * 	const auth = new AuthState();
 * 	auth_state_context.set(auth);
 * 	auth.check_session();
 * </script>
 *
 * {#if auth.verifying}
 * 	<p>checking session…</p>
 * {:else if auth.needs_bootstrap}
 * 	<BootstrapForm />
 * {:else if !auth.verified}
 * 	<LoginForm />
 * {:else}
 * 	<p>logged in as {auth.account?.username}</p>
 * 	<button onclick={() => auth.logout()}>logout</button>
 * {/if}
 * ```
 *
 * @module
 */

import {to_error_message} from '@fuzdev/fuz_util/error.ts';
import {create_context} from '@fuzdev/fuz_ui/context_helpers.ts';

import {ui_fetch} from './ui_fetch.ts';
import {
	type ActorSummaryJson,
	is_role_grant_active,
	type RoleGrantSummaryJson,
	type SessionAccount,
} from '../auth/account_schema.ts';

/**
 * Svelte context for `AuthState`.
 * Use `auth_state_context.set(state)` in the provider and `auth_state_context.get()` to access.
 */
export const auth_state_context = create_context<AuthState>();

export class AuthState {
	verifying = $state.raw(false);
	verified = $state.raw(false);
	verify_error: string | null = $state.raw(null);
	account: SessionAccount | null = $state.raw(null);
	actor: ActorSummaryJson | null = $state.raw(null);
	role_grants: Array<RoleGrantSummaryJson> = $state.raw([]);
	readonly active_role_grants: Array<RoleGrantSummaryJson> = $derived(
		this.role_grants.filter((p) => is_role_grant_active(p)),
	);
	readonly roles: Array<string> = $derived(this.active_role_grants.map((p) => p.role));

	/** True when bootstrap is available (no accounts exist yet). */
	needs_bootstrap = $state.raw(false);

	/**
	 * Check auth state and bootstrap availability.
	 *
	 * Fetches `GET /api/account/status` — returns account info (200) or
	 * 401 with optional `bootstrap_available` flag.
	 * Called on init, and after login/bootstrap to refresh state.
	 *
	 * @mutates `this`
	 */
	async check_session(): Promise<void> {
		this.verifying = true;
		try {
			const response = await ui_fetch('/api/account/status');
			if (response.ok) {
				const data = await response.json();
				this.verified = true;
				this.account = data.account ?? null;
				this.actor = data.actor ?? null;
				this.role_grants = data.role_grants ?? [];
				this.needs_bootstrap = false;
			} else {
				this.verified = false;
				if (response.status === 401) {
					try {
						const data = await response.json();
						this.needs_bootstrap = data.bootstrap_available ?? false;
					} catch {
						// non-JSON error response
					}
				}
			}
		} catch {
			this.verified = false;
		} finally {
			this.verifying = false;
		}
	}

	/**
	 * Log in with username and password. Translates 401 / 429 to friendly
	 * messages on `verify_error`; refreshes the session via `check_session`
	 * on success.
	 *
	 * @returns `true` if login succeeded, `false` otherwise
	 * @mutates `this`
	 */
	async login(username: string, password: string): Promise<boolean> {
		this.verifying = true;
		this.verify_error = null;

		try {
			const response = await ui_fetch('/api/account/login', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({username, password}),
			});

			if (response.ok) {
				this.verified = true;
				// Fetch account info
				await this.check_session();
				return true;
			}

			if (response.status === 429) {
				try {
					const data = await response.json();
					const minutes = Math.ceil((data.retry_after ?? 60) / 60);
					this.verify_error = `Too many attempts. Try again in ${minutes} minute${
						minutes === 1 ? '' : 's'
					}.`;
				} catch {
					this.verify_error = 'Too many attempts. Try again later.';
				}
			} else if (response.status === 401) {
				this.verify_error = 'Invalid credentials';
			} else {
				this.verify_error = `Error: ${response.status}`;
			}
			return false;
		} catch (e) {
			this.verify_error = to_error_message(e, 'Connection failed');
			return false;
		} finally {
			this.verifying = false;
		}
	}

	/**
	 * Bootstrap the first keeper account using a single-use token.
	 *
	 * @returns `true` if bootstrap succeeded, `false` otherwise
	 * @mutates `this`
	 */
	async bootstrap(token: string, username: string, password: string): Promise<boolean> {
		this.verifying = true;
		this.verify_error = null;

		try {
			const response = await ui_fetch('/api/account/bootstrap', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({token, username, password}),
			});

			if (response.ok) {
				this.verified = true;
				this.needs_bootstrap = false;
				await this.check_session();
				return true;
			}

			try {
				const data = await response.json();
				this.verify_error = data.error ?? `Error: ${response.status}`;
			} catch {
				this.verify_error = `Error: ${response.status}`;
			}
			return false;
		} catch (e) {
			this.verify_error = to_error_message(e, 'Connection failed');
			return false;
		} finally {
			this.verifying = false;
		}
	}

	/**
	 * Sign up via invite (or open signup, when `app_settings.open_signup`
	 * is true server-side). Translates 403 / 409 / 429 to friendly messages
	 * on `verify_error`.
	 *
	 * @returns `true` if signup succeeded, `false` otherwise
	 * @mutates `this`
	 */
	async signup(username: string, password: string, email?: string): Promise<boolean> {
		this.verifying = true;
		this.verify_error = null;

		try {
			const body: Record<string, string> = {username, password};
			if (email) body.email = email;

			const response = await ui_fetch('/api/account/signup', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(body),
			});

			if (response.ok) {
				this.verified = true;
				await this.check_session();
				return true;
			}

			if (response.status === 429) {
				try {
					const data = await response.json();
					const minutes = Math.ceil((data.retry_after ?? 60) / 60);
					this.verify_error = `Too many attempts. Try again in ${minutes} minute${
						minutes === 1 ? '' : 's'
					}.`;
				} catch {
					this.verify_error = 'Too many attempts. Try again later.';
				}
			} else if (response.status === 403) {
				this.verify_error = 'No matching invite found for these credentials.';
			} else if (response.status === 409) {
				this.verify_error = 'Username or email is already in use.';
			} else {
				this.verify_error = `Error: ${response.status}`;
			}
			return false;
		} catch (e) {
			this.verify_error = to_error_message(e, 'Connection failed');
			return false;
		} finally {
			this.verifying = false;
		}
	}

	/**
	 * Log out — best-effort `POST /api/account/logout` to clear the session
	 * cookie, then clears local state regardless of the network outcome.
	 *
	 * @mutates `this`
	 */
	async logout(): Promise<void> {
		try {
			await ui_fetch('/api/account/logout', {method: 'POST'});
		} catch {
			// Best-effort — clear local state regardless
		}
		this.verified = false;
		this.account = null;
		this.actor = null;
		this.role_grants = [];
	}
}
