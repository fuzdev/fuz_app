/**
 * The leaf schemas — `WireIssue`, `HealthResponse`, the `/ready` and
 * `/api/server/status` bodies, `GET /api/surface`'s output, the routes'
 * `literal(null)` slots, `XAccelConfig`, `FileFactUrl`, `DaemonToken`, the
 * origin refusal kinds, and the `_testing_origin_check` and conformance-table
 * schemas that hold them — over their valid samples and the cases that pin
 * their declared choices: `/api/server/status`'s `uptime_ms` is a non-negative
 * integer, and `/ready`'s 503 is its two definitions (`REST_SCHEMA_DRIFT`,
 * `REST_DB_UNREACHABLE`), loose objects that keep a key beside the code.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { format_issue, is_schema, parse, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import { WireIssue } from '#lib/schema_issues.ts';
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
import {
	ERROR_DB_UNREACHABLE,
	ERROR_SCHEMA_DRIFT,
	to_error_schemas
} from '#lib/http/error_schemas.ts';
import { generate_app_surface } from '#lib/http/surface.ts';

/** The origin pattern refusal kinds, in their order: a shared contract with the Rust spine. */
const ORIGIN_PATTERN_KINDS = [
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
];

const DAEMON_TOKEN = generate_daemon_token();
const FILE_URL = `file:ab/${'c'.repeat(62)}`;
const WIRE_ISSUE = {
	kind: 'string',
	path: ['a', 0],
	expected: 'string',
	received: 'number',
	message: 'a.0: expected string'
};

const ready_spec = create_ready_route_spec({ expected: { schema_version: ['name'] } });
const status_spec = create_server_status_route_spec({ version: '0', get_uptime_ms: () => 0 });
const surface_spec = create_surface_route_spec({
	surface: generate_app_surface({ route_specs: [], middleware_specs: [] })
});
const audit_shape = create_audit_log_route_shape();

/** A route slot, typed `AnySchema`, as the fuz_schema schema it must be. */
const fuz_slot = (schema: AnySchema | undefined): AnySchema => {
	if (!is_schema(schema)) throw new Error('a route slot is no fuz_schema schema');
	return schema;
};

const ready_503 = to_error_schemas(ready_spec.errors ?? [])[503]!;
const status_output = fuz_slot(status_spec.output);

/** The first issue of a failed parse, with its message. */
const first_issue = (schema: AnySchema, input: unknown) => {
	const result = parse(schema, input);
	assert.ok(!result.ok);
	const { kind, path, expected, received } = result.issues[0]!;
	return { kind, path, expected, received, message: format_issue(result.issues[0]!) };
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

const SAMPLES: Array<[name: string, schema: AnySchema, samples: ReadonlyArray<unknown>]> = [
	...NULL_SLOTS.map(([name, schema]): [string, AnySchema, ReadonlyArray<unknown>] => [
		name,
		schema,
		[null]
	]),
	['OriginPatternErrorKind', OriginPatternErrorKind, ORIGIN_PATTERN_KINDS],
	['AllowedOriginsErrorKind', AllowedOriginsErrorKind, ['no_origins', ...ORIGIN_PATTERN_KINDS]],
	['WireIssue', WireIssue, [WIRE_ISSUE, { ...WIRE_ISSUE, path: [] }]],
	['HealthResponse', HealthResponse, [{ status: 'ok' }]],
	['/ready output', fuz_slot(ready_spec.output), [{ ready: true }]],
	['/ready 503', ready_503, [{ error: ERROR_SCHEMA_DRIFT }, { error: ERROR_DB_UNREACHABLE }]],
	[
		'/api/server/status output',
		status_output,
		[
			{ version: '1.2.3', uptime_ms: 5000 },
			{ version: '', uptime_ms: 0 }
		]
	],
	[
		'/api/surface output',
		fuz_slot(surface_spec.output),
		[{ routes: [{ path: '/x' }], middleware: [{}] }]
	],
	['XAccelConfig', XAccelConfig, [{ redirect_prefix: '/_facts/' }]],
	['FileFactUrl', FileFactUrl, [FILE_URL]],
	['DaemonToken', DaemonToken, [DAEMON_TOKEN]],
	[
		'TestingOriginCheckInput',
		TestingOriginCheckInput,
		[
			{ patterns: 'http://localhost:*', origin: null },
			{ patterns: '', origin: 'http://x' }
		]
	],
	[
		'TestingOriginCheckOutput',
		TestingOriginCheckOutput,
		[
			{ ok: true, allowed: false },
			{ ok: false, errors: [{ index: 1, kind: 'empty_entry' }, { kind: 'no_origins' }] },
			{ ok: false, errors: [] }
		]
	],
	[
		'OriginConformanceError',
		OriginConformanceError,
		[{ index: 3, kind: 'has_path' }, { kind: 'no_origins' }]
	],
	[
		'OriginConformanceParseRow',
		OriginConformanceParseRow,
		[
			{ raw: 'http://a', ok: true, note: 'n' },
			{ raw: ' ', errors: [{ index: 1, kind: 'empty_entry' }] }
		]
	],
	[
		'OriginConformanceMatchRow',
		OriginConformanceMatchRow,
		[{ patterns: 'http://a', origin: null, allowed: true, note: 'n' }]
	],
	[
		'OriginConformance',
		OriginConformance,
		[
			{
				parse: [{ raw: 'http://a', ok: true }],
				match: [{ patterns: 'http://a', origin: 'http://a', allowed: true }]
			}
		]
	]
];

describe('leaf schemas', () => {
	test('every valid sample parses', () => {
		for (const [name, schema, samples] of SAMPLES) {
			for (const sample of samples) {
				assert.ok(parse(schema, sample).ok, `${name} ${JSON.stringify(sample)}`);
			}
		}
	});
});

describe('the null slots', () => {
	test('each is a null schema, which the surface writes as no schema', () => {
		for (const [name, schema] of NULL_SLOTS) assert.ok(is_null_schema(schema), name);
	});
});

describe('the declared differences', () => {
	test("/ready's 503 keeps a key beside its code, and refuses another code", () => {
		const cases: Array<[input: unknown, ok: boolean]> = [
			[{ error: ERROR_SCHEMA_DRIFT, detail: 'x' }, true],
			[{ error: ERROR_DB_UNREACHABLE, detail: 'x' }, true],
			[{ error: 'other', detail: 'x' }, false],
			[{ detail: 'x' }, false]
		];
		for (const [input, ok] of cases) {
			const result = parse(ready_503, input);
			assert.strictEqual(result.ok, ok, JSON.stringify(input));
			// a loose object answers the input itself, the extra key kept
			if (result.ok) assert.strictEqual(result.value, input);
		}
		assert.deepStrictEqual(first_issue(ready_503, { error: 'other', detail: 'x' }), {
			kind: 'union',
			path: [],
			expected: 'object',
			received: 'object',
			message: 'expected object, received object'
		});
	});

	test("/api/server/status's uptime_ms is a non-negative integer", () => {
		const cases: Array<[uptime_ms: number, ok: boolean]> = [
			[0, true],
			[5000, true],
			[1.5, false],
			[0.1, false],
			[-1, false]
		];
		for (const [uptime_ms, ok] of cases) {
			assert.strictEqual(
				parse(status_output, { version: '1', uptime_ms }).ok,
				ok,
				String(uptime_ms)
			);
		}
		assert.deepStrictEqual(first_issue(status_output, { version: '1', uptime_ms: 1.5 }), {
			kind: 'integer',
			path: ['uptime_ms'],
			expected: 'integer',
			received: 'number',
			message: 'uptime_ms: expected integer, received number'
		});
		assert.deepStrictEqual(first_issue(status_output, { version: '1', uptime_ms: -1 }), {
			kind: 'min_value',
			path: ['uptime_ms'],
			expected: '>= 0',
			received: 'number',
			message: 'uptime_ms: expected >= 0, received number'
		});
	});
});

describe('the origin refusal kinds', () => {
	test('the names are pinned, in their order', () => {
		assert.deepStrictEqual([...OriginPatternErrorKind.def], ORIGIN_PATTERN_KINDS);
		assert.deepStrictEqual(
			[...AllowedOriginsErrorKind.def],
			['no_origins', ...ORIGIN_PATTERN_KINDS]
		);
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
