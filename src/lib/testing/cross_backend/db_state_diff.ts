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
 * after draining the backend's in-flight audit writes, and
 * `normalize_db_state` maps the rows onto a form both backends share when
 * they wrote the same things:
 *
 * - **Ids** become positional placeholders (`<id:1>`, `<tok:1>`), numbered
 *   by a canonical walk: the tables in `DB_STATE_TABLES` order, each table's
 *   rows sorted by a key holding no unnumbered id (an audit row by `seq`),
 *   each row's columns and every JSON object's keys sorted. So a reference —
 *   a column or a UUID inside `metadata` naming another row — compares, while
 *   the values themselves differ per backend.
 * - **Secrets and digests** — API tokens, bare 64-hex digests — become
 *   constants (`<token>`, `<hash>`): they are fresh per backend and nothing
 *   compares them.
 * - **Generated usernames** (`GENERATED_USERNAME_PATTERN`) become positional
 *   placeholders like ids; a username a test names stays as it is.
 * - **Timestamps** — a timestamp column's value, and a second-precision ISO
 *   string inside a JSON value — become their dense rank among every
 *   timestamp in the dump (`<t:3>`); `null` stays `null`. Two writes in one
 *   transaction share a rank, a later write ranks after, and a backend
 *   setting a column the other leaves `null` differs.
 * - **`seq`** becomes the offset from the dump's smallest, and the dump
 *   carries `audit_seq_advance`: how far the audit sequence moved between
 *   `mark` and the read, so an audit insert that rolled back — no row left,
 *   a sequence value spent — differs too.
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
import type { Db } from '../../db/db.ts';
import { DAEMON_TOKEN_HEADER } from '../../auth/daemon_token.ts';
import { create_fetch_transport } from '../transports/fetch_transport.ts';
import { cross_drain_effects } from './audit_cross_helpers.ts';
import { diff_differential_values, type DifferentialDiff } from './differential_normalize.ts';
import {
	GENERATED_USERNAME_PATTERN,
	type ReconstructedBootstrappedBackendHandle
} from './setup.ts';

/** The tables a dump reads, in the order the canonical walk numbers their ids. */
export const DB_STATE_TABLES: ReadonlyArray<string> = ['audit_log'];

/** Per table, the column its rows sort by, ahead of the generic row key. */
const TABLE_SORT_COLUMN: Readonly<Record<string, string>> = { audit_log: 'seq' };

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

const visit_strings = (value: unknown, on_string: (s: string) => void): void => {
	if (typeof value === 'string') on_string(value);
	else if (Array.isArray(value)) for (const v of value) visit_strings(v, on_string);
	else if (is_record(value)) {
		for (const [k, v] of Object.entries(value)) {
			on_string(k);
			visit_strings(v, on_string);
		}
	}
};

const compare_text = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

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
	for (const table of DB_STATE_TABLES) {
		const columns = raw.columns[table] ?? {};
		for (const row of raw.rows[table] ?? []) {
			for (const [column, value] of Object.entries(row)) {
				if (TIMESTAMP_UDTS.has(columns[column] ?? '') && typeof value === 'string') {
					add_instant(value);
				} else if (typeof value !== 'string') {
					visit_strings(value, (s) => {
						for (const m of s.matchAll(WIRE_TIMESTAMP_PATTERN)) add_instant(m[0]);
					});
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
			.replace(GENERATED_USERNAME_PATTERN, (m) => placeholder('username', m, assign))
			.replace(WIRE_TIMESTAMP_PATTERN, rank_of)
			.replace(/(?<!\w|blake3:)[0-9a-f]{64}(?!\w)/g, '<hash>');
	const normalize_json = (value: unknown, assign: boolean): unknown => {
		if (typeof value === 'string') return normalize_string(value, assign);
		if (Array.isArray(value)) return value.map((v) => normalize_json(v, assign));
		if (is_record(value)) {
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(value).sort(compare_text)) {
				out[normalize_string(key, assign)] = normalize_json(value[key], assign);
			}
			return out;
		}
		return value;
	};

	const tables: Record<string, Array<Record<string, unknown>>> = {};
	for (const table of DB_STATE_TABLES) {
		const columns = raw.columns[table] ?? {};
		const rows = raw.rows[table] ?? [];
		const seqs = rows.map((r) => r.seq).filter((s): s is number => typeof s === 'number');
		const seq_min = seqs.length > 0 ? Math.min(...seqs) : 0;
		const normalize_row = (
			row: Record<string, unknown>,
			assign: boolean
		): Record<string, unknown> => {
			const out: Record<string, unknown> = {};
			for (const column of Object.keys(row).sort(compare_text)) {
				const value = row[column];
				if (value === null) out[column] = null;
				else if (TIMESTAMP_UDTS.has(columns[column] ?? '') && typeof value === 'string') {
					out[column] = rank_of(value);
				} else if (column === 'seq' && typeof value === 'number') {
					out[column] = value - seq_min;
				} else out[column] = normalize_json(value, assign);
			}
			return out;
		};
		// the sort key: the sort column, then the row with no id numbered yet;
		// a tie falls back to the raw row, which differs per backend
		const sort_column = TABLE_SORT_COLUMN[table];
		const keyed = rows.map((row) => ({
			row,
			first: sort_column === undefined ? 0 : Number(row[sort_column]),
			key: JSON.stringify(normalize_row(row, false)),
			tie: JSON.stringify(row)
		}));
		keyed.sort(
			(x, y) => x.first - y.first || compare_text(x.key, y.key) || compare_text(x.tie, y.tie)
		);
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
 * read drains the backend's in-flight audit writes first
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
				const found: Record<string, Record<string, string>> = {};
				const column_rows = await db.query<{
					table_name: string;
					column_name: string;
					udt_name: string;
				}>(
					`SELECT table_name, column_name, udt_name FROM information_schema.columns
					 WHERE table_schema = 'public' AND table_name = ANY($1)`,
					[DB_STATE_TABLES]
				);
				for (const r of column_rows) (found[r.table_name] ??= {})[r.column_name] = r.udt_name;
				columns = found;
			}
			const rows: Record<string, Array<Record<string, unknown>>> = {};
			for (const table of DB_STATE_TABLES) {
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
