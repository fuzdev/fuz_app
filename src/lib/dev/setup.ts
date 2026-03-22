/**
 * Dev workflow helpers for setup, reset, and database management.
 *
 * Composable functions that consumer projects (tx, visiones, etc.) use in their
 * `scripts/dev_setup.ts`, `scripts/dev_reset.ts`, etc. All functions accept narrow
 * `*Deps` interfaces from `runtime/deps.ts` — pass a `RuntimeDeps` instance
 * created by `create_deno_runtime()`.
 *
 * @module
 */

import type {
	CommandDeps,
	CommandResult,
	EnvDeps,
	FsReadDeps,
	FsRemoveDeps,
	FsWriteDeps,
} from '../runtime/deps.js';

/**
 * Optional logger for setup helpers.
 *
 * Functions that accept a logger use it for status messages.
 * When omitted, a default bracket-format logger writes to console.
 */
export interface SetupLogger {
	ok: (msg: string) => void;
	skip: (msg: string) => void;
	error: (msg: string) => void;
}

/** Default logger using bracket format. */
export const default_setup_logger: SetupLogger = {
	ok: (msg) => console.log(`  [ok] ${msg}`),
	skip: (msg) => console.log(`  [skip] ${msg}`),
	error: (msg) => console.error(`  [error] ${msg}`),
};

/** Result of `setup_env_file`. */
export interface SetupEnvResult {
	/** Whether a new file was created (vs updating existing). */
	created: boolean;
	/** Whether any values were generated/replaced. */
	updated: boolean;
	/** The env file path. */
	path: string;
}

/** Result of `setup_bootstrap_token`. */
export interface SetupTokenResult {
	/** Whether a new token was created (false if already existed). */
	created: boolean;
	/** The token file path. */
	token_path: string;
}

/** Result of `reset_database`. */
export interface ResetDbResult {
	/** Whether the database was actually reset. */
	reset: boolean;
	/** Whether the operation was skipped (e.g. pglite with no data dir). */
	skipped: boolean;
	/** What type of database was detected. */
	db_type: 'postgres' | 'pglite' | 'none';
}

/** Options for `setup_env_file`. */
export interface SetupEnvOptions {
	/**
	 * Extra env var replacements beyond the default `SECRET_COOKIE_KEYS`.
	 *
	 * Keys are env var names, values are async generators.
	 * Replaces `^KEY=$` (empty value) patterns in the env file.
	 */
	replacements?: Record<string, () => Promise<string>>;
	/** Optional callback to set file permissions (e.g. `Deno.chmod`). */
	set_permissions?: (path: string, mode: number) => Promise<void>;
	log?: SetupLogger;
}

/** Options for `setup_bootstrap_token`. */
export interface SetupBootstrapTokenOptions {
	/** State directory override. Defaults to `~/.{app_name}`. */
	state_dir?: string;
	/** Optional callback to set file/directory permissions. */
	set_permissions?: (path: string, mode: number) => Promise<void>;
	log?: SetupLogger;
}

/** Options for `create_database`. */
export interface CreateDatabaseOptions {
	log?: SetupLogger;
}

/** Options for `reset_database`. */
export interface ResetDatabaseOptions {
	/** Directory to remove for file-based pglite. */
	pglite_data_dir?: string;
	log?: SetupLogger;
}

// === Pure utilities ===

/**
 * Extract the database name from a PostgreSQL URL.
 *
 * @returns the database name, or `null` if the URL is invalid or has no path
 */
export const parse_db_name = (url: string): string | null => {
	try {
		const u = new URL(url);
		const name = u.pathname.slice(1); // remove leading /
		return name || null;
	} catch {
		return null;
	}
};

/**
 * Generate a random base64 key using openssl.
 *
 * @param deps - command execution capability
 * @returns a random 32-byte base64-encoded key
 */
export const generate_random_key = async (deps: CommandDeps): Promise<string> => {
	const result = await deps.run_command('openssl', ['rand', '-base64', '32']);
	if (!result.success) throw new Error('Failed to generate key with openssl');
	return result.stdout.trim();
};

// === File helpers ===

/**
 * Read a single env var from a dotenv-style file.
 *
 * @param deps - file read capability
 * @param env_path - path to the .env file
 * @param name - the variable name to read
 * @returns the value, or `undefined` if the file or variable doesn't exist
 */
export const read_env_var = async (
	deps: FsReadDeps,
	env_path: string,
	name: string,
): Promise<string | undefined> => {
	const stat = await deps.stat(env_path);
	if (!stat?.is_file) return undefined;
	try {
		const content = await deps.read_file(env_path);
		const match = new RegExp(`^${name}=(.+)$`, 'm').exec(content);
		return match?.[1]?.trim();
	} catch {
		return undefined;
	}
};

// === Setup helpers ===

/**
 * Create an env file from its example template, auto-generating `SECRET_COOKIE_KEYS`.
 *
 * If the file already exists, backfills any empty values that have generators.
 * Idempotent — safe to re-run.
 *
 * @param deps - file read, write, and command capabilities
 * @param env_path - path for the env file (e.g. `.env.development`)
 * @param example_path - path to the example template
 * @param options - extra replacements, permissions, logger
 * @returns result indicating whether the file was created or updated
 */
export const setup_env_file = async (
	deps: FsReadDeps & FsWriteDeps & CommandDeps,
	env_path: string,
	example_path: string,
	options?: SetupEnvOptions,
): Promise<SetupEnvResult> => {
	const log = options?.log ?? default_setup_logger;
	const set_permissions = options?.set_permissions;

	// build the full replacement map (SECRET_COOKIE_KEYS + extras)
	const replacements: Record<string, () => Promise<string>> = {
		SECRET_COOKIE_KEYS: () => generate_random_key(deps),
		...options?.replacements,
	};

	const stat = await deps.stat(env_path);
	if (stat?.is_file) {
		// file exists — backfill any empty values
		let content = await deps.read_file(env_path);
		let changed = false;

		for (const [key, generate] of Object.entries(replacements)) {
			const pattern = new RegExp(`^${key}=$`, 'm');
			if (pattern.test(content)) {
				const value = await generate(); // eslint-disable-line no-await-in-loop
				content = content.replace(pattern, `${key}=${value}`);
				changed = true;
				log.ok(`Generated ${key} in existing ${env_path}`);
			}
		}

		if (changed) {
			await deps.write_file(env_path, content);
			if (set_permissions) await set_permissions(env_path, 0o600);
		} else {
			log.skip(`${env_path} already configured`);
		}

		return {created: false, updated: changed, path: env_path};
	}

	// create from example
	let content = await deps.read_file(example_path);
	for (const [key, generate] of Object.entries(replacements)) {
		const pattern = new RegExp(`^${key}=$`, 'm');
		if (pattern.test(content)) {
			const value = await generate(); // eslint-disable-line no-await-in-loop
			content = content.replace(pattern, `${key}=${value}`);
		}
	}
	await deps.write_file(env_path, content);
	if (set_permissions) await set_permissions(env_path, 0o600);
	log.ok(`Created ${env_path} with generated secrets`);
	return {created: true, updated: true, path: env_path};
};

/**
 * Create a bootstrap token file if it doesn't exist.
 *
 * The token is a one-shot secret used to create the first admin account.
 * Stored at `~/.{app_name}/secret_bootstrap_token` by default.
 *
 * @param deps - file, command, and env capabilities
 * @param app_name - application name (used for default state directory)
 * @param options - state_dir override, permissions, logger
 * @returns result indicating whether a token was created
 */
export const setup_bootstrap_token = async (
	deps: FsReadDeps & FsWriteDeps & CommandDeps & EnvDeps,
	app_name: string,
	options?: SetupBootstrapTokenOptions,
): Promise<SetupTokenResult> => {
	const log = options?.log ?? default_setup_logger;
	const set_permissions = options?.set_permissions;

	const home = deps.env_get('HOME');
	if (!home) {
		log.skip('$HOME not set, skipping bootstrap token');
		return {created: false, token_path: ''};
	}

	const state_dir = options?.state_dir ?? `${home}/.${app_name}`;
	const token_path = `${state_dir}/secret_bootstrap_token`;

	const stat = await deps.stat(token_path);
	if (stat?.is_file) {
		log.skip(`~/.${app_name}/secret_bootstrap_token already exists`);
		return {created: false, token_path};
	}

	await deps.mkdir(state_dir, {recursive: true});
	if (set_permissions) await set_permissions(state_dir, 0o700);
	const key = await generate_random_key(deps);
	await deps.write_file(token_path, key + '\n');
	if (set_permissions) await set_permissions(token_path, 0o600);
	log.ok(`Created ~/.${app_name}/secret_bootstrap_token (one-shot, deleted after first use)`);
	return {created: true, token_path};
};

/**
 * Remove an existing bootstrap token and create a new one.
 *
 * @param deps - file, command, env, and remove capabilities
 * @param app_name - application name
 * @param options - state_dir override, permissions, logger
 * @returns result from creating the new token
 */
export const reset_bootstrap_token = async (
	deps: FsReadDeps & FsWriteDeps & FsRemoveDeps & CommandDeps & EnvDeps,
	app_name: string,
	options?: SetupBootstrapTokenOptions,
): Promise<SetupTokenResult> => {
	const log = options?.log ?? default_setup_logger;
	const set_permissions = options?.set_permissions;

	const home = deps.env_get('HOME');
	if (!home) {
		log.skip('$HOME not set');
		return {created: false, token_path: ''};
	}

	const state_dir = options?.state_dir ?? `${home}/.${app_name}`;
	const token_path = `${state_dir}/secret_bootstrap_token`;

	const stat = await deps.stat(token_path);
	if (stat?.is_file) {
		await deps.remove(token_path);
		log.ok('Removed existing bootstrap token');
	}

	return setup_bootstrap_token(deps, app_name, {state_dir, set_permissions, log});
};

// === Database helpers ===

/**
 * Create a PostgreSQL database if `createdb` is available.
 *
 * @param deps - command execution capability
 * @param db_name - database name to create
 * @param options - logger
 * @returns the command result
 */
export const create_database = async (
	deps: CommandDeps,
	db_name: string,
	options?: CreateDatabaseOptions,
): Promise<CommandResult> => {
	const log = options?.log ?? default_setup_logger;

	const check = await deps.run_command('which', ['createdb']);
	if (!check.success) {
		log.skip('createdb not found — install PostgreSQL or use pglite');
		return check;
	}

	const result = await deps.run_command('createdb', [db_name]);
	if (result.success) {
		log.ok(`Created ${db_name} database`);
	} else {
		log.skip(`${db_name} database already exists`);
	}
	return result;
};

/**
 * Reset a database to a clean slate.
 *
 * For PostgreSQL: drops and recreates the database.
 * For pglite: removes the data directory if `pglite_data_dir` is provided.
 * For empty/missing URLs: skips.
 *
 * @param deps - command and file capabilities
 * @param database_url - the DATABASE_URL value
 * @param options - pglite_data_dir, logger
 * @returns result describing what happened
 */
export const reset_database = async (
	deps: CommandDeps & FsReadDeps & FsRemoveDeps,
	database_url: string,
	options?: ResetDatabaseOptions,
): Promise<ResetDbResult> => {
	const log = options?.log ?? default_setup_logger;

	// empty or missing
	if (!database_url) {
		log.skip('No DATABASE_URL, skipping database reset');
		return {reset: false, skipped: true, db_type: 'none'};
	}

	// pglite
	if (database_url === 'pglite' || database_url.startsWith('pglite:')) {
		const pglite_dir = options?.pglite_data_dir;
		if (pglite_dir) {
			const stat = await deps.stat(pglite_dir);
			if (stat?.is_directory) {
				await deps.remove(pglite_dir, {recursive: true});
				log.ok(`Removed pglite directory: ${pglite_dir}`);
				return {reset: true, skipped: false, db_type: 'pglite'};
			}
		}
		log.skip('No pglite directory to remove');
		return {reset: false, skipped: true, db_type: 'pglite'};
	}

	// PostgreSQL
	const db_name = parse_db_name(database_url);
	if (!db_name) {
		log.error('Could not parse database name from DATABASE_URL');
		return {reset: false, skipped: true, db_type: 'postgres'};
	}

	const drop = await deps.run_command('dropdb', ['--if-exists', db_name]);
	if (!drop.success) {
		log.error(`Failed to drop database: ${drop.stderr}`);
		return {reset: false, skipped: false, db_type: 'postgres'};
	}
	log.ok(`Dropped database: ${db_name}`);

	const create = await deps.run_command('createdb', [db_name]);
	if (!create.success) {
		log.error(`Failed to create database: ${create.stderr}`);
		return {reset: false, skipped: false, db_type: 'postgres'};
	}
	log.ok(`Created database: ${db_name}`);

	return {reset: true, skipped: false, db_type: 'postgres'};
};
