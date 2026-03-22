import {UnreachableError} from '@fuzdev/fuz_util/error.js';

import type {ActionSpecUnion, ActionEventPhase} from './action_spec.js';

// TODO @action-system-review Refactor into more reusable and more app-specific helpers/config,
// maybe `import_builder.ts` and `gen_helpers.ts`. Revisit when saes-rpc quest lands.

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

/**
 * Gets the handler return type for a specific phase and spec.
 * Also adds necessary imports to the `ImportBuilder`.
 */
export const get_handler_return_type = (
	spec: ActionSpecUnion,
	phase: ActionEventPhase,
	imports: ImportBuilder,
	path_prefix: string,
): string => {
	// For request_response receive_request, handler returns the output
	if (spec.kind === 'request_response' && phase === 'receive_request') {
		imports.add_type(`${path_prefix}action_collections.js`, 'ActionOutputs');
		const base_type = `ActionOutputs['${spec.method}']`;
		// Request/response actions are always async
		return `${base_type} | Promise<${base_type}>`;
	}

	// For local_call execute, handler returns the output
	if (spec.kind === 'local_call' && phase === 'execute') {
		imports.add_type(`${path_prefix}action_collections.js`, 'ActionOutputs');
		const base_type = `ActionOutputs['${spec.method}']`;
		return spec.async ? `${base_type} | Promise<${base_type}>` : base_type;
	}

	// All other phases return void
	return 'void | Promise<void>';
};

/**
 * Generates the phase handlers for an action spec using the unified ActionEvent type
 * with the new phase/step type parameters.
 */
export const generate_phase_handlers = (
	spec: ActionSpecUnion,
	executor: 'frontend' | 'backend',
	imports: ImportBuilder,
): string => {
	const {method} = spec;
	const phases = get_executor_phases(spec, executor);

	if (phases.length === 0) {
		return `${method}?: never`;
	}

	// Add necessary imports for the unified system
	// Backend types file is in server/ subdirectory, so needs different relative paths
	const path_prefix = executor === 'frontend' ? './' : '../';
	imports.add_type(`${path_prefix}action_event.js`, 'ActionEvent');

	// Add environment type import
	const environment_type = executor === 'frontend' ? 'Frontend' : 'Backend';
	const environment_module = executor === 'frontend' ? './frontend.svelte.js' : './backend.js';
	imports.add_type(environment_module, environment_type);

	// Generate handler definitions for each phase
	const phase_handlers = phases
		.map((phase: ActionEventPhase) => {
			// Pass imports to get_handler_return_type so it can add necessary imports
			const return_type = get_handler_return_type(spec, phase, imports, path_prefix);
			// Use the new type parameter approach
			return `${phase}?: (
			action_event: ActionEvent<'${method}', ${environment_type}, '${phase}', 'handling'>
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
