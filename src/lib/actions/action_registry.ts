/**
 * `ActionRegistry` — query and filter utility over `ActionSpecUnion[]`.
 *
 * @module
 */

import type {
	ActionSpecUnion,
	RequestResponseActionSpec,
	RemoteNotificationActionSpec,
	LocalCallActionSpec,
} from './action_spec.js';

// TODO @action-system-review Many getters below are stub API surface — only `spec_by_method`,
// `request_response_specs`, `remote_notification_specs`, `local_call_specs`,
// `frontend_methods`, `backend_methods`, and `methods` are used by consumers (codegen).
// The rest are pre-built for future use. Revisit which getters to keep when the action
// system matures (saes-rpc quest). Also consider lazy memoization (`??=` or derived).

/**
 * Utility class to manage and query action specifications.
 * Provides helper methods to get actions by various criteria.
 */
export class ActionRegistry {
	readonly specs: Array<ActionSpecUnion>;

	constructor(specs: Array<ActionSpecUnion>) {
		this.specs = specs;
	}

	get spec_by_method(): Map<string, ActionSpecUnion> {
		return new Map(this.specs.map((spec) => [spec.method, spec]));
	}

	get request_response_specs(): Array<RequestResponseActionSpec> {
		return this.specs.filter((spec) => spec.kind === 'request_response');
	}

	get remote_notification_specs(): Array<RemoteNotificationActionSpec> {
		return this.specs.filter((spec) => spec.kind === 'remote_notification');
	}

	get local_call_specs(): Array<LocalCallActionSpec> {
		return this.specs.filter((spec) => spec.kind === 'local_call');
	}

	// TODO @action-system-review `backend_specs` filters out local_call (can't run on backend);
	// `frontend_specs` returns all specs (all action kinds are relevant to the frontend).
	// Revisit whether these filters are correct as the action system matures.
	get backend_specs(): Array<ActionSpecUnion> {
		return this.specs.filter((spec) => spec.kind !== 'local_call');
	}

	get frontend_specs(): Array<ActionSpecUnion> {
		return this.specs;
	}

	get backend_to_frontend_specs(): Array<ActionSpecUnion> {
		return this.specs.filter((spec) => spec.initiator === 'backend' || spec.initiator === 'both');
	}

	get frontend_to_backend_specs(): Array<ActionSpecUnion> {
		return this.specs.filter((spec) => spec.initiator === 'frontend' || spec.initiator === 'both');
	}

	get public_specs(): Array<ActionSpecUnion> {
		return this.specs.filter((spec) => spec.auth === 'public');
	}

	get authenticated_specs(): Array<ActionSpecUnion> {
		return this.specs.filter((spec) => spec.auth === 'authenticated');
	}

	get methods(): Array<string> {
		return this.specs.map((spec) => spec.method);
	}

	get request_response_methods(): Array<string> {
		return this.request_response_specs.map((spec) => spec.method);
	}

	get remote_notification_methods(): Array<string> {
		return this.remote_notification_specs.map((spec) => spec.method);
	}

	get local_call_methods(): Array<string> {
		return this.local_call_specs.map((spec) => spec.method);
	}

	get backend_methods(): Array<string> {
		return this.backend_specs.map((spec) => spec.method);
	}

	get frontend_methods(): Array<string> {
		return this.frontend_specs.map((spec) => spec.method);
	}

	get frontend_to_backend_methods(): Array<string> {
		return this.frontend_to_backend_specs.map((spec) => spec.method);
	}

	get backend_to_frontend_methods(): Array<string> {
		return this.backend_to_frontend_specs.map((spec) => spec.method);
	}

	get public_methods(): Array<string> {
		return this.public_specs.map((spec) => spec.method);
	}

	get authenticated_methods(): Array<string> {
		return this.authenticated_specs.map((spec) => spec.method);
	}
}
