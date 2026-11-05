/**
 * A generated file built from every codegen block over an all-Zod spec list —
 * fuz_app's own action specs and synthetic specs of each kind — the input of
 * `action_codegen.zod_fixture.test.ts`, which holds it to the text the
 * Zod-only codegen emitted, and holds fuz_app's own list, whose
 * `account_token_revoke`, `actor_lookup` and `actor_search` are
 * `@fuzdev/fuz_schema`, to that text with those methods' types read by `Infer`.
 *
 * @module
 */

import { z } from 'zod';

import {
	ImportBuilder,
	compose_gen_file,
	create_namespace_qualifier,
	generate_action_event_datas,
	generate_action_inputs_outputs,
	generate_action_method_enums,
	generate_action_specs_record,
	generate_backend_actions_api,
	generate_frontend_action_handlers,
	generate_frontend_actions_api,
	generate_typed_action_event_alias
} from '#lib/actions/action_codegen.ts';
import type { ActionSpecUnion } from '#lib/actions/action_spec.ts';
import { protocol_action_specs } from '#lib/actions/protocol.ts';
import { all_fuz_auth_action_spec_registries } from '#lib/auth/all_action_spec_registries.ts';
import { all_cell_action_specs } from '#lib/auth/cell_action_specs.ts';
import { all_cell_grant_action_specs } from '#lib/auth/cell_grant_action_specs.ts';
import { all_cell_field_action_specs } from '#lib/auth/cell_field_action_specs.ts';
import { all_cell_item_action_specs } from '#lib/auth/cell_item_action_specs.ts';
import { all_cell_audit_action_specs } from '#lib/auth/cell_audit_action_specs.ts';
import { account_token_revoke_action_spec } from '#lib/auth/account_action_specs.ts';
import { ApiTokenId } from '#lib/auth/api_token.ts';
import {
	ACTOR_LOOKUP_IDS_MAX,
	actor_lookup_action_spec
} from '#lib/auth/actor_lookup_action_specs.ts';
import {
	ACTOR_SEARCH_LIMIT_DEFAULT,
	ACTOR_SEARCH_LIMIT_MAX,
	ACTOR_SEARCH_QUERY_LENGTH_MAX,
	actor_search_action_spec
} from '#lib/auth/actor_search_action_specs.ts';
import { Uuid, bounded_string } from '#lib/primitive_schemas.ts';

// one spec per input shape the signature reads: void, null, optional, defaulted, required
const synthetic_specs: Array<ActionSpecUnion> = [
	{
		method: 'fixture_changed',
		kind: 'remote_notification',
		initiator: 'backend',
		auth: null,
		side_effects: true,
		input: z.strictObject({ id: z.string() }),
		output: z.void(),
		async: true,
		description: 'a backend broadcast'
	},
	{
		method: 'fixture_ping',
		kind: 'remote_notification',
		initiator: 'frontend',
		auth: null,
		side_effects: true,
		input: z.void(),
		output: z.void(),
		async: true,
		description: 'a frontend notification with no input'
	},
	{
		method: 'fixture_toggle',
		kind: 'local_call',
		initiator: 'frontend',
		auth: null,
		side_effects: false,
		input: z.null(),
		output: z.null(),
		async: false,
		description: 'a sync local call with a null input'
	},
	{
		method: 'fixture_load',
		kind: 'local_call',
		initiator: 'frontend',
		auth: null,
		side_effects: false,
		input: z.strictObject({ path: z.string() }).optional(),
		output: z.strictObject({ text: z.string() }),
		async: true,
		description: 'an async local call with an optional input'
	},
	{
		method: 'fixture/list',
		kind: 'request_response',
		initiator: 'frontend',
		auth: { account: 'required', actor: 'none' },
		side_effects: false,
		input: z.strictObject({ limit: z.number().optional() }).default({}),
		output: z.strictObject({ items: z.array(z.string()) }),
		async: true,
		description: 'a read with a defaulted input and a method that is no identifier'
	},
	{
		method: 'fixture_ask',
		kind: 'request_response',
		initiator: 'backend',
		auth: { account: 'none', actor: 'none' },
		side_effects: true,
		input: z.strictObject({ question: z.string() }),
		output: z.strictObject({ answer: z.string() }),
		async: true,
		description: 'a backend-initiated request'
	}
];

/**
 * fuz_app's own specs, as `action_spec_input_invariants.test.ts` walks them,
 * each method once (a spec can sit in more than one registry).
 */
const fuz_app_specs: Array<ActionSpecUnion> = [
	...new Map(
		[
			...all_fuz_auth_action_spec_registries.flatMap((r) => r.specs),
			...all_cell_action_specs,
			...all_cell_grant_action_specs,
			...all_cell_field_action_specs,
			...all_cell_item_action_specs,
			...all_cell_audit_action_specs,
			...protocol_action_specs
		].map((spec): [string, ActionSpecUnion] => [spec.method, spec])
	).values()
];

/** `account_token_revoke` with the Zod schemas it declared before its own moved to `@fuzdev/fuz_schema`. */
const zod_token_revoke_spec: ActionSpecUnion = {
	...account_token_revoke_action_spec,
	input: z.strictObject({
		token_id: ApiTokenId.meta({ description: 'Public API token id (e.g. `tok_<12 chars>`).' })
	}),
	output: z.strictObject({ ok: z.literal(true), revoked: z.boolean() })
};

// the Zod `ActorLookupEntryJson` both actor outputs held
const ZodActorLookupEntryJson = z.strictObject({
	id: Uuid,
	username: z.string(),
	display_name: z.string().optional()
});

/** `actor_lookup` with the Zod schemas it declared before its own moved to `@fuzdev/fuz_schema`. */
const zod_actor_lookup_spec: ActionSpecUnion = {
	...actor_lookup_action_spec,
	input: z.strictObject({
		ids: z
			.array(Uuid)
			.min(1)
			.max(ACTOR_LOOKUP_IDS_MAX)
			.meta({
				description: `Actor ids to resolve. Capped at ${
					ACTOR_LOOKUP_IDS_MAX
				}; unknown ids are silently absent from the response.`
			})
	}),
	output: z.strictObject({ actors: z.array(ZodActorLookupEntryJson) })
};

/** `actor_search` with the Zod schemas it declared before its own moved to `@fuzdev/fuz_schema`. */
const zod_actor_search_spec: ActionSpecUnion = {
	...actor_search_action_spec,
	input: z.strictObject({
		query: bounded_string({ min: 1, max: ACTOR_SEARCH_QUERY_LENGTH_MAX }).meta({
			description: `Case-insensitive prefix match against \`actor.name\`. Length 1–${
				ACTOR_SEARCH_QUERY_LENGTH_MAX
			}.`,
			sensitivity: 'personal'
		}),
		scope_ids: z.array(Uuid).optional().meta({
			description:
				'Restrict results to actors holding a role_grant on any of these scopes. Required (non-empty) for non-admin callers; admin callers may omit or pass empty for unbounded search. Caller is responsible for pre-filtering against their own authority — the SQL filter does not enforce it.'
		}),
		limit: z
			.number()
			.int()
			.min(1)
			.max(ACTOR_SEARCH_LIMIT_MAX)
			.optional()
			.meta({
				description: `Maximum rows to return. Defaults to ${ACTOR_SEARCH_LIMIT_DEFAULT}, hard cap ${
					ACTOR_SEARCH_LIMIT_MAX
				}.`
			})
	}),
	output: z.strictObject({ actors: z.array(ZodActorLookupEntryJson) })
};

/**
 * The Zod specs of the methods whose own schemas moved to `@fuzdev/fuz_schema`,
 * keyed by method, so the list stays all-Zod and the fixture keeps each method
 * in its place.
 */
const zod_specs_by_method: Map<string, ActionSpecUnion> = new Map([
	[zod_token_revoke_spec.method, zod_token_revoke_spec],
	[zod_actor_lookup_spec.method, zod_actor_lookup_spec],
	[zod_actor_search_spec.method, zod_actor_search_spec]
]);

/** The methods of fuz_app's own list whose schemas are `@fuzdev/fuz_schema`. */
export const fuz_schema_methods: ReadonlyArray<string> = [...zod_specs_by_method.keys()];

/** fuz_app's own specs and the synthetic ones, in the fixture's order. */
export const fixture_specs: Array<ActionSpecUnion> = [...fuz_app_specs, ...synthetic_specs];

/** The all-Zod spec list the fixture is generated from. */
export const zod_fixture_specs: Array<ActionSpecUnion> = fixture_specs.map(
	(spec) => zod_specs_by_method.get(spec.method) ?? spec
);

/**
 * Every codegen block over `specs` composed into one file: once with the
 * default `* as specs` import and once through a namespace qualifier, with
 * protocol actions included and filtered, and sync local calls both
 * returning their value and wrapped.
 *
 * @param specs - the specs to generate from
 * @returns the composed file text
 */
export const generate_codegen_fixture = (specs: ReadonlyArray<ActionSpecUnion>): string => {
	const imports = new ImportBuilder();
	const blocks = [
		generate_action_method_enums(specs, imports),
		generate_action_method_enums(specs, imports, { include_protocol_actions: true }),
		generate_action_specs_record(specs, imports),
		generate_action_inputs_outputs(specs, imports),
		generate_action_inputs_outputs(specs, imports, { include_protocol_actions: true }),
		generate_action_event_datas(specs, imports, { same_file: false }),
		generate_frontend_actions_api(specs, imports),
		generate_frontend_actions_api(specs, imports, {
			sync_returns_value: false,
			include_protocol_actions: true
		}),
		generate_frontend_action_handlers(specs, imports),
		generate_backend_actions_api(specs, imports),
		generate_typed_action_event_alias(imports)
	];
	const qualified_imports = new ImportBuilder();
	const { qualify_spec } = create_namespace_qualifier(
		[{ ns: 'fixture_specs', module: './fixture_specs.ts', specs }],
		qualified_imports
	);
	const qualified_blocks = [
		generate_action_specs_record(specs, qualified_imports, { qualify_spec }),
		generate_action_inputs_outputs(specs, qualified_imports, { qualify_spec }),
		generate_backend_actions_api(specs, qualified_imports, { qualify_spec })
	];
	return (
		compose_gen_file({ origin_path: 'fixture.gen.ts', imports, blocks }) +
		compose_gen_file({
			origin_path: 'fixture_qualified.gen.ts',
			imports: qualified_imports,
			blocks: qualified_blocks
		})
	);
};
