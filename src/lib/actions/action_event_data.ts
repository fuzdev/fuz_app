/**
 * Action event data types — discriminated union for state machine data.
 *
 * 39-variant discriminated union across 3 action kinds (request_response,
 * remote_notification, local_call). Each variant narrows the data shape
 * by kind, phase, and step.
 *
 * @module
 */

import {z} from 'zod';

import {ActionEventPhase, ActionKind} from './action_spec.ts';
import {
	JsonrpcRequest,
	JsonrpcResponseOrError,
	JsonrpcNotification,
	JsonrpcErrorObject,
} from '../http/jsonrpc.ts';
import {ActionExecutor, ActionEventStep} from './action_event_types.ts';

// Base schema for all action event data
export const ActionEventData = z.strictObject({
	kind: ActionKind,
	phase: ActionEventPhase,
	step: ActionEventStep,
	method: z.string(),
	executor: ActionExecutor,
	input: z.unknown().nullable(),
	output: z.unknown().nullable(),
	error: JsonrpcErrorObject.nullable(),
	progress: z.unknown().nullable(),
	// Fields for specific kinds - always present but may be null
	request: JsonrpcRequest.nullable(),
	response: JsonrpcResponseOrError.nullable(),
	notification: JsonrpcNotification.nullable(),
});
export type ActionEventData = z.infer<typeof ActionEventData>;

// Discriminated union types for narrowing
export type ActionEventRequestResponseData<
	TMethod extends string = string,
	TInput = unknown,
	TOutput = unknown,
> =
	| {
			kind: 'request_response';
			phase: 'send_request';
			step: 'initial';
			method: TMethod;
			executor: ActionExecutor;
			input: unknown;
			output: null;
			error: null;
			progress: null;
			request: null;
			response: null;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'send_request';
			step: 'parsed';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: null;
			progress: null;
			request: null;
			response: null;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'send_request';
			step: 'handling';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: null;
			progress: unknown;
			request: JsonrpcRequest;
			response: null;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'send_request';
			step: 'handled';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: null;
			progress: unknown;
			request: JsonrpcRequest;
			response: null;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'send_request';
			step: 'failed';
			method: TMethod;
			executor: ActionExecutor;
			input: unknown;
			output: null;
			error: JsonrpcErrorObject;
			progress: unknown;
			request: JsonrpcRequest | null;
			response: null;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'receive_request';
			step: 'initial';
			method: TMethod;
			executor: ActionExecutor;
			input: unknown;
			output: null;
			error: null;
			progress: null;
			request: JsonrpcRequest;
			response: null;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'receive_request';
			step: 'parsed';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: null;
			progress: null;
			request: JsonrpcRequest;
			response: null;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'receive_request';
			step: 'handling';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: null;
			progress: unknown;
			request: JsonrpcRequest;
			response: null;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'receive_request';
			step: 'handled';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: TOutput;
			error: null;
			progress: unknown;
			request: JsonrpcRequest;
			response: null;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'receive_request';
			step: 'failed';
			method: TMethod;
			executor: ActionExecutor;
			input: unknown;
			output: null;
			error: JsonrpcErrorObject;
			progress: unknown;
			request: JsonrpcRequest;
			response: null;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'send_response';
			step: 'initial';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: TOutput;
			error: null;
			progress: null;
			request: JsonrpcRequest;
			response: JsonrpcResponseOrError;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'send_response';
			step: 'parsed';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: TOutput;
			error: null;
			progress: null;
			request: JsonrpcRequest;
			response: JsonrpcResponseOrError;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'send_response';
			step: 'handling';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: TOutput;
			error: null;
			progress: unknown;
			request: JsonrpcRequest;
			response: JsonrpcResponseOrError;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'send_response';
			step: 'handled';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: TOutput;
			error: null;
			progress: unknown;
			request: JsonrpcRequest;
			response: JsonrpcResponseOrError;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'send_response';
			step: 'failed';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: TOutput | null;
			error: JsonrpcErrorObject;
			progress: unknown;
			request: JsonrpcRequest;
			response: JsonrpcResponseOrError;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'receive_response';
			step: 'initial';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: unknown;
			error: null;
			progress: null;
			request: JsonrpcRequest;
			response: JsonrpcResponseOrError;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'receive_response';
			step: 'parsed';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: TOutput;
			error: null;
			progress: null;
			request: JsonrpcRequest;
			response: JsonrpcResponseOrError;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'receive_response';
			step: 'handling';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: TOutput;
			error: null;
			progress: unknown;
			request: JsonrpcRequest;
			response: JsonrpcResponseOrError;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'receive_response';
			step: 'handled';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: TOutput;
			error: null;
			progress: unknown;
			request: JsonrpcRequest;
			response: JsonrpcResponseOrError;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'receive_response';
			step: 'failed';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: TOutput | null;
			error: JsonrpcErrorObject;
			progress: unknown;
			request: JsonrpcRequest;
			response: JsonrpcResponseOrError;
			notification: null;
	  }
	// send_error phase (when send_request fails)
	| {
			kind: 'request_response';
			phase: 'send_error';
			step: 'initial';
			method: TMethod;
			executor: ActionExecutor;
			input: unknown;
			output: null;
			error: JsonrpcErrorObject;
			progress: null;
			request: JsonrpcRequest | null;
			response: null;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'send_error';
			step: 'parsed';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: JsonrpcErrorObject;
			progress: null;
			request: JsonrpcRequest | null;
			response: null;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'send_error';
			step: 'handling';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: JsonrpcErrorObject;
			progress: unknown;
			request: JsonrpcRequest | null;
			response: null;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'send_error';
			step: 'handled';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: JsonrpcErrorObject;
			progress: unknown;
			request: JsonrpcRequest | null;
			response: null;
			notification: null;
	  }
	// receive_error phase (when receive_response contains error)
	| {
			kind: 'request_response';
			phase: 'receive_error';
			step: 'initial';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: JsonrpcErrorObject;
			progress: null;
			request: JsonrpcRequest;
			response: JsonrpcResponseOrError;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'receive_error';
			step: 'parsed';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: JsonrpcErrorObject;
			progress: null;
			request: JsonrpcRequest;
			response: JsonrpcResponseOrError;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'receive_error';
			step: 'handling';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: JsonrpcErrorObject;
			progress: unknown;
			request: JsonrpcRequest;
			response: JsonrpcResponseOrError;
			notification: null;
	  }
	| {
			kind: 'request_response';
			phase: 'receive_error';
			step: 'handled';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: JsonrpcErrorObject;
			progress: unknown;
			request: JsonrpcRequest;
			response: JsonrpcResponseOrError;
			notification: null;
	  };

export type ActionEventRemoteNotificationData<TMethod extends string = string, TInput = unknown> =
	| {
			kind: 'remote_notification';
			phase: 'send';
			step: 'initial';
			method: TMethod;
			executor: ActionExecutor;
			input: unknown;
			output: null;
			error: null;
			progress: null;
			request: null;
			response: null;
			notification: null;
	  }
	| {
			kind: 'remote_notification';
			phase: 'send';
			step: 'parsed';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: null;
			progress: null;
			request: null;
			response: null;
			notification: null;
	  }
	| {
			kind: 'remote_notification';
			phase: 'send';
			step: 'handling';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: null;
			progress: unknown;
			request: null;
			response: null;
			notification: JsonrpcNotification;
	  }
	| {
			kind: 'remote_notification';
			phase: 'send';
			step: 'handled';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: null;
			progress: unknown;
			request: null;
			response: null;
			notification: JsonrpcNotification;
	  }
	| {
			kind: 'remote_notification';
			phase: 'send';
			step: 'failed';
			method: TMethod;
			executor: ActionExecutor;
			input: unknown;
			output: null;
			error: JsonrpcErrorObject;
			progress: unknown;
			request: null;
			response: null;
			notification: JsonrpcNotification | null;
	  }
	| {
			kind: 'remote_notification';
			phase: 'receive';
			step: 'initial';
			method: TMethod;
			executor: ActionExecutor;
			input: unknown;
			output: null;
			error: null;
			progress: null;
			request: null;
			response: null;
			notification: JsonrpcNotification;
	  }
	| {
			kind: 'remote_notification';
			phase: 'receive';
			step: 'parsed';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: null;
			progress: null;
			request: null;
			response: null;
			notification: JsonrpcNotification;
	  }
	| {
			kind: 'remote_notification';
			phase: 'receive';
			step: 'handling';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: null;
			progress: unknown;
			request: null;
			response: null;
			notification: JsonrpcNotification;
	  }
	| {
			kind: 'remote_notification';
			phase: 'receive';
			step: 'handled';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: null;
			progress: unknown;
			request: null;
			response: null;
			notification: JsonrpcNotification;
	  }
	| {
			kind: 'remote_notification';
			phase: 'receive';
			step: 'failed';
			method: TMethod;
			executor: ActionExecutor;
			input: unknown;
			output: null;
			error: JsonrpcErrorObject;
			progress: unknown;
			request: null;
			response: null;
			notification: JsonrpcNotification;
	  };

export type ActionEventLocalCallData<
	TMethod extends string = string,
	TInput = unknown,
	TOutput = unknown,
> =
	| {
			kind: 'local_call';
			phase: 'execute';
			step: 'initial';
			method: TMethod;
			executor: ActionExecutor;
			input: unknown;
			output: null;
			error: null;
			progress: null;
			request: null;
			response: null;
			notification: null;
	  }
	| {
			kind: 'local_call';
			phase: 'execute';
			step: 'parsed';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: null;
			progress: null;
			request: null;
			response: null;
			notification: null;
	  }
	| {
			kind: 'local_call';
			phase: 'execute';
			step: 'handling';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: null;
			error: null;
			progress: unknown;
			request: null;
			response: null;
			notification: null;
	  }
	| {
			kind: 'local_call';
			phase: 'execute';
			step: 'handled';
			method: TMethod;
			executor: ActionExecutor;
			input: TInput;
			output: TOutput;
			error: null;
			progress: unknown;
			request: null;
			response: null;
			notification: null;
	  }
	| {
			kind: 'local_call';
			phase: 'execute';
			step: 'failed';
			method: TMethod;
			executor: ActionExecutor;
			input: unknown;
			output: null;
			error: JsonrpcErrorObject;
			progress: unknown;
			request: null;
			response: null;
			notification: null;
	  };

// Union type for all action event data
export type ActionEventDataUnion<
	TMethod extends string = string,
	TInput = unknown,
	TOutput = unknown,
> =
	| ActionEventRequestResponseData<TMethod, TInput, TOutput>
	| ActionEventRemoteNotificationData<TMethod, TInput>
	| ActionEventLocalCallData<TMethod, TInput, TOutput>;
