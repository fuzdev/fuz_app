/**
 * The outbound side of one server WebSocket connection — a byte-budgeted
 * queue of frames, the pump that hands them to the socket, and the deadlines
 * on what the socket has not yet written.
 *
 * Every frame the server sends a connection goes through
 * `WsOutboundWriter.push`: a response, an error frame, a notification, a
 * broadcast, a server-initiated request. `BackendWebsocketTransport` owns one
 * writer per connection and is its only caller.
 *
 * ## What waits
 *
 * A frame pushed at an idle connection — nothing waiting, nothing unwritten in
 * the runtime's socket buffer, and no other frame pushed in the same
 * synchronous run — goes straight to the socket. Every other frame **waits**
 * in the writer's queue: the rest of a burst pushed in one synchronous run
 * (a loop with no `await` in it gives the pump no turn), and anything pushed
 * while the socket's buffer is at or over `WS_WRITE_HIGH_WATER_BYTES`. The
 * pump hands waiting frames over in order — on the microtask after a push, and
 * whenever the buffer has drained below the high-water mark.
 *
 * What waits is held to the connection's budget (`OutboundBudget`): each
 * waiting frame is charged its UTF-8 length plus
 * `OUTBOUND_FRAME_OVERHEAD_BYTES`, and a frame is always admitted when nothing
 * is waiting. A frame handed to the socket is no longer charged — the budget
 * bounds what waits, and the write deadline bounds what is in flight.
 *
 * A frame that does not fit is reported as an overflow and not queued; the
 * owner closes the connection for it (`WS_CLOSE_OUTBOUND_OVERFLOW`).
 *
 * The queue is a linked list: a frame handed to the socket is unlinked, so the
 * writer holds the frames that wait and no others, however long the queue goes
 * without emptying.
 *
 * ## Closing
 *
 * `close` sends the close frame and takes nothing more. With `'flush'` it
 * first runs the pump's rule once: waiting frames are handed to the socket
 * while its buffer is below `WS_WRITE_HIGH_WATER_BYTES`. Whatever still waits
 * is discarded, with either backlog choice. So a frame sent to an otherwise
 * idle connection just before a close reaches the client ahead of the close
 * frame, and a frame queued behind a backed-up socket does not. After a close
 * a socket whose buffer the writer can read ("Runtimes") holds less than the
 * high-water mark plus one frame, and the close frame.
 *
 * ## Deadlines
 *
 * - **A frame**: bytes the socket's buffer still holds
 *   `WS_WRITE_STALL_TIMEOUT` after they were handed to it mean the client is
 *   not reading. The writer discards what waits, reports the stall, and cuts
 *   the socket with no close frame (the client sees an abnormal close, 1006).
 * - **A close frame**: a close still unwritten `WS_CLOSE_WRITE_TIMEOUT` after
 *   `close` cuts the socket the same way, so a closed connection whose client
 *   stopped reading does not hold its buffered frames for the runtime's own
 *   close timeout — where the runtime can cut a socket ("Runtimes").
 *
 * ## Runtimes
 *
 * The buffer is read through the socket Hono's `WSContext` wraps (`raw`):
 * `bufferedAmount` on Node's `ws` and on Deno's standard `WebSocket`,
 * `getBufferedAmount()` on Bun's `ServerWebSocket`. A socket that exposes
 * neither reads as never backed up: its frames are still budgeted while they
 * wait for the pump, but nothing detects a stall. The cut is `terminate()`,
 * which Node's `ws` and Bun's `ServerWebSocket` have. Deno's standard
 * `WebSocket` has no way to drop a socket without the closing handshake, so
 * there a stalled connection is closed with `WS_CLOSE_OUTBOUND_OVERFLOW`
 * instead — a frame the client reads only if it starts reading again — and
 * the close deadline cuts nothing: a closed socket whose client is not reading
 * stays in the runtime, holding what its buffer held at the close ("Closing"),
 * until the runtime or the client ends it.
 *
 * @module
 */

import type { WSContext } from 'hono/ws';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { OutboundBudget, type OutboundOverflow } from '../realtime/outbound_budget.ts';
import {
	WS_CLOSE_OUTBOUND_OVERFLOW,
	WS_CLOSE_OUTBOUND_OVERFLOW_REASON,
	utf8_length
} from './transports.ts';

/**
 * How long bytes handed to a socket may stay unwritten in its buffer before
 * the connection is dropped (module doc, "Deadlines"). Equal to
 * `DEFAULT_PEER_REQUEST_TIMEOUT`: a server-initiated request that cannot even
 * be written within its own reply deadline has already failed. Same value as
 * the Rust spine's `WS_WRITE_STALL_TIMEOUT`.
 *
 * The deadline covers the bytes in the buffer when it starts, not progress: a
 * client taking them too slowly to finish inside it is dropped the same way,
 * and reconnects.
 */
export const WS_WRITE_STALL_TIMEOUT = 10_000;

/**
 * How long a close frame may stay unwritten before the socket is cut without
 * it (module doc, "Deadlines"). Twin of the Rust spine's
 * `WS_CLOSE_WRITE_TIMEOUT`, the same value.
 */
export const WS_CLOSE_WRITE_TIMEOUT = 1_000;

/**
 * How many unwritten bytes a socket's buffer may hold before the pump stops
 * handing it waiting frames. Below it the pump keeps writing, so a runtime
 * that reports a frame as buffered until its write completes (Deno) is not
 * held to one frame per turn; at or over it frames wait in the budgeted queue
 * instead of the runtime's unbounded buffer.
 */
export const WS_WRITE_HIGH_WATER_BYTES = 64 * 1024;

/** The longest wait between two reads of a backed-up socket's buffer. */
const DRAIN_POLL_MAX_DELAY = 32;

/** `WebSocket.CLOSED`. */
const READY_STATE_CLOSED = 3;

/** The outcome of one `WsOutboundWriter.push`. */
export type WsOutboundPush =
	/** The frame went to the socket or is waiting for it. */
	| { kind: 'accepted' }
	/** The frame was dropped: the writer has closed, or the socket refused it. */
	| { kind: 'refused' }
	/** The frame did not fit the budget and was not queued. */
	| { kind: 'overflow'; overflow: OutboundOverflow };

/** What a stalled connection held when its write deadline passed. */
export interface WsOutboundStall {
	/** Payload bytes that were waiting, now discarded. */
	queued_bytes: number;
	/** Frames that were waiting, now discarded. */
	queued_frames: number;
	/** Bytes the socket's buffer still held. */
	buffered_bytes: number;
}

/** What `WsOutboundWriter.close` does with the frames still waiting. */
export type WsOutboundBacklog =
	/**
	 * Hand them to the socket ahead of the close frame while its buffer is below
	 * `WS_WRITE_HIGH_WATER_BYTES`, and drop the rest.
	 */
	| 'flush'
	/** Drop them all. */
	| 'discard';

/** Options for `WsOutboundWriter`. */
export interface WsOutboundWriterOptions {
	/** The socket to write to. */
	ws: WSContext;
	/** The byte budget of the frames waiting for the socket. */
	max_bytes: number;
	/**
	 * Called once when a write deadline passes, after the writer discarded what
	 * was waiting and before it cuts the socket. The owner removes the
	 * connection and logs.
	 */
	on_stall: (stall: WsOutboundStall) => void;
	/** Logger for a socket that throws on a send or a cut; `null` silences it. */
	log: Logger | null;
}

/** One frame waiting for the socket, linked to the frame queued after it. */
interface WaitingFrame {
	text: string;
	bytes: number;
	next: WaitingFrame | null;
}

/** A timer that does not keep the process alive, where the runtime allows. */
const set_unref_timeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
	const timer = setTimeout(fn, ms);
	if (typeof timer === 'object' && 'unref' in timer) timer.unref();
	return timer;
};

/**
 * The bytes handed to `ws` that its runtime has not yet written — `0` for a
 * socket that does not say.
 */
const read_buffered_bytes = (ws: WSContext): number => {
	const raw = ws.raw as
		{ bufferedAmount?: unknown; getBufferedAmount?: unknown } | null | undefined;
	if (typeof raw !== 'object' || raw === null) return 0;
	if (typeof raw.getBufferedAmount === 'function') {
		const buffered: unknown = (raw.getBufferedAmount as () => unknown).call(raw);
		return typeof buffered === 'number' ? buffered : 0;
	}
	return typeof raw.bufferedAmount === 'number' ? raw.bufferedAmount : 0;
};

/**
 * Drop `ws` without a closing handshake, where its runtime can.
 *
 * @returns whether the socket was cut
 */
const terminate_socket = (ws: WSContext): boolean => {
	const raw = ws.raw as { terminate?: unknown } | null | undefined;
	if (typeof raw !== 'object' || raw === null || typeof raw.terminate !== 'function') return false;
	(raw.terminate as () => void).call(raw);
	return true;
};

/**
 * The byte-budgeted outbound queue and write pump of one WebSocket connection
 * (module doc).
 */
export class WsOutboundWriter {
	readonly #ws: WSContext;
	readonly #budget: OutboundBudget;
	readonly #on_stall: (stall: WsOutboundStall) => void;
	readonly #log: Logger | null;

	// `open` takes frames; `closing` has sent its close and waits out the close
	// deadline; `ended` is done with the socket
	#state: 'open' | 'closing' | 'ended' = 'open';

	// the frames waiting, oldest first: a frame is unlinked as it is handed to
	// the socket, so nothing here refers to a frame that is not waiting
	#head: WaitingFrame | null = null;
	#tail: WaitingFrame | null = null;

	// a pump is scheduled for the end of the current synchronous run — which is
	// also what marks a frame as already written through in this run
	#pump_pending = false;

	#poll_timer: ReturnType<typeof setTimeout> | null = null;
	#poll_delay = 1;
	#last_buffered = 0;

	// The write deadline covers the bytes in the buffer when it starts: it is
	// met once the buffer holds no more than what was handed over since.
	#stall_timer: ReturnType<typeof setTimeout> | null = null;
	#handed_since_stall_start = 0;

	#close_timer: ReturnType<typeof setTimeout> | null = null;
	#on_close_settled: (() => void) | null = null;

	constructor(options: WsOutboundWriterOptions) {
		this.#ws = options.ws;
		this.#budget = new OutboundBudget(options.max_bytes);
		this.#on_stall = options.on_stall;
		this.#log = options.log;
	}

	/** Payload bytes waiting for the socket, without the per-frame overhead. */
	get queued_bytes(): number {
		return this.#budget.queued_bytes;
	}

	/** Frames waiting for the socket. */
	get queued_frames(): number {
		return this.#budget.queued_frames;
	}

	/**
	 * Send `text` as one frame: straight to the socket when the connection is
	 * idle, else queued behind what waits when it fits the budget (module doc,
	 * "What waits"). Never waits and never throws.
	 *
	 * @param text - the frame's text
	 * @param bytes - the UTF-8 length of `text` when the caller has measured it —
	 *   a fan-out measures one frame once for its recipients; measured here when
	 *   omitted. Trusted, not checked against `text`: a wrong value corrupts the
	 *   budget
	 * @returns `accepted`, `refused` once the writer has closed, or `overflow`
	 *   when the frame did not fit — the caller closes the connection
	 * @mutates this - queues the frame or writes it to the socket, and schedules
	 *   the pump
	 */
	push(text: string, bytes?: number): WsOutboundPush {
		if (this.#state !== 'open') return { kind: 'refused' };
		if (!this.#pump_pending && this.#head === null && read_buffered_bytes(this.#ws) === 0) {
			// idle, and everything handed over earlier is written
			this.#clear_stall_timer();
			this.#schedule_pump();
			if (!this.#write(text)) return { kind: 'refused' };
			// TODO: a runtime that reports a frame as buffered until its write
			// completes (Deno) arms the deadline and the poll here and clears both
			// a tick later, for each idle send
			this.#watch(read_buffered_bytes(this.#ws));
			return { kind: 'accepted' };
		}
		const frame_bytes = bytes ?? utf8_length(text);
		if (!this.#budget.admit(frame_bytes)) {
			return { kind: 'overflow', overflow: this.#budget.to_overflow(frame_bytes) };
		}
		const frame: WaitingFrame = { text, bytes: frame_bytes, next: null };
		if (this.#tail === null) this.#head = frame;
		else this.#tail.next = frame;
		this.#tail = frame;
		this.#schedule_pump();
		return { kind: 'accepted' };
	}

	/**
	 * Close the socket with `code` and `reason`, and take nothing more.
	 *
	 * With `backlog: 'flush'` the frames still waiting are handed to the socket
	 * ahead of the close frame under the pump's rule — while the socket's buffer
	 * is below `WS_WRITE_HIGH_WATER_BYTES` — so a reply sent to an otherwise idle
	 * connection just before a close is not lost to it. What still waits after
	 * that is dropped, as all of it is with `'discard'` (module doc, "Closing").
	 * Either way the close frame gets `WS_CLOSE_WRITE_TIMEOUT` to be written,
	 * after which a socket still holding unwritten bytes is cut where the runtime
	 * can cut one. A no-op once the writer has closed.
	 *
	 * @param code - the close code
	 * @param reason - the close reason
	 * @param backlog - what to do with the frames still waiting
	 * @param on_settled - called once the close deadline has passed, unless
	 *   `dispose` ran first
	 * @mutates this - empties the queue, stops the pump, starts the close deadline
	 * @throws whatever the socket's `close` throws, with the writer already closed
	 */
	close(code: number, reason: string, backlog: WsOutboundBacklog, on_settled?: () => void): void {
		if (this.#state !== 'open') return;
		this.#state = 'closing';
		this.#clear_poll_timer();
		this.#clear_stall_timer();
		// a socket that throws on a send is not offered the frames behind it
		if (backlog === 'flush') this.#hand_over(read_buffered_bytes(this.#ws), true);
		// what the socket did not take is not delivered
		this.#discard_waiting();
		this.#on_close_settled = on_settled ?? null;
		this.#close_timer = set_unref_timeout(() => {
			this.#close_timer = null;
			this.#state = 'ended';
			const settled = this.#on_close_settled;
			this.#on_close_settled = null;
			try {
				if (this.#ws.readyState !== READY_STATE_CLOSED && read_buffered_bytes(this.#ws) > 0) {
					// the client is not reading: the close frame cannot be written
					terminate_socket(this.#ws);
				}
			} catch (error) {
				this.#log?.error('error cutting a socket past its close deadline:', error);
			}
			settled?.();
		}, WS_CLOSE_WRITE_TIMEOUT);
		this.#ws.close(code, reason);
	}

	/**
	 * The socket is gone: drop what waits and stop every timer. Idempotent.
	 *
	 * @mutates this - empties the queue and clears the pump and deadline timers
	 */
	dispose(): void {
		this.#state = 'ended';
		this.#clear_poll_timer();
		this.#clear_stall_timer();
		if (this.#close_timer !== null) {
			clearTimeout(this.#close_timer);
			this.#close_timer = null;
		}
		this.#on_close_settled = null;
		this.#discard_waiting();
	}

	/** Hand one frame to the socket. `false` when the socket threw. */
	#write(text: string): boolean {
		try {
			this.#ws.send(text);
			return true;
		} catch (error) {
			this.#log?.error('error sending to client:', error);
			return false;
		}
	}

	#discard_waiting(): void {
		this.#head = null;
		this.#tail = null;
		this.#budget.clear();
	}

	/**
	 * Hand waiting frames to the socket, oldest first, while its buffer is below
	 * the high-water mark — the one rule for what leaves the queue, at a pump
	 * turn and at a close.
	 *
	 * @param buffered_before - the socket's unwritten bytes as last read
	 * @param stop_when_refused - stop at the first frame the socket throws on
	 * @returns the socket's unwritten bytes after the last frame handed over
	 */
	#hand_over(buffered_before: number, stop_when_refused: boolean): number {
		let buffered = buffered_before;
		let frame = this.#head;
		while (frame !== null && buffered < WS_WRITE_HIGH_WATER_BYTES) {
			// unlinked before the write, so the queue never refers to a frame the
			// socket has
			this.#head = frame.next;
			if (this.#head === null) this.#tail = null;
			this.#budget.release(frame.bytes);
			this.#handed_since_stall_start += frame.bytes;
			if (!this.#write(frame.text) && stop_when_refused) break;
			buffered = read_buffered_bytes(this.#ws);
			frame = this.#head;
		}
		return buffered;
	}

	#schedule_pump(): void {
		if (this.#pump_pending) return;
		this.#pump_pending = true;
		queueMicrotask(() => {
			this.#pump_pending = false;
			if (this.#state === 'open') this.#drain();
		});
	}

	/** Hand waiting frames to the socket while its buffer is below the high-water mark. */
	#drain(): void {
		let buffered = read_buffered_bytes(this.#ws);
		if (this.#stall_timer !== null && buffered <= this.#handed_since_stall_start) {
			// what the deadline covered is written
			this.#clear_stall_timer();
		}
		const waiting = this.#budget.queued_frames;
		buffered = this.#hand_over(buffered, false);
		// progress: read the buffer again soon
		if (this.#budget.queued_frames !== waiting) this.#poll_delay = 1;
		this.#watch(buffered);
	}

	/** Keep the write deadline and the buffer poll running while anything is unwritten. */
	#watch(buffered: number): void {
		if (buffered > 0 && this.#stall_timer === null) {
			this.#handed_since_stall_start = 0;
			this.#stall_timer = set_unref_timeout(() => this.#stall(), WS_WRITE_STALL_TIMEOUT);
		}
		if (buffered === 0 && this.#head === null) {
			this.#clear_poll_timer();
			return;
		}
		if (buffered < this.#last_buffered) this.#poll_delay = 1;
		this.#last_buffered = buffered;
		if (this.#poll_timer !== null) return;
		this.#poll_timer = set_unref_timeout(() => {
			this.#poll_timer = null;
			if (this.#state !== 'open') return;
			this.#poll_delay = Math.min(this.#poll_delay * 2, DRAIN_POLL_MAX_DELAY);
			this.#drain();
		}, this.#poll_delay);
	}

	/** The write deadline passed: discard, report, and cut the socket. */
	#stall(): void {
		this.#stall_timer = null;
		if (this.#state !== 'open') return;
		this.#state = 'ended';
		this.#clear_poll_timer();
		let buffered_bytes = 0;
		try {
			buffered_bytes = read_buffered_bytes(this.#ws);
		} catch {
			// a socket that cannot be read is cut all the same
		}
		const stall: WsOutboundStall = {
			queued_bytes: this.#budget.queued_bytes,
			queued_frames: this.#budget.queued_frames,
			buffered_bytes
		};
		this.#discard_waiting();
		try {
			this.#on_stall(stall);
		} catch (error) {
			this.#log?.error('error reporting a stalled socket:', error);
		}
		try {
			if (!terminate_socket(this.#ws)) {
				// no way to drop the socket on this runtime (module doc, "Runtimes")
				this.#ws.close(WS_CLOSE_OUTBOUND_OVERFLOW, WS_CLOSE_OUTBOUND_OVERFLOW_REASON);
			}
		} catch (error) {
			this.#log?.error('error cutting a stalled socket:', error);
		}
	}

	#clear_poll_timer(): void {
		if (this.#poll_timer !== null) {
			clearTimeout(this.#poll_timer);
			this.#poll_timer = null;
		}
		this.#poll_delay = 1;
		this.#last_buffered = 0;
	}

	#clear_stall_timer(): void {
		if (this.#stall_timer !== null) {
			clearTimeout(this.#stall_timer);
			this.#stall_timer = null;
		}
		this.#handed_since_stall_start = 0;
	}
}
