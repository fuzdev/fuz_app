import '../assert_dev_env.ts';

/**
 * The database a test leaves, read directly and normalized, so two backends
 * driven through the same requests can be compared row for row.
 *
 * The differentials compare answers. A write one backend makes and the other
 * doesn't — an audit field, a metadata key, a row inserted and rolled back —
 * reaches no answer unless some test reads it back, so it is invisible there.
 * `create_db_state_probe` reads a backend's database over its own
 * connection (the backend must be on PostgreSQL the test process reaches),
 * after draining the backend's in-flight detached writes (audit rows; on the
 * Rust spine also the token touch and the bootstrap write), and
 * `normalize_db_state` maps the rows onto a form both backends share when
 * they wrote the same things:
 *
 * Every table of the `public` schema is read (`schema_version` aside), its
 * columns and their types from `query_schema_snapshot`, so a new table or
 * column joins with no edit here, under the rules its type takes:
 *
 * - **Ids** become positional placeholders (`<id:1>`, `<tok:1>`), numbered
 *   by a canonical walk: the tables in `DB_STATE_TABLES` order, then any
 *   other in name order; each table's rows sorted by its `DB_STATE_SORT_KEYS`
 *   columns (accounts by username, actors by account and name, audit rows by
 *   `seq`), then by the whole row with no unnumbered id; each row's columns
 *   and every JSON object's keys sorted. So a reference — a column or a UUID
 *   inside `metadata` naming another row — compares, while the values
 *   themselves differ per backend.
 * - **Secrets and digests** — API tokens, bare 64-hex digests (a session's
 *   id, a token's hash) — become constants (`<token>`, `<hash>`): they are
 *   fresh per backend and nothing compares them. Sessions and tokens, sorted
 *   by account then content, compare as a multiset per account. A
 *   `password_hash` keeps its argon2 parameter prefix
 *   (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`), so the cost
 *   parameters compare and the salted digest doesn't. A `blake3:` content
 *   address and a `bytea` (hex) are compared as they are.
 * - **Generated usernames** (`GENERATED_USERNAME_PATTERN`) become positional
 *   placeholders like ids; a username a test names stays as it is.
 * - **Timestamps** — a timestamp column's value, and a second-precision ISO
 *   string inside a JSON value — become their dense rank among every
 *   timestamp in the dump (`<t:3>`); `null` stays `null`. Two writes in one
 *   transaction share a rank, a later write ranks after, and a backend
 *   setting a column the other leaves `null` differs.
 * - **A token's last use** — `api_token.last_used_at` — becomes `<set>` or
 *   stays `null`, and joins no rank: the touch is a detached write that runs
 *   concurrently with its own request's transaction on both spines, so its
 *   order against that request's writes is promised by neither, and ranking
 *   it would shift every later rank. `last_used_ip` compares as it is.
 * - **Expiries** — a column or JSON key named `expires_at`, in a row with a
 *   `created_at` — become their offset from that `created_at`, rounded to
 *   the minute (`+30d0h0m`), and join no rank: a rank keeps order and loses
 *   the duration, so a lifetime cut from 30 days to 7 would rank the same.
 * - **`seq`** becomes the offset from the dump's smallest, and the dump
 *   carries `audit_seq_advance`: how far the audit sequence moved between
 *   `mark` and the read, so an audit insert that rolled back — no row left,
 *   a sequence value spent — differs too. Rows of successive requests take
 *   `seq` in request order because fuz_app's two test binaries (the TS
 *   spine binary and `testing_spine_stub`) settle an HTTP answer's writes
 *   before answering (`await_pending_effects: true` on TS, the stub's
 *   `await_background_writes_layer`); in production a refusal's row is
 *   written after its answer, and the next request's row can land first.
 *
 * `diff_db_states` lists every place two normalized states differ, as
 * `DifferentialDiff`s under `db.` (`db.audit_log[2].metadata.reason`,
 * `db.audit_seq_advance`), the paths a known-divergence ledger names.
 *
 * Rows compare by position after the sort, so a row one backend writes and
 * the other doesn't shifts every later row of its table. Rows the sort can't
 * tell apart but for an id are ordered by that id's raw value, which differs
 * per backend; they then normalize equal unless something else references
 * them.
 *
 * @module
 */

import { create_db } from '../../db/create_db.ts';
import { assert_valid_sql_identifier } from '../../db/sql_identifier.ts';
import { query_schema_snapshot } from '../schema_introspect.ts';
import type { Db } from '../../db/db.ts';
import { DAEMON_TOKEN_HEADER } from '../../auth/daemon_token.ts';
import { create_fetch_transport } from '../transports/fetch_transport.ts';
import { cross_drain_effects } from './audit_cross_helpers.ts';
import { diff_differential_values, type DifferentialDiff } from './differential_normalize.ts';
import {
	GENERATED_USERNAME_PATTERN,
	type ReconstructedBootstrappedBackendHandle
} from './setup.ts';

/**
 * The order the canonical walk visits tables in, numbering their ids: each
 * row a later table references is numbered first. A table the database holds
 * and this list doesn't is walked after these, by name.
 */
export const DB_STATE_TABLES: ReadonlyArray<string> = [
	'bootstrap_lock',
	'app_settings',
	'account',
	'actor',
	'role_grant_offer',
	'role_grant',
	'invite',
	'auth_session',
	'api_token',
	'cell',
	'cell_grant',
	'cell_field',
	'cell_item',
	'fact',
	'fact_holder',
	'fact_ref',
	'memo',
	'audit_log'
];

/**
 * Per table, the columns its rows sort by, compared normalized (a reference
 * by the placeholder its row was numbered, a timestamp by rank) ahead of the
 * whole row. `audit_log` sorts by `seq`, numerically. Each table's natural
 * key, so rows tie only when they are alike but for an id — a tie falls back
 * to the raw row, whose order differs per backend.
 */
export const DB_STATE_SORT_KEYS: Readonly<Record<string, ReadonlyArray<string>>> = {
	account: ['username'],
	actor: ['account_id', 'name'],
	role_grant_offer: ['created_at', 'to_account_id', 'role'],
	role_grant: ['actor_id', 'created_at', 'role'],
	invite: ['created_at', 'username', 'email'],
	auth_session: ['account_id', 'created_at'],
	api_token: ['account_id', 'created_at', 'name'],
	cell: ['kind', 'created_at', 'path'],
	cell_grant: ['cell_id', 'actor_id', 'role', 'scope_id', 'level', 'created_at'],
	cell_field: ['source_id', 'name'],
	cell_item: ['parent_id', 'position'],
	// `blake3:` content addresses, compared verbatim, so they sort alike
	fact: ['hash'],
	fact_holder: ['hash', 'actor_id'],
	fact_ref: ['source_hash', 'target_hash'],
	memo: ['fn_id', 'input_hash'],
	audit_log: ['seq']
};

/** Tables a dump leaves out: the migration tracker, which no request writes. */
const DB_STATE_EXCLUDED_TABLES: ReadonlyArray<string> = ['schema_version'];

/** The canonical walk's table order over the tables a dump holds. */
const walk_order = (tables: Iterable<string>): Array<string> => {
	const held = new Set(tables);
	return [
		...DB_STATE_TABLES.filter((t) => held.has(t)),
		...[...held].filter((t) => !DB_STATE_TABLES.includes(t)).sort()
	];
};

/** Every generated username in a string. */
const GENERATED_USERNAMES = new RegExp(GENERATED_USERNAME_PATTERN.source, 'g');

const ARGON2_PREFIX = /^(\$argon2[a-z]+\$v=\d+\$[^$]+)\$[^$]+\$[^$]+$/;

/** Where the audit sequence stood before a test. */
export interface DbStateMark {
	readonly audit_seq: number;
}

/** A dump as read: per table, each column's type and the rows as JSON. */
export interface RawDbState {
	/** Per table, column name to `udt_name`. */
	readonly columns: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly rows: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;
	/** The audit sequence's value at the read less the mark's. */
	readonly audit_seq_advance: number;
}

/** A dump normalized — what two backends' dumps are compared as. */
export interface DbState {
	readonly tables: Record<string, Array<Record<string, unknown>>>;
	readonly audit_seq_advance: number;
}

/** Reads one backend's database around a test. */
export interface DbStateProbe {
	/** Where the audit sequence stands — call before the test's fixture. */
	readonly mark: () => Promise<DbStateMark>;
	/** Drain the backend's audit writes, then read and normalize the database. */
	readonly read: (mark: DbStateMark) => Promise<DbState>;
	/** Close the probe's connection. */
	readonly close: () => Promise<void>;
}

const TIMESTAMP_UDTS = new Set(['timestamptz', 'timestamp']);

/** A Postgres JSON timestamp (`2026-11-21T18:01:31.12+00:00`) or a wire one, as epoch microseconds. */
const COLUMN_TIMESTAMP_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

const timestamp_micros = (value: string): bigint | null => {
	const m = COLUMN_TIMESTAMP_PATTERN.exec(value);
	if (!m) return null;
	const [, y, mo, d, h, mi, s, frac = '', zone = 'Z'] = m;
	const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
	let offset_minutes = 0;
	if (zone !== 'Z') {
		const sign = zone.startsWith('-') ? -1 : 1;
		const digits = zone.slice(1).replace(':', '');
		offset_minutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'));
	}
	return BigInt(ms - offset_minutes * 60_000) * 1000n + BigInt(Number(frac.padEnd(6, '0')));
};

/** Second-precision ISO timestamps inside a JSON string (`ISO8601_SECONDS`, unanchored). */
const WIRE_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g;

const is_record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

/** Every string inside `value`, keys included — less an expiry's value when `skip_expiry`. */
const visit_strings = (
	value: unknown,
	on_string: (s: string) => void,
	skip_expiry: boolean
): void => {
	if (typeof value === 'string') on_string(value);
	else if (Array.isArray(value)) for (const v of value) visit_strings(v, on_string, skip_expiry);
	else if (is_record(value)) {
		for (const [k, v] of Object.entries(value)) {
			on_string(k);
			if (skip_expiry && is_expiry(k, v)) continue;
			visit_strings(v, on_string, skip_expiry);
		}
	}
};

/**
 * The column or JSON key holding an expiry, written as its offset from the
 * row's `created_at` (`format_expiry_offset`) rather than ranked — by name,
 * not by whether the instant lies after the read, which would turn on the
 * clock: a backdated or shortened credential's expiry is already past when
 * read.
 */
const EXPIRY_KEY = 'expires_at';

/**
 * Columns compared as set or not, never ranked — each written by a detached
 * write. `api_token.last_used_at`: the bearer leg's touch runs concurrently
 * with its own request's transaction on both spines, so its order against
 * that request's writes is promised by neither.
 */
const SET_ONLY_COLUMNS: ReadonlySet<string> = new Set(['api_token.last_used_at']);

/** The marker a non-null `SET_ONLY_COLUMNS` value becomes. */
const SET_MARKER = '<set>';

/**
 * Whether `key` and `value` are an expiry — the one test both the rank set's
 * skip and the offset rewrite read, so a value is never in neither.
 */
const is_expiry = (key: string, value: unknown): value is string =>
	key === EXPIRY_KEY && typeof value === 'string' && timestamp_micros(value) !== null;

/** The row's `created_at` as epoch microseconds, `null` for a row without one. */
const row_created_micros = (
	row: Record<string, unknown>,
	columns: Readonly<Record<string, string>>
): bigint | null => {
	const created = row.created_at;
	return TIMESTAMP_UDTS.has(columns.created_at ?? '') && typeof created === 'string'
		? timestamp_micros(created)
		: null;
};

const MICROS_PER_MINUTE = 60_000_000n;

/**
 * An expiry as its offset from the row's creation, rounded to the minute —
 * `+30d0h0m`, `-0d0h1m` for one already past at creation. The minute is far
 * coarser than one write's spread (an app clock against the database's, a
 * second-precision metadata copy) and far finer than any lifetime.
 */
const format_expiry_offset = (expires: bigint, created: bigint): string => {
	const delta = expires - created;
	const sign = delta < 0n ? '-' : '+';
	const magnitude = delta < 0n ? -delta : delta;
	const minutes = (magnitude + MICROS_PER_MINUTE / 2n) / MICROS_PER_MINUTE;
	return `${sign}${minutes / 1440n}d${(minutes % 1440n) / 60n}h${minutes % 60n}m`;
};

const compare_text = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** A sort key with its numbers (ranks, placeholders, offsets) padded, so they sort by value. */
const sortable = (key: string): string => key.replace(/\d+/g, (n) => n.padStart(12, '0'));

/**
 * Normalize a dump (module doc). Pure; numbering restarts for every call.
 *
 * @param raw - the rows and column types `create_db_state_probe` read
 * @returns the normalized state
 */
export const normalize_db_state = (raw: RawDbState): DbState => {
	// the timestamps' dense ranks, over every timestamp the dump holds
	const instants = new Set<bigint>();
	const add_instant = (s: string): void => {
		const micros = timestamp_micros(s);
		if (micros !== null) instants.add(micros);
	};
	const tables_walked = walk_order(Object.keys(raw.rows));
	for (const table of tables_walked) {
		const columns = raw.columns[table] ?? {};
		for (const row of raw.rows[table] ?? []) {
			const created = row_created_micros(row, columns);
			for (const [column, value] of Object.entries(row)) {
				if (created !== null && is_expiry(column, value)) continue;
				if (SET_ONLY_COLUMNS.has(`${table}.${column}`)) continue;
				if (TIMESTAMP_UDTS.has(columns[column] ?? '') && typeof value === 'string') {
					add_instant(value);
				} else {
					visit_strings(
						value,
						(s) => {
							for (const m of s.matchAll(WIRE_TIMESTAMP_PATTERN)) add_instant(m[0]);
						},
						created !== null
					);
				}
			}
		}
	}
	const ranks = new Map(
		[...instants].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).map((t, i) => [t, i + 1])
	);
	const rank_of = (s: string): string => {
		const micros = timestamp_micros(s);
		return micros === null ? s : `<t:${ranks.get(micros)}>`;
	};

	// positional placeholders, numbered as the walk first meets each value
	const seen = new Map<string, Map<string, string>>();
	const placeholder = (kind: string, value: string, assign: boolean): string => {
		let values = seen.get(kind);
		if (!values) {
			values = new Map();
			seen.set(kind, values);
		}
		const p = values.get(value);
		if (p !== undefined) return p;
		if (!assign) return `<${kind}:?>`;
		const next = `<${kind}:${values.size + 1}>`;
		values.set(value, next);
		return next;
	};
	const normalize_string = (value: string, assign: boolean): string =>
		value
			.replace(/secret_fuz_token_[A-Za-z0-9_-]+/g, '<token>')
			.replace(/(?<![\w-])tok_[\w-]{12}(?![\w-])/g, (m) => placeholder('tok', m, assign))
			.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) =>
				placeholder('id', m, assign)
			)
			.replace(GENERATED_USERNAMES, (m) => placeholder('username', m, assign))
			.replace(WIRE_TIMESTAMP_PATTERN, rank_of)
			.replace(/(?<!\w|blake3:)[0-9a-f]{64}(?!\w)/g, '<hash>');
	/** An expiry's offset from `created`, or `null` when it is no timestamp or the row has no creation. */
	const expiry_offset = (key: string, value: unknown, created: bigint | null): string | null =>
		created !== null && is_expiry(key, value)
			? format_expiry_offset(timestamp_micros(value)!, created)
			: null;
	const normalize_json = (value: unknown, assign: boolean, created: bigint | null): unknown => {
		if (typeof value === 'string') return normalize_string(value, assign);
		if (Array.isArray(value)) return value.map((v) => normalize_json(v, assign, created));
		if (is_record(value)) {
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(value).sort(compare_text)) {
				const offset = expiry_offset(key, value[key], created);
				out[normalize_string(key, assign)] = offset ?? normalize_json(value[key], assign, created);
			}
			return out;
		}
		return value;
	};

	const tables: Record<string, Array<Record<string, unknown>>> = {};
	for (const table of tables_walked) {
		const columns = raw.columns[table] ?? {};
		const rows = raw.rows[table] ?? [];
		const seqs = rows.map((r) => r.seq).filter((s): s is number => typeof s === 'number');
		const seq_min = seqs.length > 0 ? Math.min(...seqs) : 0;
		const normalize_row = (
			row: Record<string, unknown>,
			assign: boolean
		): Record<string, unknown> => {
			const out: Record<string, unknown> = {};
			const created = row_created_micros(row, columns);
			for (const column of Object.keys(row).sort(compare_text)) {
				const value = row[column];
				const offset = expiry_offset(column, value, created);
				if (value === null) out[column] = null;
				else if (SET_ONLY_COLUMNS.has(`${table}.${column}`)) out[column] = SET_MARKER;
				else if (offset !== null) out[column] = offset;
				else if (TIMESTAMP_UDTS.has(columns[column] ?? '') && typeof value === 'string') {
					out[column] = rank_of(value);
				} else if (column === 'seq' && typeof value === 'number') {
					out[column] = value - seq_min;
				} else if (column === 'password_hash' && typeof value === 'string') {
					const argon2 = ARGON2_PREFIX.exec(value);
					out[column] = argon2 ? `${argon2[1]}$<salt>$<hash>` : value;
				} else out[column] = normalize_json(value, assign, created);
			}
			return out;
		};
		// the sort key: the table's sort columns, then the row with no id
		// numbered yet, ranks and offsets padded so they sort as numbers; a tie
		// falls back to the raw row, which differs per backend
		const sort_columns = DB_STATE_SORT_KEYS[table] ?? [];
		const keyed = rows.map((row) => {
			const normalized = normalize_row(row, false);
			return {
				row,
				key: sortable(JSON.stringify([sort_columns.map((c) => normalized[c] ?? null), normalized])),
				tie: JSON.stringify(row)
			};
		});
		keyed.sort((x, y) => compare_text(x.key, y.key) || compare_text(x.tie, y.tie));
		tables[table] = keyed.map((k) => normalize_row(k.row, true));
	}
	return { tables, audit_seq_advance: raw.audit_seq_advance };
};

/**
 * Every place two normalized states differ, under `db.`: each table's rows
 * by position, then `db.audit_seq_advance`.
 *
 * @param a - one backend's state
 * @param b - the other's
 * @returns the differences, empty when the states are equal
 */
export const diff_db_states = (a: DbState, b: DbState): Array<DifferentialDiff> => [
	...diff_differential_values('db', a.tables, b.tables),
	...diff_differential_values('db.audit_seq_advance', a.audit_seq_advance, b.audit_seq_advance)
];

const read_audit_seq = async (db: Db): Promise<number> => {
	const [row] = await db.query<{ last_value: string | number; is_called: boolean }>(
		`SELECT last_value, is_called FROM audit_log_seq_seq`
	);
	if (!row) throw new Error('db state: audit_log_seq_seq has no row');
	const last = Number(row.last_value);
	return row.is_called ? last : last - 1;
};

/**
 * A probe over a backend's database, read directly — the backend's
 * `env.DATABASE_URL` must be a PostgreSQL URL the test process reaches. The
 * read drains the backend's in-flight detached writes (audit rows; on the
 * Rust spine also the token touch and the bootstrap write) first
 * (`_testing_drain_effects`, on the daemon token), so a WebSocket mutation's
 * row has landed.
 *
 * @param handle - the backend
 * @returns the probe; `close` it once its reads are done
 */
export const create_db_state_probe = (
	handle: ReconstructedBootstrappedBackendHandle
): DbStateProbe => {
	const { config } = handle;
	const database_url = config.env.DATABASE_URL ?? '';
	if (!/^postgres(ql)?:\/\//.test(database_url)) {
		throw new Error(
			`db state (${config.name}): DATABASE_URL is not a PostgreSQL URL the test process can read`
		);
	}
	let opened: Promise<{ db: Db; close: () => Promise<void> }> | null = null;
	let columns: Record<string, Record<string, string>> | null = null;
	const open = () => (opened ??= create_db(database_url));
	const drain_fixture = {
		fresh_transport: (options?: { readonly origin?: string | null }) =>
			create_fetch_transport({
				base_url: config.base_url,
				...(options?.origin !== undefined && { origin: options.origin })
			}),
		create_session_headers: () => ({}),
		create_daemon_token_headers: (extra?: Record<string, string>) => ({
			[DAEMON_TOKEN_HEADER]: handle.daemon_token,
			...extra
		})
	};
	return {
		mark: async () => ({ audit_seq: await read_audit_seq((await open()).db) }),
		read: async (mark) => {
			await cross_drain_effects(drain_fixture, config.rpc_path);
			const { db } = await open();
			if (!columns) {
				const snapshot = await query_schema_snapshot(db, {
					exclude_tables: DB_STATE_EXCLUDED_TABLES
				});
				const found: Record<string, Record<string, string>> = {};
				for (const [table, t] of Object.entries(snapshot.tables)) {
					found[table] = Object.fromEntries(
						Object.entries(t.columns).map(([column, c]) => [column, c.udt_name])
					);
				}
				columns = found;
			}
			const rows: Record<string, Array<Record<string, unknown>>> = {};
			for (const table of Object.keys(columns)) {
				assert_valid_sql_identifier(table);
				const read = await db.query<{ row: Record<string, unknown> }>(
					`SELECT to_jsonb(t) AS row FROM ${table} t`
				);
				rows[table] = read.map((r) => r.row);
			}
			const audit_seq_advance = (await read_audit_seq(db)) - mark.audit_seq;
			return normalize_db_state({ columns, rows, audit_seq_advance });
		},
		close: async () => {
			if (!opened) return;
			const { close } = await opened;
			opened = null;
			await close();
		}
	};
};
