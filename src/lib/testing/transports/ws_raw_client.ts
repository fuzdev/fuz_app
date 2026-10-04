import '../assert_dev_env.ts';

/**
 * A raw-socket WebSocket client for tests that need to misbehave, or to
 * control exactly which bytes reach the server when.
 *
 * A client library answers a close frame itself and sends nothing until its
 * `open` event, so two server behaviors can't be reached through one: what
 * the server does with a client that **withholds its close frame**, and what
 * it does with frames that arrive **with the handshake**, before the
 * connection can have been admitted. This speaks just enough RFC 6455 over
 * `node:net` to do both — the upgrade request, masked client text frames, and
 * unmasked server frames — and deliberately never replies to a close.
 *
 * Small frames only (payloads under 64 KiB, unfragmented), which is all the
 * JSON-RPC traffic the suites send.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';

/** RFC 6455 opcode of a text frame. */
export const RAW_WS_OPCODE_TEXT = 0x1;
/** RFC 6455 opcode of a close frame. */
export const RAW_WS_OPCODE_CLOSE = 0x8;

/** One frame the server sent. */
export interface RawWsFrame {
	opcode: number;
	payload: Buffer;
}

/** A WebSocket client that sends frames and never answers a close. */
export interface RawWsClient {
	/** Every frame the server sent, in order. */
	frames: Array<RawWsFrame>;
	/** Send one masked text frame. */
	send_text: (text: string) => void;
	/** Resolves with the first frame, already received or not, matching `predicate`. */
	wait_for: (predicate: (frame: RawWsFrame) => boolean, timeout_ms?: number) => Promise<RawWsFrame>;
	/** Drop the TCP connection, with no close handshake. */
	destroy: () => void;
}

/** Options for `connect_raw_ws`. */
export interface RawWsConnectOptions {
	port: number;
	/** @default '127.0.0.1' */
	hostname?: string;
	/** The WebSocket endpoint path (e.g. `/api/ws`). */
	path: string;
	/** Extra upgrade request headers — `Cookie`, `Origin`. */
	headers?: Record<string, string>;
	/**
	 * Text frames to write in the **same TCP write** as the upgrade request, so
	 * they are in the server's hands before the handshake is answered — and so
	 * before the connection can have been admitted.
	 */
	pipelined?: ReadonlyArray<string>;
}

/** Whether a frame is a close frame. */
export const is_raw_ws_close = (frame: RawWsFrame): boolean => frame.opcode === RAW_WS_OPCODE_CLOSE;

/** The close code a close frame carries, or `null` when it carries none. */
export const raw_ws_close_code = (frame: RawWsFrame): number | null =>
	frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : null;

/** Encode one masked client text frame. */
const encode_client_text = (text: string): Buffer => {
	const payload = Buffer.from(text, 'utf-8');
	if (payload.length >= 65_536) throw new Error('raw ws: payload too large for this test client');
	const first = 0x80 | RAW_WS_OPCODE_TEXT;
	const header =
		payload.length < 126
			? Buffer.from([first, 0x80 | payload.length])
			: Buffer.from([first, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
	const mask = randomBytes(4);
	const masked = Buffer.from(payload);
	for (let i = 0; i < masked.length; i++) masked[i]! ^= mask[i % 4]!;
	return Buffer.concat([header, mask, masked]);
};

/** Split complete server frames off the front of `buffer` (server frames are unmasked). */
const take_frames = (buffer: Buffer): { frames: Array<RawWsFrame>; rest: Buffer } => {
	const frames: Array<RawWsFrame> = [];
	let offset = 0;
	for (;;) {
		if (buffer.length - offset < 2) break;
		const opcode = buffer[offset]! & 0x0f;
		let length = buffer[offset + 1]! & 0x7f;
		let header = 2;
		if (length === 126) {
			if (buffer.length - offset < 4) break;
			length = buffer.readUInt16BE(offset + 2);
			header = 4;
		} else if (length === 127) {
			throw new Error('raw ws: 64-bit frame lengths are not supported by this test client');
		}
		if (buffer.length - offset < header + length) break;
		frames.push({ opcode, payload: buffer.subarray(offset + header, offset + header + length) });
		offset += header + length;
	}
	return { frames, rest: buffer.subarray(offset) };
};

/**
 * Upgrade a raw TCP socket to a WebSocket.
 *
 * Resolves once the server answers `101`; rejects on any other status or a
 * connection error.
 *
 * @throws Error when the upgrade is refused or the connection fails
 */
export const connect_raw_ws = (options: RawWsConnectOptions): Promise<RawWsClient> =>
	new Promise((resolve, reject) => {
		const { port, hostname = '127.0.0.1', path, headers = {}, pipelined = [] } = options;
		const socket = connect(port, hostname);
		const frames: Array<RawWsFrame> = [];
		const waiters: Array<{
			predicate: (frame: RawWsFrame) => boolean;
			resolve: (frame: RawWsFrame) => void;
		}> = [];
		let buffer: Buffer = Buffer.alloc(0);
		let upgraded = false;

		const client: RawWsClient = {
			frames,
			send_text: (text) => {
				socket.write(encode_client_text(text));
			},
			wait_for: (predicate, timeout_ms = 2000) => {
				const found = frames.find(predicate);
				if (found) return Promise.resolve(found);
				return new Promise((resolve_frame, reject_frame) => {
					const waiter = {
						predicate,
						resolve: (frame: RawWsFrame) => {
							clearTimeout(timer);
							resolve_frame(frame);
						}
					};
					const timer = setTimeout(() => {
						waiters.splice(waiters.indexOf(waiter), 1);
						reject_frame(new Error(`raw ws: no matching frame within ${timeout_ms}ms`));
					}, timeout_ms);
					waiters.push(waiter);
				});
			},
			destroy: () => socket.destroy()
		};

		socket.on('error', reject);
		socket.on('connect', () => {
			const request = [
				`GET ${path} HTTP/1.1`,
				`Host: ${hostname}:${port}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				`Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
				'Sec-WebSocket-Version: 13',
				...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
				'',
				''
			].join('\r\n');
			// one write, so the pipelined frames can't trail the handshake
			socket.write(
				Buffer.concat([Buffer.from(request, 'utf-8'), ...pipelined.map(encode_client_text)])
			);
		});
		socket.on('data', (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (!upgraded) {
				const end = buffer.indexOf('\r\n\r\n');
				if (end === -1) return;
				const status_line = buffer.subarray(0, end).toString('utf-8').split('\r\n')[0]!;
				if (!/^HTTP\/1\.1 101\b/u.test(status_line)) {
					reject(new Error(`raw ws: upgrade refused: ${status_line}`));
					socket.destroy();
					return;
				}
				upgraded = true;
				buffer = buffer.subarray(end + 4);
				resolve(client);
			}
			const taken = take_frames(buffer);
			buffer = taken.rest;
			for (const frame of taken.frames) {
				frames.push(frame);
				// Deliberately no reply to a close frame — this client withholds it.
				for (const waiter of waiters.slice()) {
					if (waiter.predicate(frame)) {
						waiters.splice(waiters.indexOf(waiter), 1);
						waiter.resolve(frame);
					}
				}
			}
		});
	});
