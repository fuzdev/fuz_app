/**
 * Narrow filesystem seam for bootstrap token I/O.
 *
 * Bootstrap reads a one-shot token file on each request and burns it inside
 * the transaction the token authorized, just before the commit. The store
 * scopes to exactly those two operations so tests can swap in an in-memory
 * one without reaching for a general filesystem abstraction. Twin of the Rust
 * spine's `fuz_auth::BootstrapTokenStore`.
 *
 * @module
 */

import type { FsSecureBurnDeps, FsSecureReadDeps } from '../runtime/deps.ts';
import type { BurnOutcome, SecureReadOptions } from '../runtime/secure_file.ts';

/**
 * Two-operation seam for the one-shot bootstrap token file.
 *
 * Implementations must not trim or normalize the bytes `read_token` returns —
 * the caller strips one trailing LF and compares in constant time.
 *
 * Twin of the Rust `BootstrapTokenStore` trait, which has no `path`: the Rust
 * boot check (`is_bootstrap_available`) takes the path itself, while
 * `check_bootstrap_status` reads through this store and names the file in its
 * log lines from here.
 */
export interface BootstrapTokenStore {
	/** Where the token lives, named in operator log lines — never the token itself. */
	readonly path: string;
	/**
	 * Read the raw token bytes.
	 *
	 * @throws Error when the file is missing or refused
	 */
	read_token: () => Promise<Uint8Array>;
	/**
	 * Burn the token so it can never be presented again. Required, not
	 * best-effort: `bootstrap_account` calls it last inside the bootstrap
	 * transaction, and a throw rolls the bootstrap back
	 * (`token_file_undeletable`). `'already_gone'` — nothing was there — is a
	 * burn: the token can't be presented either way.
	 *
	 * @throws Error when the token can't be durably removed
	 */
	burn_token: () => Promise<BurnOutcome>;
}

/**
 * The secure read's strictness for the bootstrap token: a link count of 1,
 * beside the default checks, so the burn's unlink leaves no other name the
 * token can still be read under. Twin of the Rust
 * `BOOTSTRAP_TOKEN_READ_OPTIONS`.
 */
const BOOTSTRAP_TOKEN_READ_OPTIONS: SecureReadOptions = Object.freeze({
	require_single_link: true
});

/**
 * The production `BootstrapTokenStore`: the hardened secret read
 * (`read_secure_file` — a symlinked, non-regular, group/other-readable,
 * multiply-linked, or oversized file is refused, never read) and the durable
 * burn (`burn_secure_file` — unlink, then fsync the directory). The read
 * alone of the runtime's secure reads asks for a single link
 * (`BOOTSTRAP_TOKEN_READ_OPTIONS`): both of bootstrap's reads, the boot check
 * (`check_bootstrap_status`) and the request's, go through it. Twin of the
 * Rust `FileBootstrapTokenStore`.
 *
 * @param deps - the runtime's secure read and burn (`create_node_runtime()` satisfies both)
 * @param path - the bootstrap token file, `FUZ_BOOTSTRAP_TOKEN_PATH`
 * @returns a store over the file at `path`
 */
export const create_file_bootstrap_token_store = (
	deps: FsSecureReadDeps & FsSecureBurnDeps,
	path: string
): BootstrapTokenStore => ({
	path,
	read_token: () => deps.read_secure_file(path, BOOTSTRAP_TOKEN_READ_OPTIONS),
	burn_token: () => deps.burn_secure_file(path)
});
