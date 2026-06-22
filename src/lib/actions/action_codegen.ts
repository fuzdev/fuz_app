import {UnreachableError} from '@fuzdev/fuz_util/error.ts';
import {zod_get_base_type} from '@fuzdev/fuz_util/zod.ts';

import type {ActionSpecUnion, ActionEventPhase} from './action_spec.ts';
import {ActionRegistry} from './action_registry.ts';

/**
 * Method names of fuz_app's protocol actions — `heartbeat` (auth-aware client
 * liveness probe) and `cancel` (request-scoped abort signal). Consumers spread
 * this list when filtering backend request_response methods so the
 * dispatcher-owned protocol actions don't show up in
 * `BackendRequestResponseMethod` / handler maps. Pairs with `protocol_actions`
 * / `protocol_action_specs` from `actions/protocol.ts` (the runtime bundles).
 */
export const PROTOCOL_ACTION_METHODS = ['heartbeat', 'cancel'] as const;

/** Methods that ship from fuz_app, kept out of consumer-owned method enums + handler maps. */
export type ProtocolActionMethod = (typeof PROTOCOL_ACTION_METHODS)[number];

const PROTOCOL_METHOD_SET: ReadonlySet<string> = new Set(PROTOCOL_ACTION_METHODS);

/**
 * Type predicate for filtering protocol-action methods out of a typed
 * `FrontendActionsApi` `method_filter`. Avoids the `(... as never)` cast
 * required to call `Array.prototype.includes` on the readonly tuple at narrow
 * string types.
 *
 * @example
 * generate_frontend_actions_api(specs, imports, {
 *   method_filter: (s) => !is_protocol_action_method(s.method),
 * });
 */
export const is_protocol_action_method = (method: string): method is ProtocolActionMethod =>
	PROTOCOL_METHOD_SET.has(method);

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
 * imports.add_types('./types.ts', 'Foo', 'Bar');
 * imports.add('./utils.ts', 'helper');
 * imports.add_type('./utils.ts', 'HelperOptions');
 * imports.add('./action_specs.ts', '* as specs');
 *
 * // Generates:
 * // import type {Foo, Bar} from './types.ts';
 * // import {helper, type HelperOptions} from './utils.ts';
 * // import * as specs from './action_specs.ts';
 * ```
 */
export class ImportBuilder {
	imports: Map<string, Map<string, ImportItem>> = new Map();

	/**
	 * Add a value import. Accepts `* as ns` strings as namespace imports.
	 *
	 * @returns `this` for chaining
	 * @mutates this - inserts into the internal `imports` map
	 */
	add(from: string, what: string): this {
		// Handle namespace imports specially
		if (what.startsWith('* as ')) {
			return this.#add_import(from, what, 'namespace');
		}
		return this.#add_import(from, what, 'value');
	}

	/**
	 * Add a type-only import.
	 *
	 * @returns `this` for chaining
	 * @mutates this - inserts into the internal `imports` map (downgrade to
	 *   type is suppressed if already registered as a value)
	 */
	add_type(from: string, what: string): this {
		return this.#add_import(from, what, 'type');
	}

	add_many(from: string, ...items: Array<string>): this {
		for (const item of items) {
			this.add(from, item);
		}
		return this;
	}

	add_types(from: string, ...items: Array<string>): this {
		for (const item of items) {
			this.add_type(from, item);
		}
		return this;
	}

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
	 * Generate the import statements. When every import from a module is a
	 * type, emits `import type {…}` so the whole statement disappears at
	 * compile time.
	 */
	build(): string {
		return this.#generate_import_statements().join('\n');
	}

	has_imports(): boolean {
		return this.imports.size > 0;
	}

	get import_count(): number {
		return this.imports.size;
	}

	/** Build the same statement list as `build` without joining — for inspection in tests. */
	preview(): Array<string> {
		return this.#generate_import_statements();
	}

	/**
	 * Clear all imports.
	 *
	 * @returns `this` for chaining
	 * @mutates this - empties the internal `imports` map
	 */
	clear(): this {
		this.imports.clear();
		return this;
	}

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

/** Phases an executor can handle for the given spec — kind + initiator → set of phases. */
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
						// Backend's receive branch needs `send_error` for the failure
						// path on incoming requests; only push when the send branch
						// hasn't already added it (`initiator: 'both'`).
						if (!can_send) phases.push('send_error');
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

	return phases;
};

/** Default `collections_path` — every consumer's gen producers point at the sibling `action_collections.ts`. */
export const DEFAULT_COLLECTIONS_PATH = './action_collections.ts';

/** Default `specs_module` — sibling `action_specs.ts` namespace bundled by the consumer. */
export const DEFAULT_SPECS_MODULE = './action_specs.ts';

/** Default `metatypes_path` — sibling `action_metatypes.ts` carrying the generated `ActionMethod`. */
export const DEFAULT_METATYPES_PATH = './action_metatypes.ts';

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
 * Returns `''` when the spec contributes no phases on the given executor side
 * (e.g. a backend-only `local_call` asked for `'frontend'`). Upstream wrappers
 * compose blocks with `.filter(Boolean)` so empty entries are dropped from the
 * generated handler map. The earlier shape was `${method}?: never`, which read
 * as "calling this here is a type error" but in practice produced useless rows
 * on `FrontendActionHandlers` for methods that don't belong on this side at
 * all — drop the row instead so the typed surface only carries methods the
 * executor actually handles.
 *
 * @param options.action_event_type - custom type name to use instead of `ActionEvent`
 *   (consumers can define a narrowed type that carries typed input/output via their codegen maps)
 * @param options.collections_path - Import path the side-effect `ActionOutputs` import
 *   resolves to. Defaults to `'./action_collections.ts'`.
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
		return '';
	}

	const action_event_type = options?.action_event_type ?? 'ActionEvent';
	const collections_path = options?.collections_path ?? DEFAULT_COLLECTIONS_PATH;

	// Only add the default ActionEvent import if using the default type name
	if (action_event_type === 'ActionEvent') {
		imports.add_type('@fuzdev/fuz_app/actions/action_event.ts', 'ActionEvent');
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

/** "DO NOT EDIT" banner naming the gen producer. */
export const create_banner = (origin_path: string): string =>
	`generated by ${origin_path} - DO NOT EDIT OR RISK LOST DATA`;

// TODO rethink these, see also zzz `codegen.ts`
export const to_action_spec_identifier = (method: string): string => `${method}_action_spec`;
export const to_action_spec_input_identifier = (method: string): string =>
	`${to_action_spec_identifier(method)}.input`;
export const to_action_spec_output_identifier = (method: string): string =>
	`${to_action_spec_identifier(method)}.output`;

/**
 * Generates one method line of the typed `FrontendActionsApi` interface for a
 * single spec. Encapsulates the input/options/return-type signature shape so
 * the surface evolves in one place when fields like `signal` or
 * `transport_name` are added to per-call options.
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
 * Registers exactly the imports the emitted line references on `imports`:
 * `ActionInputs` (when the spec has input), `ActionOutputs` (always),
 * `RpcClientCallOptions` (async only), and `Result` + `JsonrpcErrorObject`
 * (any return shape that wraps the value in `Result<{value}, {error}>` —
 * every async method, plus sync `local_call` when `sync_returns_value:
 * false`). Mirrors the leaf-level pattern `get_handler_return_type` already
 * follows so wrappers no longer pre-register imports a per-spec emit might
 * not actually use.
 *
 * **Optional-input detection.** The emitted parameter is `input?:` (caller
 * may omit the argument) when either (a) the schema accepts `undefined` —
 * `z.optional(z.strictObject(...))` and similar wrappers — or (b) the
 * schema accepts the empty object `{}` — `z.strictObject({acting:
ActingActor})` and other all-optional-fields strict objects. The second
 * probe mirrors the dispatcher's HTTP convention (`raw_params ?? {}` for
 * non-`z.void()` schemas in `actions/action_rpc.ts` / `http/route_spec.ts`):
 * if a request with no params reaches the handler, this is the value the
 * schema is asked to validate. A schema with required fields fails both
 * probes and stays `input:` (required at the typed surface). Refinements
 * and transforms run as part of `safeParse`, so their accept/reject
 * decisions feed into the optional/required choice naturally.
 *
 * @param options.sync_returns_value - When true (default), sync `local_call`
 *   methods return the output value directly; when false they're wrapped in
 *   `Result<{value, error}>` like async methods. Set to `false` if your
 *   `FrontendActionsApi` treats every method uniformly.
 * @param options.collections_path - Import path that `ActionInputs` /
 *   `ActionOutputs` resolve to. Defaults to `'./action_collections.ts'`.
 * @returns one line like `foo: (input: ActionInputs['foo'], options?: RpcClientCallOptions) => Promise<Result<...>>;`
 */
export const generate_actions_api_method_signature = (
	spec: ActionSpecUnion,
	imports: ImportBuilder,
	options?: {sync_returns_value?: boolean; collections_path?: string},
): string => {
	const sync_returns_value = options?.sync_returns_value ?? true;
	const collections_path = options?.collections_path ?? DEFAULT_COLLECTIONS_PATH;
	const innermost_type_name = zod_get_base_type(spec.input);
	const has_input = innermost_type_name !== 'null' && innermost_type_name !== 'void';
	const input_optional =
		has_input && (spec.input.safeParse(undefined).success || spec.input.safeParse({}).success);
	const input_param = has_input
		? `input${input_optional ? '?' : ''}: ActionInputs['${spec.method}']`
		: 'input?: void';
	if (has_input) imports.add_type(collections_path, 'ActionInputs');
	imports.add_type(collections_path, 'ActionOutputs');

	const is_async =
		spec.kind === 'request_response' || spec.kind === 'remote_notification' || spec.async;
	const options_param = is_async ? ', options?: RpcClientCallOptions' : '';
	if (is_async) {
		imports.add_type('@fuzdev/fuz_app/actions/rpc_client.ts', 'RpcClientCallOptions');
	}

	const result_return = `Result<{value: ActionOutputs['${
		spec.method
	}']}, {error: JsonrpcErrorObject}>`;
	const return_type = is_async
		? `Promise<${result_return}>`
		: sync_returns_value
			? `ActionOutputs['${spec.method}']`
			: result_return;
	const wraps_in_result = is_async || !sync_returns_value;
	if (wraps_in_result) {
		imports.add_type('@fuzdev/fuz_util/result.ts', 'Result');
		imports.add_type('@fuzdev/fuz_app/http/jsonrpc.ts', 'JsonrpcErrorObject');
	}

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
// `all_role_grant_offer_action_specs` / `all_account_action_specs` /
// `all_self_service_role_action_specs` from fuz_app). When `qualify_spec` is
// set, the helper does NOT add a `* as specs` import — the consumer manages
// the multiple `* as ns` imports itself — and `specs_module` is ignored.
// `create_namespace_qualifier` automates the source-table → qualifier wiring.
// --------------------------------------------------------------------------

/**
 * Format a `z.enum([...])` runtime const + matching `z.infer` type alias.
 * Caller is responsible for ensuring `methods` is non-empty (`z.enum([])` is
 * invalid) and registering the `zod` import on the `ImportBuilder`.
 */
const format_method_enum_block = (
	name: string,
	jsdoc: string,
	methods: ReadonlyArray<string>,
): string => {
	const lines = methods.map((m) => `\t'${m}',`).join('\n');
	return `/**
 * ${jsdoc}
 */
export const ${name} = z.enum([
${lines}
]);
export type ${name} = z.infer<typeof ${name}>;`;
};

/** Discriminator for `generate_action_method_enums` — which method-set enums to emit. */
export type ActionMethodEnumKind =
	| 'all'
	| 'request_response'
	| 'remote_notification'
	| 'local_call'
	| 'frontend'
	| 'backend'
	| 'frontend_handled'
	| 'backend_handled'
	| 'broadcast';

/** Default emit set — every enum kind. */
export const action_method_enum_kinds_all: ReadonlySet<ActionMethodEnumKind> = new Set([
	'all',
	'request_response',
	'remote_notification',
	'local_call',
	'frontend',
	'backend',
	'frontend_handled',
	'backend_handled',
	'broadcast',
]);

/**
 * Filter `heartbeat` / `cancel` out of `specs` unless the consumer opts back in.
 * Protocol actions ship from fuz_app and are spread into every consumer's
 * `actions` array at registration time (via `protocol_actions` from
 * `actions/protocol.ts`) — they should not appear in consumer-owned typed
 * surfaces (`ActionMethod`, `FrontendActionsApi`, `ActionInputs`, etc.) by
 * default.
 */
const filter_protocol_actions = (
	specs: ReadonlyArray<ActionSpecUnion>,
	include_protocol_actions: boolean | undefined,
): ReadonlyArray<ActionSpecUnion> =>
	include_protocol_actions ? specs : specs.filter((s) => !is_protocol_action_method(s.method));

/**
 * Resolve a per-spec identifier qualifier with the standard default-vs-callback
 * dance. When `qualify_spec` is set, returns the caller's callback verbatim
 * and registers no imports — the caller owns its namespace setup (the
 * multi-source case where specs come from several modules). Otherwise,
 * registers `* as specs from specs_module` (defaulting to
 * `'./action_specs.ts'`) on `imports` and returns
 * `(spec) => 'specs.' + to_action_spec_identifier(spec.method)`.
 *
 * Used internally by every multi-source-aware helper in this module
 * (`generate_action_specs_record`, `generate_action_inputs_outputs`,
 * `generate_backend_actions_api`); exported so consumers writing their own
 * codegen helpers can reuse the same defaulting + import-registration
 * behavior instead of reimplementing it.
 */
export const resolve_spec_qualifier = (
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
 * `LocalCallActionMethod`, `FrontendActionMethod`, `BackendActionMethod`,
 * `FrontendRequestResponseMethod`, `BackendRequestResponseMethod`,
 * `BroadcastActionMethod`. Pairs each runtime const with a `z.infer` type
 * alias under the same identifier.
 *
 * Protocol-action methods (`heartbeat`, `cancel`) are filtered out by
 * default — pass `include_protocol_actions: true` if a consumer genuinely
 * wants them on their typed surface. Empty kinds are skipped so the helper
 * never emits `z.enum([])` (zod runtime-throws on that).
 *
 * Adds `import {z} from 'zod';` to `imports` only when at least one block
 * is emitted (idempotent).
 *
 * For genuinely cross-product enums the discriminator doesn't cover, use
 * `generate_action_method_enum_block` — caller owns the predicate, name,
 * and jsdoc.
 *
 * @param options.emit - subset of enums to emit; defaults to all nine.
 * @param options.include_protocol_actions - when true, retains `heartbeat` /
 *   `cancel` in the emitted enums. Default `false`.
 */
export const generate_action_method_enums = (
	specs: ReadonlyArray<ActionSpecUnion>,
	imports: ImportBuilder,
	options?: {emit?: ReadonlySet<ActionMethodEnumKind>; include_protocol_actions?: boolean},
): string => {
	const emit = options?.emit ?? action_method_enum_kinds_all;
	const filtered = filter_protocol_actions(specs, options?.include_protocol_actions);
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
		blocks.push(format_method_enum_block(name, jsdoc, methods));
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
	// Loose: every spec the side might encounter (call, receive, or execute).
	// Drives the typed-Proxy method enum keyed by FrontendActionsApi.
	emit_block(
		'frontend',
		'FrontendActionMethod',
		registry.methods_relevant_to_frontend,
		'Names of all actions in the typed FrontendActionsApi surface — every spec the frontend may encounter (call, receive, or execute locally).',
	);
	emit_block(
		'backend',
		'BackendActionMethod',
		registry.methods_relevant_to_backend,
		'Names of all actions the backend may encounter — request_response and remote_notification (local_call is frontend-only).',
	);
	// Narrow: request_response actions this side handles (receives).
	emit_block(
		'frontend_handled',
		'FrontendRequestResponseMethod',
		registry.frontend_handled_methods,
		'Names of request_response actions the frontend handles (initiator excludes frontend).',
	);
	emit_block(
		'backend_handled',
		'BackendRequestResponseMethod',
		registry.backend_handled_methods,
		'Names of request_response actions the backend handles (initiator excludes backend).',
	);
	// Broadcast: backend-initiated remote_notification, excluding `streams` targets.
	emit_block(
		'broadcast',
		'BroadcastActionMethod',
		registry.broadcast_methods,
		"Names of remote_notification actions exposed by the broadcast API (backend-initiated, excluding request-scoped progress notifications named by another action's `streams`).",
	);

	if (blocks.length === 0) return '';
	imports.add('zod', 'z');
	return blocks.join('\n\n');
};

/**
 * Emit a single named `z.enum([...])` + `z.infer` block for an arbitrary
 * spec subset. Lower-level escape hatch from `generate_action_method_enums` —
 * for cross-product or domain-specific enums the built-in discriminator
 * doesn't cover.
 *
 * Mirrors the built-in helper's contract: protocol actions filtered by
 * default, empty subsets return `''` (skip rather than emit `z.enum([])`),
 * `zod` import registered idempotently only when at least one method
 * qualifies.
 *
 * The cross-product space is open-ended; rather than grow the
 * `ActionMethodEnumKind` discriminator one cross-product at a time, callers
 * own the subset shape — name, jsdoc, predicate.
 */
export const generate_action_method_enum_block = (
	specs: ReadonlyArray<ActionSpecUnion>,
	imports: ImportBuilder,
	options: {
		name: string;
		jsdoc: string;
		predicate: (spec: ActionSpecUnion) => boolean;
		include_protocol_actions?: boolean;
	},
): string => {
	const filtered = filter_protocol_actions(specs, options.include_protocol_actions);
	const methods = filtered.filter(options.predicate).map((s) => s.method);
	if (methods.length === 0) return '';
	imports.add('zod', 'z');
	return format_method_enum_block(options.name, options.jsdoc, methods);
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
	imports.add_type('@fuzdev/fuz_app/actions/action_event.ts', 'ActionEvent');
	imports.add_type('@fuzdev/fuz_app/actions/action_spec.ts', 'ActionEventPhase');
	imports.add_type('@fuzdev/fuz_app/actions/action_event_types.ts', 'ActionEventStep');
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
		include_protocol_actions?: boolean;
	},
): string => {
	const filtered = filter_protocol_actions(specs, options?.include_protocol_actions);
	imports.add_type('@fuzdev/fuz_app/actions/action_spec.ts', 'ActionSpecUnion');

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
		include_protocol_actions?: boolean;
	},
): string => {
	const filtered = filter_protocol_actions(specs, options?.include_protocol_actions);

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
 *   Defaults to `'./action_collections.ts'`. Ignored when `same_file: true`
 *   — `same_file` is the file-layout switch; `collections_path` is just the
 *   path the import resolves to.
 */
export const generate_action_event_datas = (
	specs: ReadonlyArray<ActionSpecUnion>,
	imports: ImportBuilder,
	options?: {same_file?: boolean; collections_path?: string; include_protocol_actions?: boolean},
): string => {
	const filtered = filter_protocol_actions(specs, options?.include_protocol_actions);

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
		imports.add_type('@fuzdev/fuz_app/actions/action_event_data.ts', data_type);
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
 * Emit the `FrontendActionsApi` interface — one method signature per spec via
 * `generate_actions_api_method_signature`. Optionally filter the spec set
 * (e.g. omit additional methods alongside the default protocol-action
 * filter) via `method_filter`.
 *
 * Imports are registered by the leaf `generate_actions_api_method_signature`
 * per emitted line — only what the spec set actually references shows up on
 * `imports`. A spec set with no async methods skips `RpcClientCallOptions`;
 * one with no inputs skips `ActionInputs`; sync `local_call` methods with
 * `sync_returns_value: true` (the default) skip `Result` / `JsonrpcErrorObject`.
 *
 * The interface name is fixed at `FrontendActionsApi` — the symmetric counterpart
 * of `BackendActionsApi`. Earlier consumer-named variants (`MyActionsApi`,
 * `VisionesActionsApi`) were retired in API review III to make the side-of-the-wire
 * intent visible at every call site. If a consumer needs a different name they
 * hand-roll the interface (the helper's job is the standard symmetric shape).
 */
export const generate_frontend_actions_api = (
	specs: ReadonlyArray<ActionSpecUnion>,
	imports: ImportBuilder,
	options?: {
		method_filter?: (spec: ActionSpecUnion) => boolean;
		collections_path?: string;
		sync_returns_value?: boolean;
		include_protocol_actions?: boolean;
	},
): string => {
	const protocol_filtered = filter_protocol_actions(specs, options?.include_protocol_actions);
	const filter = options?.method_filter;
	const filtered = filter ? protocol_filtered.filter((s) => filter(s)) : protocol_filtered;

	const interface_doc = `/**
 * Typed dispatch surface for the frontend's RPC client. Symmetric counterpart
 * of \`BackendActionsApi\`. Async methods (request_response, remote_notification,
 * async local_call) return \`Promise<Result<...>>\` and accept an optional
 * \`RpcClientCallOptions\` second arg that threads \`signal\`, \`transport_name\`,
 * and \`queue\` through to the peer. Sync local_call methods return values
 * directly.
 */`;

	if (filtered.length === 0) {
		// Empty spec list — emit `FrontendActionsApi {}` and skip every import.
		// None of the symbols would be referenced by the empty body.
		return `${interface_doc}
export interface FrontendActionsApi {}`;
	}

	const lines = filtered
		.map((spec) =>
			generate_actions_api_method_signature(spec, imports, {
				sync_returns_value: options?.sync_returns_value,
				collections_path: options?.collections_path,
			}),
		)
		.map((line) => `\t${line}`)
		.join('\n');

	return `${interface_doc}
export interface FrontendActionsApi {
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
	options?: {collections_path?: string; include_protocol_actions?: boolean},
): string => {
	const filtered = filter_protocol_actions(specs, options?.include_protocol_actions);
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
 * Filter: `kind === 'remote_notification' && initiator !== 'frontend'`,
 * additionally excluding methods that are the target of another spec's
 * `streams` field. Streams targets (e.g. `completion_progress`,
 * `ollama_progress`) are request-scoped notifications invoked via
 * `ctx.notify` inside their parent handler — they're never callable through
 * the broadcast API. The discriminator is `ActionSpec.streams`, not a manual
 * exclusion list.
 *
 * Adds the `* as specs` namespace import (from `specs_module`), the
 * `ActionInputs` type import (from `collections_path`), and the
 * `ActionSpecUnion` type import.
 *
 * Method signature shape today is `(input) => Promise<void>` — matches the
 * fire-and-forget runtime of `create_broadcast_api`. Generalizing per-kind
 * via `generate_actions_api_method_signature` is deferred until a second
 * backend runtime constructor lands.
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
		include_protocol_actions?: boolean;
	},
): string => {
	const protocol_filtered = filter_protocol_actions(specs, options?.include_protocol_actions);
	const registry = new ActionRegistry([...protocol_filtered]);
	const broadcast = registry.broadcast_specs;
	imports.add_type('@fuzdev/fuz_app/actions/action_spec.ts', 'ActionSpecUnion');

	const interface_doc = `/**
 * Typed dispatch surface for backend-initiated calls. Symmetric counterpart
 * of \`FrontendActionsApi\`. Today exposes broadcast-style \`remote_notification\`
 * methods (1→N fan-out via \`create_broadcast_api\`); request-scoped streaming
 * goes through \`ctx.notify\` inside a handler — it's socket-scoped, not a
 * broadcast. Will widen when a second backend runtime constructor (targeted
 * send, backend-initiated request_response) lands.
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

/**
 * Emit the `BackendActionHandlers` mapped type — one entry per
 * `BackendRequestResponseMethod`, each `(input, ctx) => output | Promise<output>`.
 * Replaces the hand-maintained `Exclude<>` + parallel mapped-type pattern
 * (zzz had this at `zzz/src/lib/server/zzz_action_handlers.ts:42-66`).
 *
 * The context type is consumer-defined (e.g. zzz's `ZzzHandlerContext`). Pass
 * `context_type` to name it; the helper assumes it's importable or defined
 * in the emitted module's scope (consumer's responsibility).
 *
 * Adds `ActionInputs` / `ActionOutputs` type imports from `collections_path`
 * and the `BackendRequestResponseMethod` import from `metatypes_path`.
 *
 * @param options.type_name - default `'BackendActionHandlers'`.
 * @param options.method_enum_name - default `'BackendRequestResponseMethod'`.
 *   Pair with `generate_action_method_enums` emitting the `'backend_handled'` kind.
 * @param options.context_type - default `'BackendHandlerContext'`. Caller's
 *   handler context type — must be in scope at the emit site.
 * @param options.collections_path - default `'./action_collections.ts'`.
 * @param options.metatypes_path - default `'./action_metatypes.ts'`.
 */
export const generate_backend_action_handlers_map = (
	imports: ImportBuilder,
	options?: {
		type_name?: string;
		method_enum_name?: string;
		context_type?: string;
		collections_path?: string;
		metatypes_path?: string;
	},
): string => {
	const type_name = options?.type_name ?? 'BackendActionHandlers';
	const method_enum_name = options?.method_enum_name ?? 'BackendRequestResponseMethod';
	const context_type = options?.context_type ?? 'BackendHandlerContext';
	const collections_path = options?.collections_path ?? DEFAULT_COLLECTIONS_PATH;
	const metatypes_path = options?.metatypes_path ?? DEFAULT_METATYPES_PATH;

	imports.add_types(collections_path, 'ActionInputs', 'ActionOutputs');
	imports.add_type(metatypes_path, method_enum_name);

	return `/**
 * Typed handler map for request_response actions the backend handles.
 * One entry per ${method_enum_name}; each handler receives the typed input
 * and returns the typed output (sync or async).
 */
export type ${type_name} = {
	[K in ${method_enum_name}]: (
		input: ActionInputs[K],
		ctx: ${context_type},
	) => ActionOutputs[K] | Promise<ActionOutputs[K]>;
};`;
};

// --------------------------------------------------------------------------
// Wrapper + multi-source helper
// --------------------------------------------------------------------------

/**
 * One source in a multi-source consumer's namespace map. `ns` is the local
 * alias used inside the generated file; `module` is the import path; `specs`
 * is the runtime spec array. `create_namespace_qualifier` consumes a list of
 * these.
 */
export interface SpecSource {
	ns: string;
	module: string;
	specs: ReadonlyArray<ActionSpecUnion>;
}

/**
 * Multi-source consumer helper. Takes a list of `{ns, module, specs}` rows,
 * registers `import * as ns from module` for each on `imports`, builds the
 * `method_to_ns` lookup with duplicate-method detection, and returns
 * `{qualify_spec, all_specs}` ready to thread through the high-level
 * helpers.
 *
 * Closes the per-file boilerplate gap that kept tx + visiones on hand-rolled
 * template strings even after `qualify_spec?` landed in API review II — the
 * per-call callback wasn't enough; the import dance + dup-check was the
 * real boilerplate.
 *
 * @throws Error if two sources contain the same method name (same-method
 *   detection is the consumer's primary debugging signal). Also throws if
 *   the returned `qualify_spec` is later called with a method not registered
 *   in any source.
 *
 * @example
 * ```ts
 * const sources = [
 *   {ns: 'tx_specs', module: './action_specs.ts', specs: all_zap_action_specs},
 *   {ns: 'admin_specs', module: '@fuzdev/fuz_app/auth/admin_action_specs.ts', specs: all_admin_action_specs},
 * ];
 *
 * export const gen: Gen = ({origin_path}) => {
 *   const imports = new ImportBuilder();
 *   const {qualify_spec, all_specs} = create_namespace_qualifier(sources, imports);
 *   return compose_gen_file({
 *     origin_path,
 *     imports,
 *     blocks: [
 *       generate_action_specs_record(all_specs, imports, {qualify_spec}),
 *       generate_action_inputs_outputs(all_specs, imports, {qualify_spec}),
 *     ],
 *   });
 * };
 * ```
 */
export const create_namespace_qualifier = (
	sources: ReadonlyArray<SpecSource>,
	imports: ImportBuilder,
): {
	qualify_spec: (spec: ActionSpecUnion) => string;
	all_specs: ReadonlyArray<ActionSpecUnion>;
} => {
	const method_to_ns = new Map<string, string>();
	const all_specs: Array<ActionSpecUnion> = [];

	for (const {ns, module, specs} of sources) {
		imports.add(module, `* as ${ns}`);
		for (const spec of specs) {
			if (method_to_ns.has(spec.method)) {
				throw new Error(
					`duplicate action method across sources: ${spec.method} (in ${method_to_ns.get(
						spec.method,
					)} and ${ns})`,
				);
			}
			method_to_ns.set(spec.method, ns);
			all_specs.push(spec);
		}
	}

	const qualify_spec = (spec: ActionSpecUnion): string => {
		const ns = method_to_ns.get(spec.method);
		if (!ns) {
			throw new Error(
				`unknown action method passed to qualify_spec: ${
					spec.method
				} — not in any registered source`,
			);
		}
		return `${ns}.${spec.method}_action_spec`;
	};

	return {qualify_spec, all_specs};
};

/**
 * Wrap the per-`*.gen.ts` boilerplate (banner + `imports.build()` +
 * blocks join + template literal) into one call. Returns the full file body
 * as a string ready to return from a `Gen` function.
 *
 * Each consumer producer collapses to one `compose_gen_file` call wrapping
 * the helper invocations.
 *
 * @example
 * ```ts
 * export const gen: Gen = ({origin_path}) => {
 *   const imports = new ImportBuilder();
 *   return compose_gen_file({
 *     origin_path,
 *     imports,
 *     blocks: [
 *       generate_action_specs_record(all_action_specs, imports),
 *       generate_action_inputs_outputs(all_action_specs, imports),
 *       generate_action_event_datas(all_action_specs, imports),
 *     ],
 *   });
 * };
 * ```
 *
 * Empty blocks (`''`) are filtered out so helpers that short-circuit on
 * empty spec sets don't introduce stray double blank lines.
 */
export const compose_gen_file = (input: {
	origin_path: string;
	imports: ImportBuilder;
	blocks: ReadonlyArray<string>;
}): string => {
	const banner = create_banner(input.origin_path);
	const body = input.blocks.filter(Boolean).join('\n\n');
	return `
		// ${banner}

		${input.imports.build()}

		${body}

		// ${banner}
	`;
};
