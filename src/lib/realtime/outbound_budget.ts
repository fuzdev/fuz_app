/**
 * The byte budget of the frames waiting to be written to one connection — a
 * WebSocket or an SSE stream.
 *
 * A producer never waits on a recipient: a broadcast is synchronous and called
 * from anywhere, so a client that stopped reading makes the server hold what it
 * has not taken. `OutboundBudget` is the bound on that, and it is accounting
 * only — its owner holds the frames and decides what "waiting" means for its
 * connection (`WsOutboundWriter` for a WebSocket, `create_sse_response` for an
 * SSE stream).
 *
 * - **The charge.** Each waiting frame is charged its payload bytes — the
 *   UTF-8 length of its text — plus `OUTBOUND_FRAME_OVERHEAD_BYTES`.
 * - **The rule.** A frame is admitted when the charges already waiting plus
 *   its own stay within the budget — and, whatever its size, when nothing is
 *   waiting, so a single message larger than the whole budget is deliverable.
 *
 * Nothing counts frames: any number may wait while their charges fit. The twin
 * of the Rust spine's `fuz_realtime` outbound queue, with the same charge and
 * the same rule.
 *
 * @module
 */

/**
 * What a waiting frame is charged against its budget on top of its payload
 * bytes.
 *
 * It stands for what a queued frame costs beyond its text, so a frame with
 * little or no payload is not free: a budget of `B` never holds more than `B`
 * divided by this many frames, whatever their size. A fixed charge, not a
 * measurement of memory use. Same value as the Rust spine's constant.
 */
export const OUTBOUND_FRAME_OVERHEAD_BYTES = 64;

/** What was waiting when a frame did not fit its connection's budget. */
export interface OutboundOverflow {
	/** Payload bytes waiting, without the per-frame overhead the budget also charges. */
	queued_bytes: number;
	/** Frames waiting. */
	queued_frames: number;
	/** Payload bytes of the frame that did not fit, without its overhead. */
	frame_bytes: number;
}

/**
 * The accounting for one connection's waiting frames (module doc).
 *
 * `admit` charges a frame that fits, `release` frees the charge of one that is
 * no longer waiting, and `clear` frees them all.
 */
export class OutboundBudget {
	/** The budget, in bytes. */
	readonly max_bytes: number;

	#bytes = 0;
	#frames = 0;

	/**
	 * @param max_bytes - the budget, in bytes; `0` admits one frame at a time
	 * @throws Error when `max_bytes` is not a non-negative safe integer
	 */
	constructor(max_bytes: number) {
		if (!Number.isSafeInteger(max_bytes) || max_bytes < 0) {
			throw new Error(`OutboundBudget: max_bytes must be a non-negative integer, got ${max_bytes}`);
		}
		this.max_bytes = max_bytes;
	}

	/** Payload bytes waiting, without the per-frame overhead. */
	get queued_bytes(): number {
		return this.#bytes;
	}

	/** Frames waiting. */
	get queued_frames(): number {
		return this.#frames;
	}

	/**
	 * Charge a frame of `frame_bytes` payload bytes if it fits: when nothing is
	 * waiting, or when the charges waiting plus its own stay within the budget.
	 *
	 * @param frame_bytes - the frame's payload length in UTF-8 bytes
	 * @returns whether the frame was admitted and charged
	 * @mutates this - adds the frame's charge when it is admitted
	 */
	admit(frame_bytes: number): boolean {
		if (
			this.#frames !== 0 &&
			this.#bytes + frame_bytes + (this.#frames + 1) * OUTBOUND_FRAME_OVERHEAD_BYTES >
				this.max_bytes
		) {
			return false;
		}
		this.#bytes += frame_bytes;
		this.#frames++;
		return true;
	}

	/**
	 * Free the charge of one admitted frame that is no longer waiting.
	 *
	 * @param frame_bytes - the payload length the frame was admitted with
	 * @mutates this - removes the frame's charge
	 */
	release(frame_bytes: number): void {
		this.#bytes -= frame_bytes;
		this.#frames--;
	}

	/**
	 * Free every charge — the owner discarded what was waiting.
	 *
	 * @mutates this - removes every charge
	 */
	clear(): void {
		this.#bytes = 0;
		this.#frames = 0;
	}

	/**
	 * What is waiting, for the log line of a frame that did not fit.
	 *
	 * @param frame_bytes - the payload length of the frame that did not fit
	 */
	to_overflow(frame_bytes: number): OutboundOverflow {
		return { queued_bytes: this.#bytes, queued_frames: this.#frames, frame_bytes };
	}
}
