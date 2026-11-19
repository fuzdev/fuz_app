/**
 * Timer fakes shared by the room client and WebRTC tests: timers a test fires
 * by hand, and `settle`, which lets queued work run.
 *
 * @module
 */

/** Fake timers: callbacks wait until a test fires them. */
export interface FakeTimers {
	set_timeout: (callback: () => void, ms: number) => unknown;
	clear_timeout: (handle: unknown) => void;
	/** The waiting callbacks' delays, in scheduling order. */
	readonly pending: () => Array<number>;
	/** Run every waiting callback. */
	fire_all: () => void;
}

export const create_fake_timers = (): FakeTimers => {
	let next = 1;
	const waiting: Map<number, { callback: () => void; ms: number }> = new Map();
	return {
		set_timeout: (callback, ms) => {
			const handle = next++;
			waiting.set(handle, { callback, ms });
			return handle;
		},
		clear_timeout: (handle) => {
			waiting.delete(handle as number);
		},
		pending: () => [...waiting.values()].map((w) => w.ms),
		fire_all: () => {
			const due = [...waiting.values()];
			waiting.clear();
			for (const w of due) w.callback();
		}
	};
};

/** Let every queued microtask and the current macrotask's follow-ups run. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
