import {UnreachableError} from '@fuzdev/fuz_util/error.js';
import {zod_get_base_type} from '@fuzdev/fuz_util/zod.js';

import type {ActionSpecUnion, ActionEventPhase} from './action_spec.js';
import {ActionRegistry} from './action_registry.js';

/**
 * Method names of composable actions exported from fuz_app — `heartbeat` (auth-aware
 * client liveness probe) and `cancel` (request-scoped abort signal). Consumers spread
 * this list when filtering backend request_response methods so the dispatcher-owned
 * composables don't show up in `BackendRequestResponseMethod` / handler maps.
 */
export const COMPOSABLE_ACTION_METHODS = ['heartbeat', 'cancel'] as const;

/** Methods that ship from fuz_app, kept out of consumer-owned method enums + handler maps. */
export type ComposableActionMethod = (typeof COMPOSABLE_ACTION_METHODS)[number];

const COMPOSABLE_METHOD_SET: ReadonlySet<string> = new Set(COMPOSABLE_ACTION_METHODS);

/**
 * Type predicate for filtering composable methods out of a typed `ActionsApi`
 * `method_filter`. Avoids the `(... as never)` cast required to call
 * `Array.prototype.includes` on the readonly tuple at narrow string types.
 *
 * @example
 * generate_actions_api(specs, imports, {
 *   method_filter: (s) => !is_composable_action_method(s.method),
 * });
 */
export const is_composable_action_method = (method: string): method is ComposableActionMethod =>
	COMPOSABLE_METHOD_SET.has(method);

/**
 * Represents an import item with its kind (type, value, or namespace).
 */
interface ImportItem {
	name: string;
	kind: 'type' | 'value' | 'namespace';
}

/**
 * Manages imports for generated code, building them on demand.
 * Automatically optimizes type-only imports to use `import type` syntax.
 *
 * Why this matters:
 * - `import type` statements are completely removed during compilation
 * - Mixed imports like `import { type A, B }` cannot be safely removed
 * - This ensures optimal tree-shaking and smaller bundle sizes
 *
 * @example
 * ```typescript
 * const imports = new ImportBuilder();
 * imports.add_types('./types.js', 'Foo', 'Bar');
 * imports.add('./utils.js', 'helper');
 * imports.add_type('./utils.js', 'HelperOptions');
 * imports.add('./action_specs.js', '* as specs');
 *
 * // Generates:
 * // import type {Foo, Bar} from './types.js';
 * // import {helper, type HelperOptions} from './utils.js';
 * // import * as specs from './action_specs.js';
 * ```
 */
export class ImportBuilder {
	imports: Map<string, Map<string, ImportItem>> = new Map();

	/**
	 * Add a value import to be included in the generated code.
	 * @param from - the module to import from
	 * @param what - what to import (value)
	 */
	add(from: string, what: string): this {
		// Handle namespace imports specially
		if (what.startsWith('* as ')) {
			return this.#add_import(from, what, 'namespace');
		}
		return this.#add_import(from, what, 'value');
	}

	/**
	 * Add a type import to be included in the generated code.
	 * @param from - the module to import from
	 * @param what - what to import (type)
	 */
	add_type(from: string, what: string): this {
		return this.#add_import(from, what, 'type');
	}

	/**
	 * Add multiple value imports from the same module.
	 */
	add_many(from: string, ...items: Array<string>): this {
		for (const item of items) {
			this.add(from, item);
		}
		return this;
	}

	/**
	 * Add multiple type imports from the same module.
	 */
	add_types(from: string, ...items: Array<string>): this {
		for (const item of items) {
			this.add_type(from, item);
		}
		return this;
	}

	/**
	 * Internal method to add an import with its kind.
	 */
	#add_import(from: string, name: string, kind: 'type' | 'value' | 'namespace'): this {
		// Skip empty imports
		if (!name || (kind !== 'namespace' && name === '')) {
			return this;
		}

		if (!this.imports.has(from)) {
			this.imports.set(from, new Map());
		}

		const module_imports = this.imports.get(from)!;
		const existing = module_imports.get(name);

		// If already imported as a value, don't downgrade to type
		if (existing?.kind === 'value' && kind === 'type') {
			return this;
		}

		module_imports.set(name, {name, kind});
		return this;
	}

	/**
	 * Generate the import statements.
	 * If all imports from a module are types, uses `import type` syntax.
	 */
	build(): string {
		return this.#generate_import_statements().join('\n');
	}

	/**
	 * Check if the builder has any imports.
	 */
	has_imports(): boolean {
		return this.imports.size > 0;
	}

	/**
	 * Get the number of import statements that will be generated.
	 */
	get import_count(): number {
		return this.imports.size;
	}

	/**
	 * Preview what imports will be generated (useful for debugging).
	 * @returns array of import statement strings
	 */
	preview(): Array<string> {
		return this.#generate_import_statements();
	}

	/**
	 * Clear all imports.
	 */
	clear(): this {
		this.imports.clear();
		return this;
	}

	/**
	 * Internal helper to generate import statements from the current state.
	 * Shared by both build() and preview() methods.
	 */
	#generate_import_statements(): Array<string> {
		const statements: Array<string> = [];

		for (const [from, module_imports] of this.imports) {
			const items = Array.from(module_imports.values());

			// Check if all imports are types
			const all_types = items.every((item) => item.kind === 'type');

			if (all_types) {
				// Use type-only import syntax
				const sorted_names = items
					.map((item) => item.name)
					.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
				statements.push(`import type {${sorted_names.join(', ')}} from '${from}';`);
			} else {
				// Check for namespace imports (should be only one per module)
				const namespace_import = items.find((item) => item.kind === 'namespace');
				if (namespace_import) {
					statements.push(`import ${namespace_import.name} from '${from}';`);
				} else {
					// Mixed imports - sort values first, then types, alphabetically within each group
					const sorted_items = items.sort((a, b) => {
						// First sort by kind: values before types
						if (a.kind !== b.kind) {
							return a.kind === 'value' ? -1 : 1;
						}
						// Then sort alphabetically within the same kind using standard comparison
						return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
					});

					const formatted_imports = sorted_items.map((item) => {
						if (item.kind === 'namespace') {
							return item.name; // namespace imports like "* as foo" are used as-is
						}
						return item.kind === 'type' ? `type ${item.name}` : item.name;
					});
					statements.push(`import {${formatted_imports.join(', ')}} from '${from}';`);
				}
			}
		}

		return statements;
	}
}

/**
 * Determines which phases an executor can handle based on the action spec.
 */
export const get_executor_phases = (
	spec: ActionSpecUnion,
	executor: 'frontend' | 'backend',
): Array<ActionEventPhase> => {
	const {kind, initiator} = spec;
	const phases: Array<ActionEventPhase> = [];

	switch (kind) {
		case 'request_response': {
			// Executor can send/receive based on initiator
			const can_send = initiator === executor || initiator === 'both';
			const can_receive = initiator === 'both' || initiator !== executor;

			switch (executor) {
				case 'frontend':
					if (can_send) {
						phases.push('send_request', 'receive_response');
						// Add error phases for send/receive
						phases.push('send_error', 'receive_error');
					}
					if (can_receive) phases.push('receive_request', 'send_response');
					break;
				case 'backend':
					if (can_send) {
						phases.push('send_request', 'receive_response');
						// Add error phases for send/receive
						phases.push('send_error', 'receive_error');
					}
					if (can_receive) {
						phases.push('receive_request', 'send_response');
						// TODO @action-system-review This adds send_error redundantly when initiator:'both'
						// (already added above). Deduplication via Set at the end handles it,
						// but the logic should be consolidated when the action system is revisited.
						phases.push('send_error');
					}
					break;
				default:
					throw new UnreachableError(executor);
			}
			break;
		}

		case 'remote_notification': {
			const can_send = initiator === executor || initiator === 'both';
			const can_receive = initiator === 'both' || initiator !== executor;

			if (can_send) phases.push('send');
			if (can_receive) phases.push('receive');
			break;
		}

		case 'local_call': {
			const can_execute = initiator === executor || initiator === 'both';
			if (can_execute) phases.push('execute');
			break;
		}

		default:
			throw new UnreachableError(kind);
	}

	// Deduplicate phases (e.g., send_error added twice for initiator:'both' backend actions)
	return Array.from(new Set(phases));
};

/** Default `collections_path` — every consumer's gen producers point at the sibling `action_collections.js`. */
export const DEFAULT_COLLECTIONS_PATH = './action_collections.js';

/** Default `specs_module` — sibling `action_specs.js` namespace bundled by the consumer. */
export const DEFAULT_SPECS_MODULE = './action_specs.js';

/** Default `metatypes_path` — sibling `action_metatypes.js` carrying the generated `ActionMethod`. */
export const DEFAULT_METATYPES_PATH = './action_metatypes.js';

/**
 * Gets the handler return type for a specific phase and spec. Adds an
 * `ActionOutputs` import (from `collections_path`) when the phase carries an
 * output (request_response `receive_request`, local_call `execute`).
 */
export const get_handler_return_type = (
	spec: ActionSpecUnion,
	phase: ActionEventPhase,
	imports: ImportBuilder,
	collections_path: string = DEFAULT_COLLECTIONS_PATH,
): string => {
	// For request_response receive_request, handler returns the output
	if (spec.kind === 'request_response' && phase === 'receive_request') {
		imports.add_type(collections_path, 'ActionOutputs');
		const base_type = `ActionOutputs['${spec.method}']`;
		// Request/response actions are always async
		return `${base_type} | Promise<${base_type}>`;
	}

	// For local_call execute, handler returns the output
	if (spec.kind === 'local_call' && phase === 'execute') {
		imports.add_type(collections_path, 'ActionOutputs');
		const base_type = `ActionOutputs['${spec.method}']`;
		return spec.async ? `${base_type} | Promise<${base_type}>` : base_type;
	}

	// All other phases return void
	return 'void | Promise<void>';
};

/**
 * Generates the phase handlers for an action spec using the unified ActionEvent type
 * with the new phase/step type parameters.
 *
 * @param options.action_event_type - custom type name to use instead of `ActionEvent`
 *   (consumers can define a narrowed type that carries typed input/output via their codegen maps)
 * @param options.collections_path - import path the side-effect `ActionOutputs` import
 *   resolves to. Defaults to `'./action_collections.js'`.
 */
export const generate_phase_handlers = (
	spec: ActionSpecUnion,
	executor: 'frontend' | 'backend',
	imports: ImportBuilder,
	options?: {action_event_type?: string; collections_path?: string},
): string => {
	const {method} = spec;
	const phases = get_executor_phases(spec, executor);

	if (phases.length === 0) {
		return `${method}?: never`;
	}

	const action_event_type = options?.action_event_type ?? 'ActionEvent';
	const collections_path = options?.collections_path ?? DEFAULT_COLLECTIONS_PATH;

	// Only add the default ActionEvent import if using the default type name
	if (action_event_type === 'ActionEvent') {
		imports.add_type('@fuzdev/fuz_app/actions/action_event.js', 'ActionEvent');
	}

	const phase_handlers = phases
		.map((phase: ActionEventPhase) => {
			// Pass imports to get_handler_return_type so it can add necessary imports
			const return_type = get_handler_return_type(spec, phase, imports, collections_path);
			return `${phase}?: (
			action_event: ${action_event_type}<'${method}', '${phase}', 'handling'>
		) => ${return_type}`;
		})
		.join(';\n\t\t');

	return `${method}?: {\n\t\t${phase_handlers};\n\t}`;
};

/**
 * Creates a file banner comment.
 */
export const create_banner = (origin_path: string): string =>
	`generated by ${origin_path} - DO NOT EDIT OR RISK LOST DATA`;

// TODO rethink these, see also zzz `codegen.ts`
export const to_action_spec_identifier = (method: string): string => `${method}_action_spec`;
export const to_action_spec_input_identifier = (method: string): string =>
	`${to_action_spec_identifier(method)}.input`;
export const to_action_spec_output_identifier = (method: string): string =>
	`${to_action_spec_identifier(method)}.output`;

/**
 * Generates one method line of the typed `ActionsApi` interface for a single
 * spec. Encapsulates the input/options/return-type signature shape so the
 * surface evolves in one place when fields like `signal` or `transport_name`
 * are added to per-call options.
 *
 * Async methods (`request_response`, `remote_notification`, async
 * `local_call`) get an optional second `options?: RpcClientCallOptions` arg
 * (`{signal?, transport_name?, queue?}`) and a `Promise<Result<...>>` return
 * type. Sync `local_call` methods omit the options arg — `signal` can't
 * cooperatively interrupt a synchronous handler and there's no transport to
 * select. `remote_notification` is async because
 * `create_remote_notification_method` returns a Promise that resolves to a
 * `Result<{value: void}>` (success) or `Result<{error}>` (transport send
 * failure). Earlier emit shapes declared notifications as `=> void` —
 * regenerate consumer typed clients to pick up the corrected return.
 *
 * Consumers must import `ActionInputs`, `ActionOutputs`, `Result`,
 * `JsonrpcErrorObject`, and (for async) `RpcClientCallOptions` into the
 * generated module — the helper only emits the type references.
 *
 * @param spec - the action spec to emit
 * @param options.sync_returns_value - when true (default), sync local_call
 *   methods return the output value directly; when false they're wrapped in
 *   `Result<{value, error}>` like async methods. Set to `false` if your
 *   ActionsApi treats every method uniformly.
 * @returns one line like `foo: (input: ActionInputs['foo'], options?: RpcClientCallOptions) => Promise<Result<...>>;`
 */
export const generate_actions_api_method_signature = (
	spec: ActionSpecUnion,
	options?: {sync_returns_value?: boolean},
): string => {
	const sync_returns_value = options?.sync_returns_value ?? true;
	const innermost_type_name = zod_get_base_type(spec.input);
	const has_input = innermost_type_name !== 'null' && innermost_type_name !== 'void';
	const input_param = has_input
		? `input${spec.input.safeParse(undefined).success ? '?' : ''}: ActionInputs['${spec.method}']`
		: 'input?: void';

	const is_async =
		spec.kind === 'request_response' || spec.kind === 'remote_notification' || spec.async;
	const options_param = is_async ? ', options?: RpcClientCallOptions' : '';

	const result_return = `Result<{value: ActionOutputs['${spec.method}']}, {error: JsonrpcErrorObject}>`;
	const return_type = is_async
		? `Promise<${result_return}>`
		: sync_returns_value
			? `ActionOutputs['${spec.method}']`
			: result_return;

	return `${spec.method}: (${input_param}${options_param}) => ${return_type};`;
};

// --------------------------------------------------------------------------
// High-level codegen helpers — compose the lower-level primitives above into
// the literal blocks consumer `*.gen.ts` producers emit. Tier 1 consumers
// (HTTP-only, e.g. tx) call the value-side helpers; Tier 2 (`TypedActionEvent`-
// aware, e.g. zzz) also call the typed-event + frontend-handlers helpers.
//
// **Multi-source consumers.** Helpers that reference specs at runtime
// (`generate_action_specs_record`, `generate_action_inputs_outputs`,
// `generate_backend_actions_api`) default to a single `* as specs from
// specs_module` namespace import and emit `specs.{method}_action_spec`. Pass
// `qualify_spec?: (spec) => string` to emit a per-spec qualified identifier
// (e.g. `admin_specs.account_list_action_spec`) for consumers stitching local
// specs together with multiple upstream sources (`all_admin_action_specs` /
// `all_permit_offer_action_specs` / `all_account_action_specs` /
// `all_self_service_role_action_specs` from fuz_app). When `qualify_spec` is
// set, the helper does NOT add a `* as specs` import — the consumer manages
// the multiple `* as ns` imports itself — and `specs_module` is ignored.
// --------------------------------------------------------------------------

/** Discriminator for `generate_action_method_enums` — which method-set enums to emit. */
export type ActionMethodEnumKind =
	| 'all'
	| 'request_response'
	| 'remote_notification'
	| 'local_call'
	| 'frontend'
	| 'backend';

/** Default emit set — every enum kind. */
export const ACTION_METHOD_ENUM_KINDS_ALL: ReadonlySet<ActionMethodEnumKind> = new Set([
	'all',
	'request_response',
	'remote_notification',
	'local_call',
	'frontend',
	'backend',
]);

/**
 * Filter `heartbeat` / `cancel` out of `specs` unless the consumer opts back in.
 * Composables ship from fuz_app and are spread into every consumer's `actions`
 * array at registration time — they should not appear in consumer-owned typed
 * surfaces (`ActionMethod`, `ActionsApi`, `ActionInputs`, etc.) by default.
 */
const filter_composables = (
	specs: ReadonlyArray<ActionSpecUnion>,
	include_composables: boolean | undefined,
): ReadonlyArray<ActionSpecUnion> =>
	include_composables ? specs : specs.filter((s) => !is_composable_action_method(s.method));

/**
 * Resolve the per-spec identifier qualifier used by the multi-source helpers
 * (`generate_action_specs_record`, `generate_action_inputs_outputs`,
 * `generate_backend_actions_api`). When `qualify_spec` is set, returns the
 * caller's callback verbatim — the consumer is managing its own namespace
 * imports. Otherwise, registers the default `* as specs from specs_module`
 * import (defaulting to `'./action_specs.js'`) and returns the matching
 * `specs.${method}_action_spec` qualifier.
 */
const resolve_spec_qualifier = (
	imports: ImportBuilder,
	options?: {
		specs_module?: string;
		qualify_spec?: (spec: ActionSpecUnion) => string;
	},
): ((spec: ActionSpecUnion) => string) => {
	if (options?.qualify_spec) return options.qualify_spec;
	const specs_module = options?.specs_module ?? DEFAULT_SPECS_MODULE;
	imports.add(specs_module, '* as specs');
	return (s) => `specs.${s.method}_action_spec`;
};

/**
 * Emit one or more `z.enum([...])` declarations for action method names —
 * `ActionMethod`, `RequestResponseActionMethod`, `RemoteNotificationActionMethod`,
 * `LocalCallActionMethod`, `FrontendActionMethod`, `BackendActionMethod`. Pairs
 * each runtime const with a `z.infer` type alias under the same identifier.
 *
 * Composable methods (`heartbeat`, `cancel`) are filtered out by default —
 * pass `include_composables: true` if a consumer genuinely wants them on
 * their typed surface. Empty kinds are skipped so the helper never emits
 * `z.enum([])` (zod runtime-throws on that).
 *
 * Adds `import {z} from 'zod';` to `imports` only when at least one block
 * is emitted (idempotent).
 *
 * @param options.emit - subset of enums to emit; defaults to all six.
 * @param options.include_composables - when true, retains `heartbeat` /
 *   `cancel` in the emitted enums. Default `false`.
 */
export const generate_action_method_enums = (
	specs: ReadonlyArray<ActionSpecUnion>,
	imports: ImportBuilder,
	options?: {emit?: ReadonlySet<ActionMethodEnumKind>; include_composables?: boolean},
): string => {
	const emit = options?.emit ?? ACTION_METHOD_ENUM_KINDS_ALL;
	const filtered = filter_composables(specs, options?.include_composables);
	const registry = new ActionRegistry([...filtered]);

	const blocks: Array<string> = [];
	const emit_block = (
		kind: ActionMethodEnumKind,
		name: string,
		methods: ReadonlyArray<string>,
		jsdoc: string,
	): void => {
		if (!emit.has(kind)) return;
		// `z.enum([])` is invalid — skip empty kinds rather than emit broken code.
		// Consumers that need a kind to exist should check their spec set, not the helper.
		if (methods.length === 0) return;
		const lines = methods.map((m) => `\t'${m}',`).join('\n');
		blocks.push(`/**\n * ${jsdoc}\n */\nexport const ${name} = z.enum([\n${lines}\n]);
export type ${name} = z.infer<typeof ${name}>;`);
	};

	emit_block(
		'all',
		'ActionMethod',
		registry.methods,
		'All action method names. Request/response actions have two types per method.',
	);
	emit_block(
		'request_response',
		'RequestResponseActionMethod',
		registry.request_response_methods,
		'Names of all request_response actions.',
	);
	emit_block(
		'remote_notification',
		'RemoteNotificationActionMethod',
		registry.remote_notification_methods,
		'Names of all remote_notification actions.',
	);
	emit_block(
		'local_call',
		'LocalCallActionMethod',
		registry.local_call_methods,
		'Names of all local_call actions.',
	);
	emit_block(
		'frontend',
		'FrontendActionMethod',
		registry.frontend_methods,
		'Names of all actions that may be handled on the client.',
	);
	emit_block(
		'backend',
		'BackendActionMethod',
		registry.backend_methods,
		'Names of all actions that may be handled on the server.',
	);

	if (blocks.length === 0) return '';
	imports.add('zod', 'z');
	return blocks.join('\n\n');
};

/**
 * Emit the fixed-shape `TypedActionEvent` alias used by `FrontendActionHandlers`
 * to narrow `ActionEvent.data` against the consumer's generated `ActionEventDatas`
 * map. Registers the four fuz_app type imports it needs (`ActionEvent`,
 * `ActionEventPhase`, `ActionEventStep`, `ActionEventDatas`) plus the
 * `ActionMethod` type import — sourced from `collections_path` and
 * `metatypes_path` respectively.
 *
 * Pair with `generate_action_method_enums` (emits `ActionMethod` into
 * `metatypes_path`) and `generate_action_event_datas` (emits
 * `ActionEventDatas` into `collections_path`).
 */
export const generate_typed_action_event_alias = (
	imports: ImportBuilder,
	options?: {collections_path?: string; metatypes_path?: string},
): string => {
	const collections_path = options?.collections_path ?? DEFAULT_COLLECTIONS_PATH;
	const metatypes_path = options?.metatypes_path ?? DEFAULT_METATYPES_PATH;
	imports.add_type('@fuzdev/fuz_app/actions/action_event.js', 'ActionEvent');
	imports.add_type('@fuzdev/fuz_app/actions/action_spec.js', 'ActionEventPhase');
	imports.add_type('@fuzdev/fuz_app/actions/action_event_types.js', 'ActionEventStep');
	imports.add_type(collections_path, 'ActionEventDatas');
	imports.add_type(metatypes_path, 'ActionMethod');
	return `/** ActionEvent narrowed with the generated ActionEventDatas for typed input/output. */
type TypedActionEvent<
	TMethod extends ActionMethod,
	TPhase extends ActionEventPhase,
	TStep extends ActionEventStep,
> = ActionEvent<TMethod, TPhase, TStep> & {readonly data: ActionEventDatas[TMethod]};`;
};

/**
 * Emit the `ActionSpecs` runtime const + interface + the `action_specs:
 * Array<ActionSpecUnion>` value bundling every spec. Adds the `* as specs`
 * namespace import + the `ActionSpecUnion` type import.
 *
 * @param options.qualify_spec - per-spec qualified identifier callback for
 *   multi-source consumers (e.g. ``(s) => `admin_specs.${s.method}_action_spec` ``).
 *   When set, the helper emits the callback's return value instead of
 *   ``specs.${method}_action_spec`` and skips the default `* as specs`
 *   import — the consumer manages its own namespace imports. `specs_module`
 *   is ignored when `qualify_spec` is set. Single-source consumers omit it.
 */
export const generate_action_specs_record = (
	specs: ReadonlyArray<ActionSpecUnion>,
	imports: ImportBuilder,
	options?: {
		specs_module?: string;
		qualify_spec?: (spec: ActionSpecUnion) => string;
		include_composables?: boolean;
	},
): string => {
	const filtered = filter_composables(specs, options?.include_composables);
	imports.add_type('@fuzdev/fuz_app/actions/action_spec.js', 'ActionSpecUnion');

	if (filtered.length === 0) {
		// Empty spec list — emit minimal valid output and skip the `* as specs`
		// import that would have nothing to reference.
		return `/**
 * Action specifications indexed by method name.
 * These represent the complete action spec definitions.
 */
export const ActionSpecs = {} as const;
export interface ActionSpecs {}

export const action_specs: Array<ActionSpecUnion> = Object.values(ActionSpecs);`;
	}

	const qualify = resolve_spec_qualifier(imports, options);

	const value_lines = filtered.map((s) => `\t${s.method}: ${qualify(s)},`).join('\n');
	const type_lines = filtered.map((s) => `\t${s.method}: typeof ${qualify(s)};`).join('\n');

	return `/**
 * Action specifications indexed by method name.
 * These represent the complete action spec definitions.
 */
export const ActionSpecs = {
${value_lines}
} as const;
export interface ActionSpecs {
${type_lines}
}

export const action_specs: Array<ActionSpecUnion> = Object.values(ActionSpecs);`;
};

/**
 * Emit `ActionInputs` + `ActionOutputs` runtime consts and matching interfaces.
 * The runtime consts reference `specs.{method}_action_spec.input` /
 * `.output`; the interfaces use `z.infer`.
 *
 * Adds `import {z} from 'zod';` and the `* as specs` namespace import.
 *
 * @param options.qualify_spec - per-spec qualified identifier callback for
 *   multi-source consumers. The helper appends `.input` / `.output` to the
 *   callback's return value. When set, the helper skips the default
 *   `* as specs` import — the consumer manages its own namespace imports —
 *   and `specs_module` is ignored. Single-source consumers omit it.
 */
export const generate_action_inputs_outputs = (
	specs: ReadonlyArray<ActionSpecUnion>,
	imports: ImportBuilder,
	options?: {
		specs_module?: string;
		qualify_spec?: (spec: ActionSpecUnion) => string;
		include_composables?: boolean;
	},
): string => {
	const filtered = filter_composables(specs, options?.include_composables);

	if (filtered.length === 0) {
		// Empty spec list — emit minimal valid output and skip the `zod` /
		// `* as specs` imports that would have nothing to reference.
		return `/**
 * Action parameter schemas indexed by method name.
 * These represent the input data for each action,
 * e.g. JSON-RPC request/notification params and local call arguments.
 */
export const ActionInputs = {} as const;
export interface ActionInputs {}

/**
 * Action result schemas indexed by method name.
 * These represent the output data for each action,
 * e.g. JSON-RPC response results and local call return values.
 */
export const ActionOutputs = {} as const;
export interface ActionOutputs {}`;
	}

	imports.add('zod', 'z');
	const qualify = resolve_spec_qualifier(imports, options);

	const inputs_value = filtered.map((s) => `\t${s.method}: ${qualify(s)}.input,`).join('\n');
	const inputs_type = filtered
		.map((s) => `\t${s.method}: z.infer<typeof ${qualify(s)}.input>;`)
		.join('\n');
	const outputs_value = filtered.map((s) => `\t${s.method}: ${qualify(s)}.output,`).join('\n');
	const outputs_type = filtered
		.map((s) => `\t${s.method}: z.infer<typeof ${qualify(s)}.output>;`)
		.join('\n');

	return `/**
 * Action parameter schemas indexed by method name.
 * These represent the input data for each action,
 * e.g. JSON-RPC request/notification params and local call arguments.
 */
export const ActionInputs = {
${inputs_value}
} as const;
export interface ActionInputs {
${inputs_type}
}

/**
 * Action result schemas indexed by method name.
 * These represent the output data for each action,
 * e.g. JSON-RPC response results and local call return values.
 */
export const ActionOutputs = {
${outputs_value}
} as const;
export interface ActionOutputs {
${outputs_type}
}`;
};

/**
 * Emit the `ActionEventDatas` interface — one `ActionEvent*Data` variant per
 * method, parameterized by the spec's kind:
 * - `request_response` → `ActionEventRequestResponseData<method, input, output>`
 * - `remote_notification` → `ActionEventRemoteNotificationData<method, input>`
 * - `local_call` → `ActionEventLocalCallData<method, input, output>`
 *
 * Adds the per-kind data type imports (only the kinds that appear in `specs`).
 *
 * @param options.same_file - when `true` (default), assumes `ActionInputs` /
 *   `ActionOutputs` are in the same module as the emitted `ActionEventDatas`
 *   and adds no import (the zzz pattern, where `generate_action_inputs_outputs`
 *   and this helper feed the same `action_collections.ts` output). When
 *   `false`, adds `ActionInputs` / `ActionOutputs` type imports from
 *   `collections_path`.
 * @param options.collections_path - import path used when `same_file: false`.
 *   Defaults to `'./action_collections.js'`. Ignored when `same_file: true`
 *   — `same_file` is the file-layout switch; `collections_path` is just the
 *   path the import resolves to.
 */
export const generate_action_event_datas = (
	specs: ReadonlyArray<ActionSpecUnion>,
	imports: ImportBuilder,
	options?: {same_file?: boolean; collections_path?: string; include_composables?: boolean},
): string => {
	const filtered = filter_composables(specs, options?.include_composables);

	if (filtered.length === 0) {
		// Empty spec list — emit `interface ActionEventDatas {}` and skip
		// the optional collections-path import that would be unused.
		return `/**
 * Action event data types indexed by method name.
 * These represent the full discriminated union of all possible states
 * for each action's event data, properly typed with inputs and outputs.
 */
export interface ActionEventDatas {}`;
	}

	const same_file = options?.same_file ?? true;
	if (!same_file) {
		const collections_path = options?.collections_path ?? DEFAULT_COLLECTIONS_PATH;
		imports.add_types(collections_path, 'ActionInputs', 'ActionOutputs');
	}
	const lines = filtered.map((spec) => {
		const data_type =
			spec.kind === 'request_response'
				? 'ActionEventRequestResponseData'
				: spec.kind === 'remote_notification'
					? 'ActionEventRemoteNotificationData'
					: 'ActionEventLocalCallData';
		imports.add_type('@fuzdev/fuz_app/actions/action_event_data.js', data_type);
		const type_args =
			spec.kind === 'remote_notification'
				? `<'${spec.method}', ActionInputs['${spec.method}']>`
				: `<'${spec.method}', ActionInputs['${spec.method}'], ActionOutputs['${spec.method}']>`;
		return `\t${spec.method}: ${data_type}${type_args};`;
	});

	return `/**
 * Action event data types indexed by method name.
 * These represent the full discriminated union of all possible states
 * for each action's event data, properly typed with inputs and outputs.
 */
export interface ActionEventDatas {
${lines.join('\n')}
}`;
};

/**
 * Emit the `ActionsApi` interface — one method signature per spec via
 * `generate_actions_api_method_signature`. Optionally filter the spec set
 * (e.g. omit composable methods) via `method_filter`.
 *
 * Adds the `Result`, `JsonrpcErrorObject`, and `RpcClientCallOptions` type
 * imports plus `ActionInputs` / `ActionOutputs` (sourced from `collections_path`).
 */
export const generate_actions_api = (
	specs: ReadonlyArray<ActionSpecUnion>,
	imports: ImportBuilder,
	options?: {
		method_filter?: (spec: ActionSpecUnion) => boolean;
		collections_path?: string;
		sync_returns_value?: boolean;
		include_composables?: boolean;
	},
): string => {
	const composable_filtered = filter_composables(specs, options?.include_composables);
	const filter = options?.method_filter;
	const filtered = filter ? composable_filtered.filter((s) => filter(s)) : composable_filtered;

	const interface_doc = `/**
 * Interface for action dispatch functions.
 * Async methods (request_response, remote_notification, async local_call)
 * return \`Promise<Result<...>>\` and accept an optional \`RpcClientCallOptions\`
 * second arg that threads \`signal\`, \`transport_name\`, and \`queue\` through to
 * the peer. Sync local_call methods return values directly.
 */`;

	if (filtered.length === 0) {
		// Empty spec list — emit `ActionsApi {}` and skip every import. None
		// of the symbols would be referenced by the empty body.
		return `${interface_doc}
export interface ActionsApi {}`;
	}

	const collections_path = options?.collections_path ?? DEFAULT_COLLECTIONS_PATH;
	imports.add_type('@fuzdev/fuz_util/result.js', 'Result');
	imports.add_type('@fuzdev/fuz_app/http/jsonrpc.js', 'JsonrpcErrorObject');
	imports.add_type('@fuzdev/fuz_app/actions/rpc_client.js', 'RpcClientCallOptions');
	imports.add_types(collections_path, 'ActionInputs', 'ActionOutputs');

	const lines = filtered
		.map((spec) =>
			generate_actions_api_method_signature(spec, {
				sync_returns_value: options?.sync_returns_value,
			}),
		)
		.map((line) => `\t${line}`)
		.join('\n');

	return `${interface_doc}
export interface ActionsApi {
${lines}
}`;
};

/**
 * Emit the `FrontendActionHandlers` interface — wraps `generate_phase_handlers`
 * with the `TypedActionEvent` action-event type and standard 1-tab per-method
 * indentation. Pairs with `generate_typed_action_event_alias` (emits the
 * matching `TypedActionEvent` alias) — call both in the same gen producer.
 */
export const generate_frontend_action_handlers = (
	specs: ReadonlyArray<ActionSpecUnion>,
	imports: ImportBuilder,
	options?: {collections_path?: string; include_composables?: boolean},
): string => {
	const filtered = filter_composables(specs, options?.include_composables);
	const interface_doc = `/**
 * Frontend action handlers organized by method and phase.
 * Generated using spec.initiator to determine valid phases:
 * - initiator: 'frontend' → send/execute phases
 * - initiator: 'backend' → receive phases
 * - initiator: 'both' → all valid phases
 */`;

	if (filtered.length === 0) {
		// Empty spec list — emit `FrontendActionHandlers {}` and skip the
		// dangling `;` that the body template would otherwise produce.
		return `${interface_doc}
export interface FrontendActionHandlers {}`;
	}

	const handler_options = {
		action_event_type: 'TypedActionEvent',
		collections_path: options?.collections_path,
	};
	const lines = filtered
		.map((spec) => generate_phase_handlers(spec, 'frontend', imports, handler_options))
		.filter(Boolean)
		.map((block) => `\t${block}`)
		.join(';\n');

	return `${interface_doc}
export interface FrontendActionHandlers {
${lines};
}`;
};

/**
 * Emit BOTH the typed `BackendActionsApi` interface AND the
 * `broadcast_action_specs` runtime array. The interface is shaped for
 * `create_broadcast_api`: backend-initiated `remote_notification` methods,
 * each `(input) => Promise<void>`. The array bundles the matching specs as a
 * `ReadonlyArray<ActionSpecUnion>`.
 *
 * Filter: `kind === 'remote_notification' && initiator !== 'frontend'`.
 *
 * Adds the `* as specs` namespace import (from `specs_module`), the
 * `ActionInputs` type import (from `collections_path`), and the
 * `ActionSpecUnion` type import.
 *
 * @param options.qualify_spec - per-spec qualified identifier callback for
 *   multi-source consumers. When set, the helper emits the callback's return
 *   value instead of ``specs.${method}_action_spec`` in the broadcast array
 *   and skips the default `* as specs` import — the consumer manages its own
 *   namespace imports. `specs_module` is ignored when `qualify_spec` is set.
 *   Single-source consumers omit it.
 */
export const generate_backend_actions_api = (
	specs: ReadonlyArray<ActionSpecUnion>,
	imports: ImportBuilder,
	options?: {
		specs_module?: string;
		collections_path?: string;
		qualify_spec?: (spec: ActionSpecUnion) => string;
		include_composables?: boolean;
	},
): string => {
	const composable_filtered = filter_composables(specs, options?.include_composables);
	const broadcast = composable_filtered.filter(
		(s) => s.kind === 'remote_notification' && s.initiator !== 'frontend',
	);
	imports.add_type('@fuzdev/fuz_app/actions/action_spec.js', 'ActionSpecUnion');

	const interface_doc = `/**
 * Broadcast-style notifications from the backend to all connected clients.
 * Request-scoped streaming goes through \`ctx.notify\` instead — it's
 * socket-scoped, not a broadcast.
 */`;

	if (broadcast.length === 0) {
		// No backend-initiated remote_notifications — skip `* as specs` and
		// `ActionInputs` imports that would have nothing to reference.
		return `${interface_doc}
export interface BackendActionsApi {}

export const broadcast_action_specs: ReadonlyArray<ActionSpecUnion> = [];`;
	}

	const collections_path = options?.collections_path ?? DEFAULT_COLLECTIONS_PATH;
	imports.add_type(collections_path, 'ActionInputs');
	const qualify = resolve_spec_qualifier(imports, options);

	const interface_body =
		'\n' +
		broadcast
			.map((s) => `\t${s.method}: (input: ActionInputs['${s.method}']) => Promise<void>;`)
			.join('\n') +
		'\n';
	const array_body = '\n' + broadcast.map((s) => `\t${qualify(s)},`).join('\n') + '\n';

	return `${interface_doc}
export interface BackendActionsApi {${interface_body}}

export const broadcast_action_specs: ReadonlyArray<ActionSpecUnion> = [${array_body}];`;
};
