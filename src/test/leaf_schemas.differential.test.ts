/**
 * The leaf schemas — `WireIssue`, `HealthResponse`, the `/ready` and
 * `/api/server/status` bodies, `GET /api/surface`'s output, the routes'
 * `literal(null)` slots, `XAccelConfig`,
 * `FileFactUrl`, `DaemonToken`, the origin refusal kinds, and the
 * `_testing_origin_check` and conformance-table schemas that hold them — held
 * to Zod copies of the schemas they were, kept here. Over each schema's valid
 * samples and every variant of them one edit away (a node replaced by a value
 * of the pool, a key dropped, a key added), the verdict and the output are
 * Zod's. The one declared difference: `/api/server/status`'s `uptime_ms` is a
 * non-negative integer, where Zod took any number. An input holding a `Date`,
 * which a loose object keeps where Zod copies it into a plain object, is held
 * to Zod's verdict alone: no JSON body holds one.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { is, is_schema, parse, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import { parse_any, WireIssue, type ValidationSchema } from '#lib/schema_issues.ts';
import { HealthResponse } from '#lib/http/health_schema.ts';
import {
	create_health_route_spec,
	create_ready_route_spec,
	create_server_status_route_spec
} from '#lib/http/common_routes.ts';
import { create_audit_log_route_shape } from '#lib/auth/audit_log_route_schema.ts';
import { is_null_schema } from '#lib/http/schema_helpers.ts';
import { create_surface_route_spec } from '#lib/server/surface_route.ts';
import { XAccelConfig } from '#lib/server/x_accel.ts';
import { FileFactUrl } from '#lib/db/file_fact_url.ts';
import { DaemonToken, generate_daemon_token } from '#lib/auth/daemon_token.ts';
import {
	ALLOWED_ORIGINS_ERROR_MESSAGES,
	AllowedOriginsErrorKind,
	OriginPatternErrorKind
} from '#lib/http/origin.ts';
import {
	TestingOriginCheckInput,
	TestingOriginCheckOutput
} from '#lib/testing/cross_backend/testing_origin_check.ts';
import {
	OriginConformance,
	OriginConformanceError,
	OriginConformanceMatchRow,
	OriginConformanceParseRow
} from '#lib/testing/cross_backend/origin_conformance.ts';
import { READY_ERROR } from '#lib/db/schema_ready.ts';
import { generate_app_surface } from '#lib/http/surface.ts';

// --- the Zod copies, as the library wrote them ---

const ZOD_ORIGIN_PATTERN_KINDS = [
	'empty_entry',
	'not_printable_ascii',
	'missing_scheme',
	'unsupported_scheme',
	'has_path',
	'has_userinfo',
	'missing_host',
	'invalid_host_char',
	'unbracketed_ipv6',
	'partial_wildcard',
	'non_canonical_ipv4',
	'unclosed_ipv6',
	'invalid_ipv6',
	'invalid_after_ipv6',
	'invalid_port',
	'default_port'
] as const;
const ZodOriginPatternErrorKind = z.enum(ZOD_ORIGIN_PATTERN_KINDS);
const ZodAllowedOriginsErrorKind = z.enum(['no_origins', ...ZodOriginPatternErrorKind.options]);

const ZodWireIssue = z.looseObject({
	kind: z.string(),
	path: z.array(z.union([z.string(), z.number()])),
	expected: z.string(),
	received: z.string(),
	message: z.string()
});
const ZodHealthResponse = z.strictObject({ status: z.literal('ok') });
const ZodReadyOutput = z.strictObject({ ready: z.literal(true) });
const ZodReady503 = z.strictObject({
	error: z.enum([READY_ERROR.schema_drift, READY_ERROR.db_unreachable])
});
const ZodServerStatusOutput = z.looseObject({ version: z.string(), uptime_ms: z.number() });
const ZodSurfaceOutput = z.looseObject({
	routes: z.array(z.looseObject({})),
	middleware: z.array(z.looseObject({}))
});
const ZodXAccelConfig = z.strictObject({ redirect_prefix: z.string() }).brand('XAccelConfig');
const ZodFileFactUrl = z
	.string()
	.regex(/^file:([0-9a-f]{2})\/([0-9a-f]{62})$/)
	.brand('FileFactUrl');
const ZodDaemonToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid daemon token format');
const ZodTestingOriginCheckInput = z.strictObject({
	patterns: z.string(),
	origin: z.string().nullable()
});
const ZodOriginErrorEntry = z.strictObject({
	index: z.number().int().min(1).optional(),
	kind: ZodAllowedOriginsErrorKind
});
const ZodTestingOriginCheckOutput = z.union([
	z.strictObject({ ok: z.literal(true), allowed: z.boolean() }),
	z.strictObject({ ok: z.literal(false), errors: z.array(ZodOriginErrorEntry) })
]);
const ZodOriginConformanceParseRow = z.union([
	z.strictObject({ raw: z.string(), ok: z.literal(true), note: z.string().optional() }),
	z.strictObject({
		raw: z.string(),
		errors: z.array(ZodOriginErrorEntry).min(1),
		note: z.string().optional()
	})
]);
const ZodOriginConformanceMatchRow = z.strictObject({
	patterns: z.string(),
	origin: z.string().nullable(),
	allowed: z.boolean(),
	note: z.string().optional()
});
const ZodOriginConformance = z.strictObject({
	parse: z.array(ZodOriginConformanceParseRow).min(1),
	match: z.array(ZodOriginConformanceMatchRow).min(1)
});

// --- the inputs ---

const BASE_POOL: ReadonlyArray<unknown> = [
	undefined,
	null,
	true,
	false,
	0,
	-0,
	1,
	-1,
	2,
	1.5,
	Number.MAX_SAFE_INTEGER,
	2 ** 53,
	2 ** 60,
	NaN,
	Infinity,
	-Infinity,
	'',
	'ok',
	'a',
	'0',
	[],
	['a'],
	[1],
	[{}],
	{},
	{ a: 1 },
	() => 0,
	1n,
	new Date(0)
];

const clone = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(clone)
		: value !== null && typeof value === 'object' && !(value instanceof Date)
			? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]))
			: value;

/**
 * Every variant of `sample` one edit away: each node replaced by each value of
 * `pool`, each key of an object dropped, a key added to each object, and an
 * element added to each array.
 */
const variants_of = (sample: unknown, pool: ReadonlyArray<unknown>): Array<unknown> => {
	const out: Array<unknown> = [...pool];
	const container = sample !== null && typeof sample === 'object';
	if (!container) return out;
	if (Array.isArray(sample)) {
		for (const v of pool) out.push([...sample.map(clone), clone(v)]);
		sample.forEach((child, i) => {
			for (const v of variants_of(child, pool)) {
				const next = sample.map(clone);
				next[i] = v;
				out.push(next);
			}
		});
		return out;
	}
	const entries = Object.entries(sample);
	out.push({ ...(clone(sample) as object), extra: 1 });
	for (const [key, child] of entries) {
		const { [key]: _, ...dropped } = clone(sample) as Record<string, unknown>;
		out.push(dropped);
		for (const v of variants_of(child, pool)) {
			out.push({ ...(clone(sample) as object), [key]: v });
		}
	}
	return out;
};

// `JSON.stringify` gives `undefined` for `undefined` and a function, whatever its type says
const show = (value: unknown): string => {
	const text: string | undefined = JSON.stringify(value, (_, v) =>
		typeof v === 'bigint' || typeof v === 'function' || typeof v === 'number' ? String(v) : v
	);
	return text ?? String(value);
};

const holds_date = (value: unknown): boolean =>
	value instanceof Date ||
	(value !== null && typeof value === 'object' && Object.values(value).some(holds_date));

interface Row {
	name: string;
	fuz: AnySchema;
	zod: z.ZodType;
	samples: ReadonlyArray<unknown>;
	pool?: ReadonlyArray<unknown>;
	/** The declared difference: what the fuz form gives where the Zod one says `zod_ok`. */
	declared?: (input: unknown, zod_ok: boolean) => boolean;
}

const ORIGIN_KIND_POOL: ReadonlyArray<unknown> = [
	...ZOD_ORIGIN_PATTERN_KINDS,
	'no_origins',
	'EMPTY_ENTRY',
	' empty_entry',
	'empty_entry ',
	'default_port\n',
	'no_origin'
];

const DAEMON_TOKEN = generate_daemon_token();
const ascii = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i));
const DAEMON_TOKEN_POOL: ReadonlyArray<unknown> = [
	DAEMON_TOKEN,
	'a'.repeat(42),
	'a'.repeat(43),
	'a'.repeat(44),
	`${DAEMON_TOKEN}\n`,
	`\n${DAEMON_TOKEN}`,
	`${DAEMON_TOKEN.slice(0, 42)}é`,
	`${DAEMON_TOKEN.slice(0, 42)}\u{1F600}`,
	...ascii.map((c) => c + DAEMON_TOKEN.slice(1)),
	...ascii.map((c) => DAEMON_TOKEN.slice(0, 42) + c)
];

const SHARD = 'ab';
const REST = 'c'.repeat(62);
const FILE_URL = `file:${SHARD}/${REST}`;
const FILE_FACT_URL_POOL: ReadonlyArray<unknown> = [
	FILE_URL,
	`${FILE_URL}\n`,
	`file:${SHARD}/${REST}0`,
	`file:${SHARD}/${REST.slice(1)}`,
	`file:AB/${REST}`,
	`file:${SHARD}${REST}`,
	`file:../${REST}`,
	`x${FILE_URL}`,
	...'0123456789abcdefgABF/:.'.split('').map((c) => `file:${SHARD}/${c}${REST.slice(1)}`)
];

const WIRE_ISSUE = {
	kind: 'string',
	path: ['a', 0],
	expected: 'string',
	received: 'number',
	message: 'a.0: expected string'
};

const ORIGIN_ERRORS = {
	ok: false,
	errors: [{ index: 1, kind: 'empty_entry' }, { kind: 'no_origins' }]
};

const ready_spec = create_ready_route_spec({ expected: { schema_version: ['name'] } });
const status_spec = create_server_status_route_spec({ version: '0', get_uptime_ms: () => 0 });
const surface_spec = create_surface_route_spec({
	surface: generate_app_surface({ route_specs: [], middleware_specs: [] })
});

const audit_shape = create_audit_log_route_shape();

/** A route slot, typed `ValidationSchema`, as the fuz_schema schema it must be. */
const fuz_slot = (schema: ValidationSchema | undefined): AnySchema => {
	if (!is_schema(schema)) throw new Error('a route slot is no fuz_schema schema');
	return schema;
};

// every `literal(null)` slot, a route with no body or no JSON response
const NULL_SLOTS: Array<[name: string, schema: AnySchema]> = [
	['/health input', fuz_slot(create_health_route_spec().input)],
	['/ready input', fuz_slot(ready_spec.input)],
	['/api/server/status input', fuz_slot(status_spec.input)],
	['/api/surface input', fuz_slot(surface_spec.input)],
	['/audit/stream input', fuz_slot(audit_shape.input)],
	['/audit/stream output', fuz_slot(audit_shape.output)]
];

const ROWS: Array<Row> = [
	...NULL_SLOTS.map(([name, fuz]): Row => ({ name, fuz, zod: z.null(), samples: [null] })),
	{
		name: 'OriginPatternErrorKind',
		fuz: OriginPatternErrorKind,
		zod: ZodOriginPatternErrorKind,
		samples: ZOD_ORIGIN_PATTERN_KINDS,
		pool: ORIGIN_KIND_POOL
	},
	{
		name: 'AllowedOriginsErrorKind',
		fuz: AllowedOriginsErrorKind,
		zod: ZodAllowedOriginsErrorKind,
		samples: ['no_origins'],
		pool: ORIGIN_KIND_POOL
	},
	{
		name: 'WireIssue',
		fuz: WireIssue,
		zod: ZodWireIssue,
		samples: [WIRE_ISSUE, { ...WIRE_ISSUE, path: [] }]
	},
	{
		name: 'HealthResponse',
		fuz: HealthResponse,
		zod: ZodHealthResponse,
		samples: [{ status: 'ok' }]
	},
	{
		name: '/ready output',
		fuz: fuz_slot(ready_spec.output),
		zod: ZodReadyOutput,
		samples: [{ ready: true }]
	},
	{
		name: '/ready 503',
		fuz: fuz_slot(ready_spec.errors?.[503]),
		zod: ZodReady503,
		samples: [{ error: READY_ERROR.schema_drift }, { error: READY_ERROR.db_unreachable }],
		pool: [READY_ERROR.schema_drift, READY_ERROR.db_unreachable, 'schema_drift ']
	},
	{
		name: '/api/server/status output',
		fuz: fuz_slot(status_spec.output),
		zod: ZodServerStatusOutput,
		samples: [
			{ version: '1.2.3', uptime_ms: 5000 },
			{ version: '', uptime_ms: 0 }
		],
		declared: (input, zod_ok) => {
			const uptime = (input as { uptime_ms: number } | null)?.uptime_ms;
			return zod_ok && Number.isInteger(uptime) && uptime! >= 0;
		}
	},
	{
		name: '/api/surface output',
		fuz: fuz_slot(surface_spec.output),
		zod: ZodSurfaceOutput,
		samples: [{ routes: [{ path: '/x' }], middleware: [{}] }]
	},
	{
		name: 'XAccelConfig',
		fuz: XAccelConfig,
		zod: ZodXAccelConfig,
		samples: [{ redirect_prefix: '/_facts/' }]
	},
	{
		name: 'FileFactUrl',
		fuz: FileFactUrl,
		zod: ZodFileFactUrl,
		samples: [FILE_URL],
		pool: FILE_FACT_URL_POOL
	},
	{
		name: 'DaemonToken',
		fuz: DaemonToken,
		zod: ZodDaemonToken,
		samples: [DAEMON_TOKEN],
		pool: DAEMON_TOKEN_POOL
	},
	{
		name: 'TestingOriginCheckInput',
		fuz: TestingOriginCheckInput,
		zod: ZodTestingOriginCheckInput,
		samples: [
			{ patterns: 'http://localhost:*', origin: null },
			{ patterns: '', origin: 'http://x' }
		]
	},
	{
		name: 'TestingOriginCheckOutput',
		fuz: TestingOriginCheckOutput,
		zod: ZodTestingOriginCheckOutput,
		samples: [{ ok: true, allowed: false }, ORIGIN_ERRORS, { ok: false, errors: [] }],
		pool: ORIGIN_KIND_POOL
	},
	{
		name: 'OriginConformanceError',
		fuz: OriginConformanceError,
		zod: ZodOriginErrorEntry,
		samples: [{ index: 3, kind: 'has_path' }, { kind: 'no_origins' }],
		pool: ORIGIN_KIND_POOL
	},
	{
		name: 'OriginConformanceParseRow',
		fuz: OriginConformanceParseRow,
		zod: ZodOriginConformanceParseRow,
		samples: [
			{ raw: 'http://a', ok: true, note: 'n' },
			{ raw: ' ', errors: [{ index: 1, kind: 'empty_entry' }] }
		],
		pool: ORIGIN_KIND_POOL
	},
	{
		name: 'OriginConformanceMatchRow',
		fuz: OriginConformanceMatchRow,
		zod: ZodOriginConformanceMatchRow,
		samples: [{ patterns: 'http://a', origin: null, allowed: true, note: 'n' }]
	},
	{
		name: 'OriginConformance',
		fuz: OriginConformance,
		zod: ZodOriginConformance,
		samples: [
			{
				parse: [{ raw: 'http://a', ok: true }],
				match: [{ patterns: 'http://a', origin: 'http://a', allowed: true }]
			}
		]
	}
];

describe('leaf schemas against their Zod copies', () => {
	for (const row of ROWS) {
		test(`${row.name}: every variant gets Zod's verdict and output`, () => {
			const pool = [...BASE_POOL, ...(row.pool ?? [])];
			const inputs = [...row.samples, ...row.samples.flatMap((s) => variants_of(s, pool))];
			let accepted = 0;
			let refused = 0;
			for (const input of inputs) {
				const label = `${row.name} ${show(input)}`;
				const zod_result = row.zod.safeParse(input);
				const fuz_result = parse_any(row.fuz, input);
				const expected_ok = row.declared
					? row.declared(input, zod_result.success)
					: zod_result.success;
				assert.strictEqual(fuz_result.ok, expected_ok, label);
				assert.strictEqual(is(row.fuz, input), expected_ok, `${label} (is)`);
				if (fuz_result.ok) {
					accepted++;
					// a loose object given a `Date` keeps it, where Zod copies it into a
					// plain object: no JSON body holds one, so the verdict alone
					if (!holds_date(input)) {
						assert.deepStrictEqual(fuz_result.value, zod_result.data, label);
					}
				} else {
					refused++;
				}
			}
			// both verdicts reached, so a variant set that collapses to one fails
			assert.ok(accepted >= row.samples.length, `${row.name}: accepted ${accepted}`);
			assert.ok(refused > 0, `${row.name}: refused none`);
		});
	}

	test('every valid sample parses', () => {
		for (const row of ROWS) {
			for (const sample of row.samples) {
				assert.ok(parse_any(row.fuz, sample).ok, `${row.name} ${show(sample)}`);
			}
		}
	});
});

describe('the null slots', () => {
	test('each is a null schema, which the surface writes as no schema', () => {
		for (const [name, schema] of NULL_SLOTS) assert.ok(is_null_schema(schema), name);
	});
});

describe('the declared difference', () => {
	test("/api/server/status's uptime_ms refuses a fraction and a negative Zod took", () => {
		for (const uptime_ms of [1.5, -1, 0.1]) {
			const input = { version: '1', uptime_ms };
			assert.ok(ZodServerStatusOutput.safeParse(input).success);
			assert.ok(!parse_any(status_spec.output, input).ok, String(uptime_ms));
		}
		assert.ok(parse_any(status_spec.output, { version: '1', uptime_ms: 0 }).ok);
	});
});

describe('the origin refusal kinds', () => {
	test("the names are the Zod enum's, in its order", () => {
		assert.deepStrictEqual([...OriginPatternErrorKind.def], ZodOriginPatternErrorKind.options);
		assert.deepStrictEqual([...AllowedOriginsErrorKind.def], ZodAllowedOriginsErrorKind.options);
	});

	test('every kind has a message, and no message names a kind that is not one', () => {
		assert.deepStrictEqual(
			Object.keys(ALLOWED_ORIGINS_ERROR_MESSAGES).sort(),
			[...AllowedOriginsErrorKind.def].sort()
		);
	});
});

describe('the parsed values', () => {
	test('a parsed XAccelConfig carries the prefix', () => {
		const result = parse(XAccelConfig, { redirect_prefix: '/_facts/' });
		assert.ok(result.ok);
		assert.strictEqual(result.value.redirect_prefix, '/_facts/');
	});
});
