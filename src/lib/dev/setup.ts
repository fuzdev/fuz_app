/**
 * Dev workflow helpers for setup, reset, and database management.
 *
 * Composable functions that consumer projects use in their dev setup and
 * reset tasks. File and env access come through narrow `*Deps` interfaces
 * from `runtime/deps.ts`, which a `RuntimeDeps` from `create_node_runtime()`
 * satisfies. The Postgres client programs the database helpers run come
 * through `PostgresProgramDeps`, each a factory the task root writes over its
 * spawn (with gro, `(env) => spawn.find('createdb', {pass_env: ['PG*'], env})`),
 * so the root decides which binary runs and which environment it sees.
 *
 * @module
 */

import { to_hex } from '@fuzdev/fuz_util/hex.ts';

import type {
	EnvDeps,
	FsReadDeps,
	FsRemoveDeps,
	FsWriteDeps,
	ProgramFactory,
	ProgramOutput
} from '../runtime/deps.ts';
import type { QueryDeps } from '../db/query_deps.ts';
import { is_pg_database_url } from '../db/create_db.ts';
import {
	is_createdb_already_exists,
	parse_db_name,
	to_createdb_args,
	to_dropdb_args,
	to_postgres_password_env
} from '../db/postgres_url.ts';
import { load_env_file, parse_dotenv } from '../env/dotenv.ts';
import { update_env_content } from '../env/update_env_variable.ts';
import { write_file_atomic } from '../runtime/fs.ts';
import {
	query_account_by_username,
	query_actors_by_account,
	query_create_account_with_actor
} from '../auth/account_queries.ts';
import { query_create_role_grant } from '../auth/role_grant_queries.ts';

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
	error: (msg) => console.error(`  [error] ${msg}`)
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

/**
 * The kind of database a `DATABASE_URL` names, by the scheme `create_db`
 * routes on: `postgres://` / `postgresql://`, `file://` (PGlite), `memory://`
 * (pglet), or `'none'` for an empty or unsupported URL.
 */
export type SetupDbType = 'postgres' | 'pglite' | 'memory' | 'none';

/** Result of `create_database`. */
export type CreateDatabaseResult =
	/** `createdb` created the database. */
	| { kind: 'created'; database: string }
	/** The database already existed. */
	| { kind: 'exists'; database: string }
	/** Nothing to create: a URL that isn't Postgres, or no `createdb` installed. */
	| { kind: 'skipped'; db_type: SetupDbType; message: string }
	/** The database was not created; `message` is what was logged. */
	| { kind: 'failed'; message: string };

/** Result of `reset_database`. */
export interface ResetDbResult {
	/** Whether the database was actually reset. */
	reset: boolean;
	/** Whether there was nothing to reset (no URL, an in-memory URL, PGlite with no data dir). */
	skipped: boolean;
	/** What type of database the URL names. */
	db_type: SetupDbType;
}

/** Options for `setup_env_file`. */
export interface SetupEnvOptions {
	/**
	 * Extra env var replacements beyond the default `SECRET_FUZ_COOKIE_KEYS`.
	 *
	 * Keys are env var names, values are async generators. Each fills a key
	 * the env file assigns an empty value (`KEY=`, `KEY=""`), written through
	 * `update_env_content` (quoted when the value needs it, never interpreted);
	 * a key the file doesn't assign is left out.
	 */
	replacements?: Record<string, () => Promise<string>>;
	log?: SetupLogger;
}

/** Options for `setup_bootstrap_token`. */
export interface SetupBootstrapTokenOptions {
	/** State directory override. Defaults to `~/.{app_name}`, which needs `$HOME`. */
	state_dir?: string;
	log?: SetupLogger;
}

/** Options for `create_database`. */
export interface CreateDatabaseOptions {
	log?: SetupLogger;
}

/** Options for `reset_database`. */
export interface ResetDatabaseOptions {
	/**
	 * The PGlite data directory to remove for a `file://` URL. Named by the
	 * caller, never derived from the URL, so a mistyped `DATABASE_URL` can't
	 * aim a recursive remove; without it a `file://` reset is skipped.
	 */
	pglite_data_dir?: string;
	log?: SetupLogger;
}

/**
 * The Postgres client programs the database helpers run, each as a factory
 * that makes the program with extra environment, `null` when it isn't
 * installed. A helper calls each factory once per run with the environment
 * that carries `DATABASE_URL`'s password (`{PGPASSWORD}`, or `{}` for a URL
 * with none), so the password reaches the program the way libpq reads it and
 * never its argv. At a gro task root:
 * `(env) => spawn.find('createdb', {pass_env: ['PG*'], env})` — `env` wins over
 * a host `PGPASSWORD` that `PG*` forwards, and gro's spawn base passes `HOME`
 * for `~/.pgpass`.
 *
 * Each program connects to the server `DATABASE_URL` names: host, port, role,
 * and query parameters (`sslmode`, a socket `host`) all come from the URL,
 * through `--maintenance-db` (`to_maintenance_database_url`). With no host,
 * as in `postgres:///app`, libpq uses its default socket.
 */
export interface PostgresProgramDeps {
	/** Makes `createdb`, or `null` when it isn't installed. */
	createdb: ProgramFactory;
	/** Makes `dropdb`, or `null` when it isn't installed. */
	dropdb: ProgramFactory;
}

// === Pure utilities ===

/** What kind of database `database_url` names, by `create_db`'s schemes. */
const to_setup_db_type = (database_url: string): SetupDbType => {
	if (is_pg_database_url(database_url)) return 'postgres';
	if (database_url.startsWith('file://')) return 'pglite';
	if (database_url.startsWith('memory://')) return 'memory';
	return 'none';
};

/** A program output's failure, as text: its stderr, or how it ended. */
const describe_program_failure = (output: ProgramOutput): string => {
	const stderr = output.stderr.trim();
	if (stderr) return stderr;
	switch (output.kind) {
		case 'exited':
			return `exited with code ${output.code}`;
		case 'signaled':
			return `ended by ${output.signal}`;
		default:
			return output.kind === 'timed_out' ? 'timed out' : 'aborted';
	}
};

/** Whether a program output is a clean exit. */
const is_program_success = (output: ProgramOutput): boolean =>
	output.kind === 'exited' && output.code === 0;

/**
 * The hint a failed Postgres client gets when the server wanted a password
 * `DATABASE_URL` doesn't carry: where else the program can read one.
 */
const password_hint = (output: ProgramOutput, password_env: Record<string, string>): string =>
	output.stderr.includes('password') && password_env.PGPASSWORD === undefined
		? ' (DATABASE_URL has no password: put it in the URL, or give the program PGPASSWORD ' +
			'in its environment or a ~/.pgpass entry)'
		: '';

/**
 * The URL's password as program environment, or a failure message when its
 * percent-escape is malformed — never naming the password.
 */
const read_password_env = (
	database_url: string
): { ok: true; env: Record<string, string> } | { ok: false; message: string } => {
	const env = to_postgres_password_env(database_url);
	return env === null
		? { ok: false, message: "DATABASE_URL's password has a malformed percent-escape" }
		: { ok: true, env };
};

/**
 * Mint an operator-facing secret: 32 random bytes as lowercase hex, the shape
 * `openssl rand -hex 32` writes, so a hand-made secret and a generated one
 * look the same.
 */
const generate_secret_hex = (): string => to_hex(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Generate a cookie signing key in-process: 32 random bytes, hex-encoded.
 *
 * Hex, not base64url: `SECRET_FUZ_COOKIE_KEYS` separates rotated keys with
 * `__`, which base64url's alphabet can produce inside one key.
 *
 * @returns a 64-character lowercase hex key
 */
export const generate_cookie_key = (): string => generate_secret_hex();

// === File helpers ===

/**
 * Read a single env var from a dotenv-style file.
 *
 * Delegates to `load_env_file` so the value is tokenized exactly like every
 * other dotenv read — surrounding quotes, inline comments, and escapes are
 * handled, and a leading `export ` is tolerated. Returns `undefined` when the
 * file is absent or the variable is unset; a read error other than the file
 * not existing (permission denied, I/O failure) propagates rather than being
 * masked as "not found".
 *
 * @param deps - file read capability
 * @param env_path - path to the .env file
 * @param name - the variable name to read
 * @returns the value, or `undefined` if the file or variable doesn't exist
 * @throws Error if reading fails for any reason other than `ENOENT`
 */
export const read_env_var = async (
	deps: Pick<FsReadDeps, 'read_text_file'>,
	env_path: string,
	name: string
): Promise<string | undefined> => {
	const env = await load_env_file(deps, env_path);
	return env?.[name];
};

// === Setup helpers ===

/**
 * Fill each key in `replacements` that `content` assigns an empty value.
 *
 * @returns the updated content and the keys it generated
 */
const fill_empty_env_values = async (
	content: string,
	replacements: Record<string, () => Promise<string>>
): Promise<{ content: string; generated: Array<string> }> => {
	const current = parse_dotenv(content);
	const generated: Array<string> = [];
	let next = content;
	for (const [key, generate] of Object.entries(replacements)) {
		if (current[key] !== '') continue;
		next = update_env_content(next, key, await generate());
		generated.push(key);
	}
	return { content: next, generated };
};

/**
 * Create an env file from its example template, auto-generating `SECRET_FUZ_COOKIE_KEYS`.
 *
 * If the file already exists, backfills any empty values that have generators.
 * Idempotent — safe to re-run. Values are written through `update_env_content`,
 * the one env-file writer.
 *
 * @param deps - file read and write capabilities
 * @param env_path - path for the env file (e.g. `.env.development`)
 * @param example_path - path to the example template
 * @param options - extra replacements, logger
 * @returns result indicating whether the file was created or updated
 * @mutates filesystem - writes `env_path` atomically at mode `0o600` (creating from `example_path` if missing)
 */
export const setup_env_file = async (
	deps: FsReadDeps & FsWriteDeps,
	env_path: string,
	example_path: string,
	options?: SetupEnvOptions
): Promise<SetupEnvResult> => {
	const log = options?.log ?? default_setup_logger;

	// build the full replacement map (SECRET_FUZ_COOKIE_KEYS + extras)
	const replacements: Record<string, () => Promise<string>> = {
		SECRET_FUZ_COOKIE_KEYS: () => Promise.resolve(generate_cookie_key()),
		...options?.replacements
	};

	const stat = await deps.stat(env_path);
	if (stat?.is_file) {
		// file exists — backfill any empty values
		const filled = await fill_empty_env_values(await deps.read_text_file(env_path), replacements);
		for (const key of filled.generated) log.ok(`Generated ${key} in existing ${env_path}`);
		const changed = filled.generated.length > 0;

		if (changed) {
			// Atomic replace at 0600 — the backfill just wrote secrets into the
			// file, so publishing a fresh owner-only inode also repairs a
			// hand-made permissive .env in the same step the old chmod covered.
			await write_file_atomic(deps, env_path, filled.content, { mode: 0o600 });
		} else {
			log.skip(`${env_path} already configured`);
		}

		return { created: false, updated: changed, path: env_path };
	}

	// create from example
	const filled = await fill_empty_env_values(await deps.read_text_file(example_path), replacements);
	await write_file_atomic(deps, env_path, filled.content, { mode: 0o600 });
	log.ok(`Created ${env_path} with generated secrets`);
	return { created: true, updated: true, path: env_path };
};

/**
 * The bootstrap token's state directory: `state_dir` when given, else
 * `~/.{app_name}`, or `null` when neither is available.
 */
const to_token_state_dir = (
	deps: EnvDeps,
	app_name: string,
	state_dir: string | undefined
): string | null => {
	if (state_dir !== undefined) return state_dir;
	const home = deps.env_get('HOME');
	return home ? `${home}/.${app_name}` : null;
};

/**
 * Create a bootstrap token file if it doesn't exist.
 *
 * The token is a one-shot secret used to create the first admin account:
 * 32 random bytes as 64 lowercase hex characters plus one LF, the file
 * `openssl rand -hex 32` writes. Stored at `{state_dir}/secret_bootstrap_token`,
 * `state_dir` defaulting to `~/.{app_name}`; skipped only when no `state_dir`
 * is given and `$HOME` is unset.
 *
 * @param deps - file and env capabilities
 * @param app_name - application name (used for default state directory)
 * @param options - state_dir override, logger
 * @returns result indicating whether a token was created
 * @mutates filesystem - creates the state directory (`0o700`) and writes the token file atomically at `0o600`
 */
export const setup_bootstrap_token = async (
	deps: FsReadDeps & FsWriteDeps & EnvDeps,
	app_name: string,
	options?: SetupBootstrapTokenOptions
): Promise<SetupTokenResult> => {
	const log = options?.log ?? default_setup_logger;

	const state_dir = to_token_state_dir(deps, app_name, options?.state_dir);
	if (state_dir === null) {
		log.skip('$HOME not set and no state_dir given, skipping bootstrap token');
		return { created: false, token_path: '' };
	}
	const token_path = `${state_dir}/secret_bootstrap_token`;

	const stat = await deps.stat(token_path);
	if (stat?.is_file) {
		log.skip(`${token_path} already exists`);
		return { created: false, token_path };
	}

	// Modes apply at creation — an already-existing state dir keeps its mode.
	// The token itself is always freshly created here (the stat above skipped
	// existing files), so its 0600 holds unconditionally; the server-side
	// `read_secure_file` refuses anything laxer at read time.
	await deps.mkdir(state_dir, { recursive: true, mode: 0o700 });
	const token = generate_secret_hex();
	await write_file_atomic(deps, token_path, token + '\n', { mode: 0o600 });
	log.ok(`Created ${token_path} (one-shot, deleted after first use)`);
	return { created: true, token_path };
};

/**
 * Remove an existing bootstrap token and create a new one, in the state
 * directory `setup_bootstrap_token` uses.
 *
 * @param deps - file, env, and remove capabilities
 * @param app_name - application name
 * @param options - state_dir override, logger
 * @returns result from creating the new token
 * @mutates filesystem - removes the existing token file (if any) then writes a fresh one
 */
export const reset_bootstrap_token = async (
	deps: FsReadDeps & FsWriteDeps & FsRemoveDeps & EnvDeps,
	app_name: string,
	options?: SetupBootstrapTokenOptions
): Promise<SetupTokenResult> => {
	const log = options?.log ?? default_setup_logger;

	const state_dir = to_token_state_dir(deps, app_name, options?.state_dir);
	if (state_dir === null) {
		log.skip('$HOME not set and no state_dir given, skipping bootstrap token');
		return { created: false, token_path: '' };
	}
	const token_path = `${state_dir}/secret_bootstrap_token`;

	const stat = await deps.stat(token_path);
	if (stat?.is_file) {
		await deps.remove(token_path);
		log.ok(`Removed existing ${token_path}`);
	}

	return setup_bootstrap_token(deps, app_name, { state_dir, log });
};

// === Database helpers ===

/**
 * Create the PostgreSQL database `database_url` names, on the server it
 * names, when it's missing.
 *
 * Runs `createdb --no-password --maintenance-db=<maintenance URL> -- <name>`
 * (`to_createdb_args`) through the program `deps.createdb` makes, with the
 * URL's password in its environment (see `PostgresProgramDeps`). A URL that
 * isn't Postgres (`file://`, `memory://`) has nothing to create and is
 * skipped, as is a missing `createdb`. Does not throw on a failed `createdb` —
 * the result says what happened, and the log says why; a `createdb` that
 * can't start throws.
 *
 * On a server whose `lc_messages` isn't English, an existing database is
 * reported as `failed`, since only Postgres's English refusal is recognized.
 * A capped (truncated) output is read as it came: a clean exit is still
 * success, and a cut stderr is still searched for the refusal.
 *
 * @param deps - the `createdb` factory
 * @param database_url - the `DATABASE_URL` value
 * @param options - logger
 * @returns what happened
 * @mutates external database - creates the database on the server `database_url` names
 */
export const create_database = async (
	deps: Pick<PostgresProgramDeps, 'createdb'>,
	database_url: string,
	options?: CreateDatabaseOptions
): Promise<CreateDatabaseResult> => {
	const log = options?.log ?? default_setup_logger;

	const db_type = to_setup_db_type(database_url);
	if (db_type !== 'postgres') {
		const message =
			db_type === 'none'
				? 'No Postgres DATABASE_URL, skipping database creation'
				: `A ${db_type} DATABASE_URL needs no createdb`;
		log.skip(message);
		return { kind: 'skipped', db_type, message };
	}

	const database = parse_db_name(database_url);
	if (database === null) {
		const message = 'Could not parse database name from DATABASE_URL';
		log.error(message);
		return { kind: 'failed', message };
	}

	const password = read_password_env(database_url);
	if (!password.ok) {
		log.error(password.message);
		return { kind: 'failed', message: password.message };
	}

	const createdb = deps.createdb(password.env);
	if (createdb === null) {
		const message =
			'createdb not found — install PostgreSQL, or use a file:// (PGlite) or memory:// DATABASE_URL';
		log.skip(message);
		return { kind: 'skipped', db_type, message };
	}

	const output = await createdb.out(to_createdb_args(database, database_url));
	if (is_program_success(output)) {
		log.ok(`Created ${database} database`);
		return { kind: 'created', database };
	}
	if (is_createdb_already_exists(output.stderr, database)) {
		log.skip(`${database} database already exists`);
		return { kind: 'exists', database };
	}
	const message = `Failed to create database ${database}: ${describe_program_failure(output)}${password_hint(output, password.env)}`;
	log.error(message);
	return { kind: 'failed', message };
};

/**
 * Reset a database to a clean slate.
 *
 * For PostgreSQL: drops and recreates the database `database_url` names, on
 * the server it names, through the programs `deps.dropdb` and `deps.createdb`
 * make (see `PostgresProgramDeps`; argv from `to_dropdb_args` /
 * `to_createdb_args`). For PGlite (`file://`): removes
 * `options.pglite_data_dir` when given. For an in-memory (`memory://`), empty,
 * or missing URL: skips. An unsupported URL is an error, never dropped.
 *
 * @param deps - the Postgres program factories and file capabilities
 * @param database_url - the `DATABASE_URL` value
 * @param options - `pglite_data_dir`, logger
 * @returns result describing what happened
 * @mutates external database - drops and recreates the PostgreSQL database on the server `database_url` names
 * @mutates filesystem - removes `options.pglite_data_dir` recursively for `file://` URLs
 */
export const reset_database = async (
	deps: PostgresProgramDeps & Pick<FsReadDeps, 'stat'> & FsRemoveDeps,
	database_url: string,
	options?: ResetDatabaseOptions
): Promise<ResetDbResult> => {
	const log = options?.log ?? default_setup_logger;

	// empty or missing
	if (!database_url) {
		log.skip('No DATABASE_URL, skipping database reset');
		return { reset: false, skipped: true, db_type: 'none' };
	}

	const db_type = to_setup_db_type(database_url);

	if (db_type === 'none') {
		log.error('Unsupported DATABASE_URL scheme — expected postgres://, file://, or memory://');
		return { reset: false, skipped: false, db_type };
	}

	if (db_type === 'memory') {
		log.skip('An in-memory database has nothing to reset');
		return { reset: false, skipped: true, db_type };
	}

	if (db_type === 'pglite') {
		const pglite_dir = options?.pglite_data_dir;
		if (pglite_dir) {
			const stat = await deps.stat(pglite_dir);
			if (stat?.is_directory) {
				await deps.remove(pglite_dir, { recursive: true });
				log.ok(`Removed pglite directory: ${pglite_dir}`);
				return { reset: true, skipped: false, db_type };
			}
		}
		log.skip('No pglite directory to remove');
		return { reset: false, skipped: true, db_type };
	}

	const db_name = parse_db_name(database_url);
	if (!db_name) {
		log.error('Could not parse database name from DATABASE_URL');
		return { reset: false, skipped: false, db_type };
	}

	const password = read_password_env(database_url);
	if (!password.ok) {
		log.error(password.message);
		return { reset: false, skipped: false, db_type };
	}

	const dropdb = deps.dropdb(password.env);
	const createdb = deps.createdb(password.env);
	if (dropdb === null || createdb === null) {
		const missing = [dropdb === null && 'dropdb', createdb === null && 'createdb']
			.filter(Boolean)
			.join(' and ');
		log.error(`${missing} not found — install PostgreSQL to reset a Postgres database`);
		return { reset: false, skipped: false, db_type };
	}

	const drop = await dropdb.out(to_dropdb_args(db_name, database_url));
	if (!is_program_success(drop)) {
		log.error(
			`Failed to drop database: ${describe_program_failure(drop)}${password_hint(drop, password.env)}`
		);
		return { reset: false, skipped: false, db_type };
	}
	log.ok(`Dropped database: ${db_name}`);

	const create = await createdb.out(to_createdb_args(db_name, database_url));
	if (!is_program_success(create)) {
		log.error(
			`Failed to create database: ${describe_program_failure(create)}${password_hint(create, password.env)}`
		);
		return { reset: false, skipped: false, db_type };
	}
	log.ok(`Created database: ${db_name}`);

	return { reset: true, skipped: false, db_type };
};

// === Dev account helpers ===

/** Input to `seed_dev_account`. */
export interface SeedDevAccountInput {
	/**
	 * Account username, stored lowercased, as the `account_username_lowercase`
	 * CHECK requires. Its length and grammar (`Username`) are not checked.
	 */
	username: string;
	/** Account password, hashed as given — the password policy is bypassed. */
	password: string;
	/** Roles to grant via role_grant (idempotent). */
	roles?: ReadonlyArray<string>;
}

/** Result of `seed_dev_account`. */
export interface SeedDevAccountResult {
	account_id: string;
	actor_id: string;
	/** True if a new account was created; false if one already existed. */
	created: boolean;
}

/** Dependencies for `seed_dev_account`. */
export interface SeedDevAccountDeps extends QueryDeps {
	/** Password hasher (e.g., `argon2_password_deps.hash_password`). */
	hash_password: (password: string) => Promise<string>;
}

/**
 * Seed a development test account, bypassing the username and password
 * policy: the username is stored lowercased, for the account and its actor's
 * `name`, its length and grammar unchecked, and the password is hashed as
 * given.
 *
 * Idempotent by username, compared case-insensitively — if an account with
 * the given username already exists, reuses it and only reconciles the
 * requested role grants. Never updates an existing password (rerun would
 * silently rotate it).
 *
 * Intended for a dev setup task — do not call in production.
 *
 * @mutates database - inserts an account/actor pair when missing and grants any requested role role_grants
 * @throws Error if an existing account is found without an associated actor row
 */
export const seed_dev_account = async (
	deps: SeedDevAccountDeps,
	input: SeedDevAccountInput,
	options?: { log?: SetupLogger }
): Promise<SeedDevAccountResult> => {
	const log = options?.log ?? default_setup_logger;
	const query_deps: QueryDeps = { db: deps.db };

	const username = input.username.toLowerCase();
	const existing = await query_account_by_username(query_deps, username);
	if (existing) {
		const actors = await query_actors_by_account(query_deps, existing.id);
		if (actors.length === 0) {
			log.error(`dev account '${input.username}' exists but has no actor`);
			throw new Error(`dev account '${input.username}' has no actor`);
		}
		// Dev seed is single-actor by construction; pick the first.
		const actor = actors[0]!;
		for (const role of input.roles ?? []) {
			await query_create_role_grant(query_deps, {
				actor_id: actor.id,
				role,
				granted_by: null,
				expires_at: null
			});
		}
		log.skip(`Dev account '${input.username}' already exists`);
		return { account_id: existing.id, actor_id: actor.id, created: false };
	}

	const password_hash = await deps.hash_password(input.password);
	const { account, actor } = await query_create_account_with_actor(query_deps, {
		username,
		password_hash
	});
	for (const role of input.roles ?? []) {
		await query_create_role_grant(query_deps, {
			actor_id: actor.id,
			role,
			granted_by: null,
			expires_at: null
		});
	}
	log.ok(`Seeded dev account '${input.username}'`);
	return { account_id: account.id, actor_id: actor.id, created: true };
};
