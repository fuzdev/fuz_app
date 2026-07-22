/**
 * Byte-stream test helpers shared by the runtime suites that exercise
 * `read_file_stream` / `write_file_stream`. Not a test file (no `.test.ts`),
 * so vitest does not collect it.
 *
 * @module
 */

/** Drain a `ReadableStream` of bytes into a single `Uint8Array`. */
export const collect_stream = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
	const chunks: Array<Uint8Array> = [];
	let total = 0;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			total += value.length;
		}
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
	}
	return merged;
};

/** A `ReadableStream` that emits the given chunks in order, then closes. */
export const stream_of = (chunks: Array<Uint8Array>): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		}
	});
