/**
 * Source-scan drift check: spec `error_reasons` ⟷ handler `reason: ERROR_*`
 * throws.
 *
 * Limits, since the check is regex over source rather than runtime
 * introspection:
 * - Throw sites live inside the handler body or in a `const` helper of the
 *   same module the body calls by name (`builtin_scoped_error()`,
 *   `refuse_builtin_accept(...)`); helper reasons are followed transitively.
 *   A helper declared in another module escapes the scan.
 * - Handler-body slabbing ends at `\n\s*const \w+_handler\b` or
 *   `\n\s*return \[`; restructuring the factory's return shape breaks it.
 *   A helper's slab runs from its `const` line to its closing brace at its
 *   own indent (or the next statement there).
 * - Matches `reason: ERROR_*` anywhere in the slab — comment and
 *   string-literal occurrences count as throws.
 *
 * If admin / account registries adopt `error_reasons`, lift this into a
 * shared helper rather than copy-pasting.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, test } from 'vitest';

import type { RequestResponseActionSpec } from '$lib/actions/action_spec.ts';
import * as role_grant_offer_specs from '$lib/auth/role_grant_offer_action_specs.ts';
import * as error_schemas from '$lib/http/error_schemas.ts';

const handler_source = readFileSync(
	resolve(dirname(fileURLToPath(import.meta.url)), '../../lib/auth/role_grant_offer_actions.ts'),
	'utf8'
);

const error_value_by_name: Record<string, string> = {};
for (const [name, value] of Object.entries({ ...role_grant_offer_specs, ...error_schemas })) {
	if (name.startsWith('ERROR_') && typeof value === 'string') error_value_by_name[name] = value;
}

// Match `rpc_action(spec, handler)` — the unified binder picks the
// actor / account / public narrow per spec literal at compile time;
// the source-scan only cares about the spec → handler pairing.
const spec_to_handler: ReadonlyArray<readonly [string, string]> = [
	...handler_source.matchAll(/\brpc_action\((\w+_action_spec),\s*(\w+_handler)\)/g)
].map((m) => [m[1]!, m[2]!] as const);

const get_handler_body = (handler_name: string): string => {
	const start = new RegExp(`\\bconst ${handler_name}\\b`).exec(handler_source);
	assert(start, `${handler_name} declaration not found in source`);
	const tail = handler_source.slice(start.index);
	const end = /\n\s*const \w+_handler\b|\n\s*return \[/.exec(tail);
	return end ? tail.slice(0, end.index) : tail;
};

const extract_thrown_reason_values = (body: string): Set<string> => {
	const values = new Set<string>();
	for (const m of body.matchAll(/\breason:\s*(ERROR_[A-Z_]+)\b/g)) {
		const name = m[1]!;
		const value = error_value_by_name[name];
		assert(value !== undefined, `unknown ERROR_* identifier in handler source: ${name}`);
		values.add(value);
	}
	return values;
};

/**
 * A helper's slab: its `const` line through its closing brace, or through the
 * line before the next statement indented no deeper.
 */
const get_helper_body = (start: number): string => {
	const line_start = handler_source.lastIndexOf('\n', start) + 1;
	const indent = /^\s*/.exec(handler_source.slice(line_start))![0].length;
	const lines = handler_source.slice(line_start).split('\n');
	let end = 1;
	while (end < lines.length) {
		const line = lines[end]!;
		const trimmed = line.trim();
		if (trimmed !== '' && /^\s*/.exec(line)![0].length <= indent) {
			// a signature continuation (`): T => {`) stays inside; a closing
			// brace ends the helper; anything else is the next statement
			if (trimmed.startsWith(')')) {
				end++;
				continue;
			}
			if (trimmed.startsWith('}')) end++;
			break;
		}
		end++;
	}
	return lines.slice(0, end).join('\n');
};

// Module-local `const` helpers that carry `reason: ERROR_*` throws, keyed by name.
const helper_bodies: Map<string, string> = new Map();
for (const m of handler_source.matchAll(/^[ \t]*const (\w+) = /gm)) {
	const name = m[1]!;
	if (name.endsWith('_handler')) continue;
	const body = get_helper_body(m.index);
	if (/\breason:\s*ERROR_/.test(body)) helper_bodies.set(name, body);
}

/** Every reason a body throws itself or through the module helpers it calls. */
const collect_thrown_reason_values = (body: string, seen: Set<string> = new Set()): Set<string> => {
	const values = extract_thrown_reason_values(body);
	for (const [name, helper_body] of helper_bodies) {
		if (seen.has(name) || !new RegExp(`\\b${name}\\(`).test(body)) continue;
		seen.add(name);
		for (const value of collect_thrown_reason_values(helper_body, seen)) values.add(value);
	}
	return values;
};

const all_specs = role_grant_offer_specs as Record<string, unknown>;

assert(spec_to_handler.length > 0, 'no rpc_action() registrations parsed from handler source');

for (const [spec_const, handler_name] of spec_to_handler) {
	const spec = all_specs[spec_const] as RequestResponseActionSpec | undefined;
	test(`${spec?.method ?? spec_const}: declared error_reasons match handler throws`, () => {
		assert(spec, `spec const ${spec_const} not exported from role_grant_offer_action_specs.js`);
		const declared = new Set(spec.error_reasons ?? []);
		const thrown = collect_thrown_reason_values(get_handler_body(handler_name));
		for (const value of thrown) {
			assert(
				declared.has(value),
				`${handler_name} throws reason '${value}' but ${
					spec_const
				}.error_reasons doesn't declare it — add it to the spec or stop throwing it`
			);
		}
		for (const value of declared) {
			assert(
				thrown.has(value),
				`${spec_const}.error_reasons declares '${value}' but ${
					handler_name
				} doesn't throw it — remove from spec or wire the throw`
			);
		}
	});
}
