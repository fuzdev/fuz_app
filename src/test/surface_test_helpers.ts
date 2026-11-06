/**
 * Declared surface moves that several surface tests apply to their Zod-era
 * captures.
 *
 * @module
 */

import { to_json_schema } from '@fuzdev/fuz_schema/json_schema.ts';

import { Timestamp } from '#lib/primitive_schemas_fuz.ts';

/** The JSON Schema of `Timestamp`: a string with `format: 'date-time'` and the `iso_datetime` grammar. */
const { $schema: _, ...TIMESTAMP_NODE } = to_json_schema(Timestamp) as Record<string, unknown>;

/**
 * Declared: a timestamp node, a property ending in `_at` that was a Zod
 * `z.string()` (`{type: 'string'}`) or `z.string().nullable()`
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
