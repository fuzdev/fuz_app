import '../assert_dev_env.ts';

/**
 * Stateless cross-process bootstrap.
 *
 * POSTs `{bootstrap_path}` against the running test binary with the
 * preconfigured token + username + password, parses the
 * `BootstrapOutput` envelope, captures the session `Set-Cookie` onto
 * the supplied `FetchTransport` (which carries it on every subsequent
 * call), and returns the keeper credentials.
 *
 * Fires exactly once per backend lifetime — `spawn_backend` calls it
 * inside vitest's `globalSetup`. Per-test fixtures re-use the captured
 * keeper credentials; fresh per-test accounts come from
 * `fixture.create_account()` (signup+login through production RPC),
 * not re-bootstrap. The hybrid reset model in `default_cross_process_setup`
 * depends on this — re-bootstrap would race the bootstrap lock and
 * in-memory caches.
 *
 * @module
 */

import { z } from 'zod';
import { Uuid } from '@fuzdev/fuz_util/id.ts';

import type { BackendConfig } from '../cross_backend/backend_config.ts';
import type { FetchTransport } from './fetch_transport.ts';

/**
 * The `BootstrapOutput` envelope shape the cross-process bootstrap call
 * cares about. Looser than the full `BootstrapOutput` Zod schema in
 * `auth/bootstrap_account.ts` — that schema is the canonical wire shape
 * on the server side, and this one is a structural subset the runner
 * uses to extract the keeper identity. Kept local so cross-process
 * testing doesn't pull the full auth-domain schema into its dep graph.
 */
const BootstrapResponse = z.object({
	account: z.object({ id: Uuid, username: z.string() }),
	actor: z.object({ id: Uuid })
});

/** Input for `bootstrap()`. */
export interface BootstrapOptions {
	/**
	 * The cookie-threading HTTP transport pointed at the binary. After
	 * `bootstrap()` resolves, the transport carries the keeper session
	 * cookie — every later call against it is authenticated as keeper.
	 */
	readonly transport: FetchTransport;
	/**
	 * Backend config — used for `bootstrap_path` plus the
	 * `bootstrap.username` / `bootstrap.password` / `bootstrap.token`
	 * credentials. The runner already wrote `bootstrap.token` to
	 * `bootstrap.token_path` before spawning, so the binary picks the
	 * token up at startup.
	 */
	readonly config: BackendConfig;
}

/** The keeper credentials captured from `POST /api/account/bootstrap`. */
export interface BootstrapResult {
	/**
	 * Same transport that came in, now carrying the keeper session
	 * cookie in its jar. Returned for call-site clarity (callers don't
	 * have to remember the mutation happens in place).
	 */
	readonly transport: FetchTransport;
	/** Account JSON returned by `POST /bootstrap`. */
	readonly account: { readonly id: Uuid; readonly username: string };
	/** Actor JSON returned by `POST /bootstrap`. */
	readonly actor: { readonly id: Uuid };
	/** Raw `Set-Cookie` values for threading into a WS transport. */
	readonly cookies: ReadonlyArray<string>;
}

/**
 * Fire `POST {config.bootstrap_path}` and capture the keeper session.
 *
 * @throws Error when the binary refuses bootstrap (non-2xx response) or
 *   the body fails to parse as the expected `{account, actor}` envelope.
 *   The error carries the status + raw body so a mistyped token /
 *   username collision / boot-time DB drift surfaces with enough
 *   context to debug.
 */
export const bootstrap = async (options: BootstrapOptions): Promise<BootstrapResult> => {
	const { transport, config } = options;
	const response = await transport(config.bootstrap_path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			token: config.bootstrap.token,
			username: config.bootstrap.username,
			password: config.bootstrap.password
		})
	});
	if (!response.ok) {
		const body = await response.text().catch(() => '<unreadable>');
		throw new Error(`bootstrap(${config.name}) failed: status=${response.status} body=${body}`);
	}
	const raw: unknown = await response.json();
	const parsed = BootstrapResponse.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`bootstrap(${config.name}) returned unexpected body: ${JSON.stringify(raw)} (${
				parsed.error.message
			})`
		);
	}
	return {
		transport,
		account: parsed.data.account,
		actor: parsed.data.actor,
		cookies: transport.cookies()
	};
};
