/**
 * Declared surface moves that several surface tests apply to captures taken
 * before their schemas moved.
 *
 * @module
 */

import { assert } from 'vitest';
import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';

import { Timestamp } from '#lib/primitive_schemas.ts';
import type { RestErrorDef } from '#lib/http/error_schemas.ts';
import { schema_to_surface } from '#lib/http/schema_helpers.ts';

/** The JSON Schema of `Timestamp`: a string with `format: 'date-time'` and the `iso_datetime` grammar. */
const { $schema: _, ...TIMESTAMP_NODE } = to_json_schema(Timestamp) as Record<string, unknown>;

/**
 * Declared: a timestamp node, a property ending in `_at` that was a bare
 * string (`{type: 'string'}`) or a nullable one
 * (`{type: ['string', 'null']}`) at capture, is `Timestamp` or
 * `nullable(Timestamp)`: the string gains `format` and `pattern`, and the
 * nullable one is an `anyOf` of that and `{type: 'null'}`. Other keys of the
 * node, `description` among them, are kept.
 *
 * @param value - a captured surface, or any part of one
 * @returns the capture with every timestamp node moved
 */
export const with_timestamp_format = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(with_timestamp_format);
	if (typeof value !== 'object' || value === null) return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		out[key] =
			key === 'properties' && typeof child === 'object' && child !== null
				? with_timestamp_properties(child as Record<string, unknown>)
				: with_timestamp_format(child);
	}
	return out;
};

const with_timestamp_properties = (
	properties: Record<string, unknown>
): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const [key, node] of Object.entries(properties)) {
		out[key] = key.endsWith('_at') ? to_timestamp_node(node) : with_timestamp_format(node);
	}
	return out;
};

const to_timestamp_node = (node: unknown): unknown => {
	const { type, ...rest } = node as Record<string, unknown>;
	if (type === 'string') return { ...TIMESTAMP_NODE, ...rest };
	if (JSON.stringify(type) === '["string","null"]') {
		return { anyOf: [TIMESTAMP_NODE, { type: 'null' }], ...rest };
	}
	throw new Error(`a timestamp node of an unexpected form: ${JSON.stringify(node)}`);
};

/**
 * The codes a surface error schema names, its branches in order: a `const`,
 * an `enum`'s values, or `*` for an `error` of any string.
 *
 * @param schema - a route's error schema at one status, as the surface writes it
 */
export const surface_error_codes = (schema: unknown): Array<string> => {
	const node = schema as Record<string, any> | undefined;
	if (!node) return [];
	if (Array.isArray(node.anyOf)) return node.anyOf.flatMap(surface_error_codes);
	const error = node.properties?.error;
	if (typeof error?.const === 'string') return [error.const];
	if (Array.isArray(error?.enum)) return error.enum;
	return ['*'];
};

/** A declared move of a route's error schema at one status: the codes it named, and the definitions it is. */
export interface ErrorMove {
	/** The codes the capture names at the status (`surface_error_codes`), `[]` for none. */
	from: ReadonlyArray<string>;
	/** The definitions the status is now, in order; `[]` for none. */
	to: ReadonlyArray<RestErrorDef>;
}

/**
 * Declared: a captured route's error schemas moved by the error rules —
 * narrowed to the slots it has, unioned with the layers that declare at the
 * same status, a definition each branch. Each move first checks the capture
 * names the codes it says it does, then writes the status as its definitions'
 * bodies: one schema, or an `anyOf` of them in order. A moved status's shape
 * comes from the definitions and is not compared to the capture's; only its
 * codes are. A status no move names is kept as captured.
 *
 * @param route - a captured surface route
 * @param moves - the moves of its error schemas, by status
 * @returns the route with each move applied
 */
export const with_error_moves = (
	route: Record<string, any>,
	moves: Record<number, ErrorMove> | undefined
): Record<string, any> => {
	if (!moves) return route;
	const error_schemas: Record<string, unknown> = { ...route.error_schemas };
	for (const [status, { from, to }] of Object.entries(moves)) {
		assert.deepStrictEqual(
			surface_error_codes(error_schemas[status]),
			[...from],
			`${route.method} ${route.path} ${status} at capture`
		);
		const bodies = to.map((def) => schema_to_surface(def.schema, { io: 'output' }));
		if (bodies.length === 0) delete error_schemas[status];
		else error_schemas[status] = bodies.length === 1 ? bodies[0] : { anyOf: bodies };
	}
	const statuses = Object.keys(error_schemas).sort((a, b) => Number(a) - Number(b));
	return {
		...route,
		error_schemas: statuses.length
			? Object.fromEntries(statuses.map((s) => [s, error_schemas[s]]))
			: null
	};
};
