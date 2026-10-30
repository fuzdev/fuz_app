/**
 * Conformance cases for the cell verbs — live-mounted on the spine RPC path
 * and kept off the declared surface, so the table resolves them through
 * `live_rpc_endpoints`.
 *
 * These are the cell refusals a single request reaches with no cell in place:
 *
 * - **shape refusals with a reason** — `kind` inside `data` on create
 *   (`cell_kind_in_data`), `cell_get` naming neither `id` nor `path`
 *   (`cell_get_requires_id_or_path`), and `cell_field_list` /
 *   `cell_item_list` naming neither or both of their endpoints (the
 *   `*_requires_*` reasons). Each is `invalid_params` (400) carrying the reason
 *   the spec module declares for it.
 * - **grant miss** — revoking a grant id that names no grant is 404
 *   `cell_grant_not_found`, for an admin and a non-admin alike.
 * - **`cell_list` pagination bounds** — `limit` below 1, past
 *   `CELL_LIST_LIMIT_MAX`, or non-integer, and an `offset` negative or past
 *   `Number.MAX_SAFE_INTEGER`, are `invalid_params` (400); `limit` at the max
 *   is admitted. The refusal pins `status` only, like the admin lists' bounds
 *   rows.
 * - **schema refusals come first** — a bad page refuses ahead of the
 *   handler's reasoned checks: anonymous `cell_list` naming `created_by` with
 *   `limit: 0`, and a relation list with a bad endpoint pair and `limit: 0`,
 *   are the reason-less 400 the schema step answers, not the handler's reason
 *   (pinned across spines by the differential); so is anonymous `cell_list`
 *   naming a `shared_with` other than `'me'`, and an `order_by` /
 *   `order_direction` outside its enum is refused rather than defaulted.
 *
 * - **prototype keys** — an own `__proto__` key in cell `data`, `policy`, or a
 *   clone patch, at any depth, or at the top of `cell_list`'s params, is the
 *   dispatcher's `params_proto_key` refusal (400), ahead of every schema.
 *
 * Refusals that need a cell in place — a taken item position, moderating a
 * non-contribution, the IDOR masks — stay in the imperative cell suites.
 *
 * Each `note` cites the spec module that states its property.
 *
 * @module
 */

import {
	CELL_LIST_LIMIT_MAX,
	ERROR_CELL_GET_REQUIRES_ID_OR_PATH,
	ERROR_CELL_KIND_IN_DATA
} from '#lib/auth/cell_action_specs.ts';
import { ERROR_CELL_FIELD_LIST_REQUIRES_SOURCE_OR_TARGET } from '#lib/auth/cell_field_action_specs.ts';
import { ERROR_CELL_GRANT_NOT_FOUND } from '#lib/auth/cell_grant_action_specs.ts';
import { ERROR_CELL_ITEM_LIST_REQUIRES_PARENT_OR_CHILD } from '#lib/auth/cell_item_action_specs.ts';
import { ERROR_PARAMS_PROTO_KEY } from '#lib/http/error_schemas.ts';
import type { ConformanceCase } from '#lib/testing/cross_backend/conformance_case.ts';

/** A well-formed UUID that names no cell or grant. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const shape_cases: Array<ConformanceCase> = [
	{
		name: 'fresh non-admin → cell_create with kind inside data → 400 cell_kind_in_data',
		request: {
			method: 'cell_create',
			as: 'fresh_non_admin',
			params: { kind: 'note', data: { kind: 'note' } }
		},
		expect: { status: 400, error_reason: ERROR_CELL_KIND_IN_DATA },
		note: 'auth/cell_action_specs.ts `ERROR_CELL_KIND_IN_DATA` — `kind` is the top-level column, never a `data` key'
	},
	{
		name: 'keeper → cell_get with neither id nor path → 400 cell_get_requires_id_or_path',
		request: { method: 'cell_get', as: 'keeper', params: {} },
		expect: { status: 400, error_reason: ERROR_CELL_GET_REQUIRES_ID_OR_PATH },
		note: 'auth/cell_action_specs.ts `ERROR_CELL_GET_REQUIRES_ID_OR_PATH`'
	},
	...(
		[
			['neither', {}],
			['both', { source_id: NIL_UUID, target_id: NIL_UUID }]
		] as const
	).map(([label, params]): ConformanceCase => ({
		name: `keeper → cell_field_list naming ${label} endpoint → 400 cell_field_list_requires_source_or_target`,
		request: { method: 'cell_field_list', as: 'keeper', params },
		expect: { status: 400, error_reason: ERROR_CELL_FIELD_LIST_REQUIRES_SOURCE_OR_TARGET },
		note: 'auth/cell_field_action_specs.ts — exactly one of `source_id` / `target_id`'
	})),
	...(
		[
			['neither', {}],
			['both', { parent_id: NIL_UUID, child_id: NIL_UUID }]
		] as const
	).map(([label, params]): ConformanceCase => ({
		name: `keeper → cell_item_list naming ${label} endpoint → 400 cell_item_list_requires_parent_or_child`,
		request: { method: 'cell_item_list', as: 'keeper', params },
		expect: { status: 400, error_reason: ERROR_CELL_ITEM_LIST_REQUIRES_PARENT_OR_CHILD },
		note: 'auth/cell_item_action_specs.ts — exactly one of `parent_id` / `child_id`'
	}))
];

const grant_cases: Array<ConformanceCase> = (['keeper', 'fresh_non_admin'] as const).map(
	(as): ConformanceCase => ({
		name: `${as === 'keeper' ? 'admin' : 'fresh non-admin'} → cell_grant_revoke {grant_id: NIL} → 404 cell_grant_not_found`,
		request: { method: 'cell_grant_revoke', as, params: { grant_id: NIL_UUID } },
		expect: { status: 404, error_reason: ERROR_CELL_GRANT_NOT_FOUND },
		note: 'auth/cell_grant_action_specs.ts `ERROR_CELL_GRANT_NOT_FOUND` — a grant miss'
	})
);

const pagination_note =
	'auth/cell_action_specs.ts `CellListInput` — `limit` is bounded to [1, `CELL_LIST_LIMIT_MAX`] and `offset` to >= 0, so an out-of-range page is refused, not clamped';

const refused_page = (label: string, params: Record<string, unknown>): ConformanceCase => ({
	name: `keeper → cell_list ${label} → 400`,
	request: { method: 'cell_list', as: 'keeper', params },
	expect: { status: 400 },
	note: pagination_note
});

const pagination_cases: Array<ConformanceCase> = [
	refused_page('{limit: 0}', { limit: 0 }),
	refused_page('{limit: max + 1}', { limit: CELL_LIST_LIMIT_MAX + 1 }),
	refused_page('{limit: 1.5}', { limit: 1.5 }),
	refused_page('{offset: -1}', { offset: -1 }),
	refused_page('{offset: 1e16}', { offset: 1e16 }),
	{
		name: 'keeper → cell_list {limit: max} → 200',
		request: { method: 'cell_list', as: 'keeper', params: { limit: CELL_LIST_LIMIT_MAX } },
		expect: { status: 200 },
		note: `${pagination_note}; the max itself is a valid page`
	}
];

const schema_first_note =
	'the TS schema refuses a bad page before the handler runs, so the handler’s reason never answers';

const schema_first_cases: Array<ConformanceCase> = [
	{
		name: 'anonymous → cell_list {created_by: NIL, limit: 0} → 400',
		request: { method: 'cell_list', as: 'anonymous', params: { created_by: NIL_UUID, limit: 0 } },
		expect: { status: 400 },
		note: `${pagination_note}; ${schema_first_note} (not cell_list_created_by_requires_auth)`
	},
	{
		name: "anonymous → cell_list {shared_with: 'bogus'} → 400",
		request: { method: 'cell_list', as: 'anonymous', params: { shared_with: 'bogus' } },
		expect: { status: 400 },
		note: `auth/cell_action_specs.ts \`CellListInput\` — \`shared_with\` is \`z.literal('me')\`; ${schema_first_note} (not cell_list_shared_with_requires_auth)`
	},
	...(['order_by', 'order_direction'] as const).map((key): ConformanceCase => ({
		name: `keeper → cell_list {${key}: 'bogus'} → 400`,
		request: { method: 'cell_list', as: 'keeper', params: { [key]: 'bogus' } },
		expect: { status: 400 },
		note: `auth/cell_action_specs.ts \`CellListInput\` — \`${key}\` is a \`z.enum\`, so another value is refused, not defaulted`
	})),
	{
		name: 'keeper → cell_field_list naming neither endpoint, {limit: 0} → 400',
		request: { method: 'cell_field_list', as: 'keeper', params: { limit: 0 } },
		expect: { status: 400 },
		note: `auth/cell_relation_list_limit.ts — ${schema_first_note}`
	},
	{
		name: 'keeper → cell_item_list naming both endpoints, {limit: 0} → 400',
		request: {
			method: 'cell_item_list',
			as: 'keeper',
			params: { parent_id: NIL_UUID, child_id: NIL_UUID, limit: 0 }
		},
		expect: { status: 400 },
		note: `auth/cell_relation_list_limit.ts — ${schema_first_note}`
	}
];

const proto_note =
	'actions/perform_action.ts step 5 — an own `__proto__` key anywhere in params is refused before the input schema, so cell `data` and `policy` never store one';

/** A case whose params are `json`, parsed so an own `__proto__` stays a key. */
const proto_case = (
	name: string,
	method: string,
	as: 'keeper' | 'anonymous',
	json: string,
	verb?: 'GET'
): ConformanceCase => ({
	name: `${as} → ${method}${verb ? ' via GET' : ''} ${name} → 400 params_proto_key`,
	request: { method, as, params: JSON.parse(json), ...(verb && { verb }) },
	expect: { status: 400, error_reason: ERROR_PARAMS_PROTO_KEY },
	note: proto_note
});

const proto_cases: Array<ConformanceCase> = [
	proto_case(
		'with data.__proto__',
		'cell_create',
		'keeper',
		'{"kind":"note","data":{"__proto__":{"x":1},"label":"l"}}'
	),
	proto_case(
		'with __proto__ deep in data',
		'cell_create',
		'keeper',
		'{"kind":"note","data":{"a":{"b":[{"__proto__":{}}]}}}'
	),
	proto_case(
		'with policy.__proto__',
		'cell_create',
		'keeper',
		'{"kind":"note","data":{},"policy":{"__proto__":{}}}'
	),
	proto_case(
		'with data.__proto__',
		'cell_update',
		'keeper',
		`{"cell_id":"${NIL_UUID}","data":{"__proto__":{"x":1}}}`
	),
	proto_case(
		'with with_data_patch.__proto__',
		'cell_clone',
		'keeper',
		`{"source_id":"${NIL_UUID}","with_data_patch":{"__proto__":{"x":1}}}`
	),
	proto_case(
		'with policy.__proto__',
		'cell_policy_set',
		'keeper',
		`{"cell_id":"${NIL_UUID}","policy":{"__proto__":{}}}`
	),
	proto_case('with a top-level __proto__', 'cell_list', 'anonymous', '{"__proto__":{}}'),
	proto_case('with a top-level __proto__', 'cell_list', 'anonymous', '{"__proto__":{}}', 'GET'),
	proto_case('with a top-level __proto__', 'cell_list', 'keeper', '{"__proto__":{}}', 'GET')
];

export const conformance_cell_cases: ReadonlyArray<ConformanceCase> = [
	...shape_cases,
	...grant_cases,
	...pagination_cases,
	...schema_first_cases,
	...proto_cases
];
