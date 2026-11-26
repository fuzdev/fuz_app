import './assert_dev_env.ts';

/**
 * A `WebSocket` stand-in the test drives, for frontend code that constructs
 * sockets itself (`FrontendWebsocketClient` and the clients built on it):
 * `install_mock_websocket` swaps it in as `globalThis.WebSocket`, every
 * socket constructed is recorded, and the test plays the server with
 * `fire_open`, `fire_message`, `fire_close` and `fire_error`.
 *
 * Run the real client over it rather than faking the client: its close-code
 * rules, queue and reconnect then come along, where a fake re-encoding them
 * drifts.
 *
 * @module
 */

/** A listener as the mock calls it, with the event the test fired. */
export type MockWebSocketListener = (event: any) => void;

/** The close code `close()` sends without one — a normal closure. */
const NORMAL_CLOSURE = 1000;

/**
 * The socket. Like a browser's, `close()` doesn't fire `close` itself: it
 * leaves the socket `CLOSING` until the close event, the server's answer,
 * which a test fires with `fire_close`. It refuses a code a browser refuses.
 */
export class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readonly url: string;
	readyState: number = MockWebSocket.CONNECTING;
	/** Every frame `send` was given, oldest first. */
	readonly sent: Array<string> = [];
	/** The code the client closed with, `null` until it does. */
	close_code: number | null = null;
	/** The reason the client closed with, `null` until it does (`''` when it gave none). */
	close_reason: string | null = null;
	/** Set to make `close()` throw, for a client's teardown under failure. */
	close_throws = false;

	readonly #listeners: Map<string, Set<MockWebSocketListener>> = new Map();

	constructor(url: string | URL) {
		this.url = String(url);
	}

	addEventListener(type: string, listener: MockWebSocketListener): void {
		let set = this.#listeners.get(type);
		if (!set) this.#listeners.set(type, (set = new Set()));
		set.add(listener);
	}

	removeEventListener(type: string, listener: MockWebSocketListener): void {
		this.#listeners.get(type)?.delete(listener);
	}

	/** Call every listener of `type` with `event`. */
	dispatch(type: string, event: unknown): void {
		const listeners = this.#listeners.get(type);
		if (!listeners) return;
		for (const listener of listeners) listener(event);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	/**
	 * @throws DOMException `InvalidAccessError` for a code other than 1000 or
	 *   3000–4999, as a browser does
	 */
	close(code: number = NORMAL_CLOSURE, reason: string = ''): void {
		if (this.close_throws) throw new Error('MockWebSocket: close failure');
		if (code !== NORMAL_CLOSURE && !(code >= 3000 && code <= 4999)) {
			throw new DOMException(
				`MockWebSocket: close code ${code} is neither 1000 nor in 3000-4999`,
				'InvalidAccessError'
			);
		}
		this.close_code = code;
		this.close_reason = reason;
		if (this.readyState !== MockWebSocket.CLOSED) this.readyState = MockWebSocket.CLOSING;
	}

	/** The server accepts the connection. */
	fire_open(): void {
		this.readyState = MockWebSocket.OPEN;
		this.dispatch('open', new Event('open'));
	}

	/** The server sends a frame. */
	fire_message(data: string): void {
		this.dispatch('message', { data });
	}

	/**
	 * The connection closes with `code` and `reason` — a duck-typed event,
	 * since `CloseEvent` differs across environments.
	 */
	fire_close(code: number = NORMAL_CLOSURE, reason: string = ''): void {
		this.readyState = MockWebSocket.CLOSED;
		this.dispatch('close', { code, reason, wasClean: code === NORMAL_CLOSURE });
	}

	fire_error(): void {
		this.dispatch('error', new Event('error'));
	}
}

/** What `install_mock_websocket` returns: the sockets constructed, and the way back. */
export interface MockWebSocketInstall {
	/** Every socket constructed since the install, oldest first. */
	readonly instances: Array<MockWebSocket>;
	/** Set to make the constructor throw, as a browser does on a bad URL. */
	throw_on_construct: boolean;
	/** The socket constructed last; throws when none was. */
	last: () => MockWebSocket;
	/** Put back the `WebSocket` the install replaced. */
	restore: () => void;
}

/**
 * Swap a `MockWebSocket` class in as `globalThis.WebSocket` — call in a
 * `beforeEach` and `restore` in the `afterEach`. Each install records into
 * its own `instances`.
 *
 * @returns the install's record of sockets and its `restore`
 */
export const install_mock_websocket = (): MockWebSocketInstall => {
	const original = globalThis.WebSocket;
	const install: MockWebSocketInstall = {
		instances: [],
		throw_on_construct: false,
		last: () => {
			const socket = install.instances.at(-1);
			if (!socket) throw new Error('install_mock_websocket: no WebSocket constructed');
			return socket;
		},
		restore: () => {
			globalThis.WebSocket = original;
		}
	};
	class InstalledMockWebSocket extends MockWebSocket {
		constructor(url: string | URL) {
			if (install.throw_on_construct) {
				throw new Error('install_mock_websocket: construct failure');
			}
			super(url);
			install.instances.push(this);
		}
	}
	globalThis.WebSocket = InstalledMockWebSocket as unknown as typeof globalThis.WebSocket;
	return install;
};
