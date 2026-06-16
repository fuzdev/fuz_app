/**
 * `ActionRegistry` — query and filter utility over `ActionSpecUnion[]`.
 *
 * Vocabulary (see the `docs/` directory):
 * - `*_handled_*` — request_response specs the named side **receives**
 *   (so the named side owns the handler). Used by codegen to emit typed
 *   handler maps.
 * - `*_relevant_to_*` — the loose "everything this side might encounter"
 *   set, used by the typed-Proxy method enums (`FrontendActionMethod`,
 *   `BackendActionMethod`).
 * - `broadcast_*` — kind-narrow `remote_notification` set with the
 *   `streams`-target exclusion. Today this matches what the broadcast
 *   API exposes.
 * - `backend_initiated_*` — forward-looking kind-agnostic version of the
 *   broadcast set. Same content today; will diverge when local_calls or
 *   backend `request_response` join the backend's typed surface.
 *
 * Cache discipline: `spec_by_method` (Map) and the internal streams-target
 * set lazy-memoize because the Map is consulted per-RPC dispatch
 * (`actions/frontend_rpc_client.ts` wires it into `lookup_action_spec`) and the
 * streams set is rebuilt by two public getters. Array-returning getters
 * recompute on each call so callers can mutate the result freely
 * (`.sort()`, `.push(injected)` on a copy, etc.) without affecting the
 * registry — codegen is a build-time path where the extra `.filter` /
 * `.map` work is negligible.
 *
 * @module
 */

import type {
	ActionSpecUnion,
	RequestResponseActionSpec,
	RemoteNotificationActionSpec,
	LocalCallActionSpec,
} from './action_spec.ts';
import {is_public_auth} from '../http/auth_shape.ts';

// The auth (`public_*`, `authenticated_*`) and initiator-direction
// (`backend_to_frontend_*`, `frontend_to_backend_*`) getters are pre-built
// API surface unused by codegen today; kept low-cost for future filtering
// without a registry change.

export class ActionRegistry {
	readonly specs: Array<ActionSpecUnion>;

	constructor(specs: Array<ActionSpecUnion>) {
		this.specs = specs;
	}

	#spec_by_method: Map<string, ActionSpecUnion> | undefined;
	get spec_by_method(): Map<string, ActionSpecUnion> {
		return (this.#spec_by_method ??= new Map(this.specs.map((spec) => [spec.method, spec])));
	}

	get methods(): Array<string> {
		return this.specs.map((spec) => spec.method);
	}

	// --- Kind-narrow getters ---

	get request_response_specs(): Array<RequestResponseActionSpec> {
		return this.specs.filter((spec) => spec.kind === 'request_response');
	}

	get remote_notification_specs(): Array<RemoteNotificationActionSpec> {
		return this.specs.filter((spec) => spec.kind === 'remote_notification');
	}

	get local_call_specs(): Array<LocalCallActionSpec> {
		return this.specs.filter((spec) => spec.kind === 'local_call');
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

	// --- Loose "relevant to side" getters ---
	// Backs the `FrontendActionMethod` / `BackendActionMethod` enums — the
	// typed-Proxy method enums where every spec the side might encounter
	// (call, receive, or execute) belongs in the union.

	get specs_relevant_to_frontend(): Array<ActionSpecUnion> {
		return this.specs.slice();
	}

	get specs_relevant_to_backend(): Array<ActionSpecUnion> {
		return this.specs.filter((spec) => spec.kind !== 'local_call');
	}

	get methods_relevant_to_frontend(): Array<string> {
		return this.specs_relevant_to_frontend.map((spec) => spec.method);
	}

	get methods_relevant_to_backend(): Array<string> {
		return this.specs_relevant_to_backend.map((spec) => spec.method);
	}

	// --- Narrow handler-side getters (request_response only) ---
	// "Handled" = this side **receives** (initiator excludes own side).
	// Drives `FrontendRequestResponseMethod` / `BackendRequestResponseMethod`
	// enums and the typed `BackendActionHandlers` mapped type.

	get frontend_handled_specs(): Array<RequestResponseActionSpec> {
		return this.request_response_specs.filter((spec) => spec.initiator !== 'frontend');
	}

	get backend_handled_specs(): Array<RequestResponseActionSpec> {
		return this.request_response_specs.filter((spec) => spec.initiator !== 'backend');
	}

	get frontend_handled_methods(): Array<string> {
		return this.frontend_handled_specs.map((spec) => spec.method);
	}

	get backend_handled_methods(): Array<string> {
		return this.backend_handled_specs.map((spec) => spec.method);
	}

	// --- Broadcast / backend-initiated getters ---
	// Excludes `streams` targets (request-scoped progress notifications
	// invoked via `ctx.notify` inside the parent handler). Today
	// `broadcast_*` and `backend_initiated_*` return the same set;
	// `backend_initiated_*` is the forward-looking name that will widen
	// when local_calls or backend-initiated `request_response` join.

	get broadcast_specs(): Array<RemoteNotificationActionSpec> {
		const streams_targets = this.#get_streams_target_methods();
		return this.remote_notification_specs.filter(
			(spec) => spec.initiator !== 'frontend' && !streams_targets.has(spec.method),
		);
	}

	get broadcast_methods(): Array<string> {
		return this.broadcast_specs.map((spec) => spec.method);
	}

	get backend_initiated_specs(): Array<ActionSpecUnion> {
		const streams_targets = this.#get_streams_target_methods();
		return this.specs.filter(
			(spec) => spec.initiator !== 'frontend' && !streams_targets.has(spec.method),
		);
	}

	get backend_initiated_methods(): Array<string> {
		return this.backend_initiated_specs.map((spec) => spec.method);
	}

	// --- Initiator-direction (pre-built, unused by codegen today) ---

	get backend_to_frontend_specs(): Array<ActionSpecUnion> {
		return this.specs.filter((spec) => spec.initiator === 'backend' || spec.initiator === 'both');
	}

	get frontend_to_backend_specs(): Array<ActionSpecUnion> {
		return this.specs.filter((spec) => spec.initiator === 'frontend' || spec.initiator === 'both');
	}

	get frontend_to_backend_methods(): Array<string> {
		return this.frontend_to_backend_specs.map((spec) => spec.method);
	}

	get backend_to_frontend_methods(): Array<string> {
		return this.backend_to_frontend_specs.map((spec) => spec.method);
	}

	// --- Auth (pre-built, unused by codegen today) ---

	get public_specs(): Array<ActionSpecUnion> {
		return this.specs.filter((spec) => spec.auth !== null && is_public_auth(spec.auth));
	}

	get authenticated_specs(): Array<ActionSpecUnion> {
		return this.specs.filter(
			(spec) =>
				spec.auth?.account === 'required' &&
				!spec.auth.roles?.length &&
				!spec.auth.credential_types?.length,
		);
	}

	get public_methods(): Array<string> {
		return this.public_specs.map((spec) => spec.method);
	}

	get authenticated_methods(): Array<string> {
		return this.authenticated_specs.map((spec) => spec.method);
	}

	// --- Internal ---

	#streams_target_methods: Set<string> | undefined;
	#get_streams_target_methods(): Set<string> {
		if (this.#streams_target_methods) return this.#streams_target_methods;
		const targets = new Set<string>();
		for (const spec of this.specs) {
			if (spec.streams) targets.add(spec.streams);
		}
		return (this.#streams_target_methods = targets);
	}
}
