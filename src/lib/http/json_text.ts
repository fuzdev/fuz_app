/**
 * JSON text read as the Rust spine's `serde_json` reads it.
 *
 * `JSON.parse` accepts three things `serde_json` refuses: an escaped lone
 * surrogate (`"\ud800"`, in a string or a key), a number out of `f64` range
 * (`1e400`, which `JSON.parse` reads as `Infinity`), and nesting 128 deep or
 * more. Accepted, they don't survive storage: a lone surrogate is written to a
 * text column as U+FFFD and refused by a `jsonb` one, and `Infinity`
 * serializes as `null`. `parse_json_text` refuses all three, so a request body
 * or frame gets the same verdict on both spines (`invalid_json_body` for a
 * REST body, `parse_error` for a JSON-RPC body or frame, `invalid_params` for
 * `GET /rpc`'s `params`).
 *
 * The check is one linear pass over the text after `JSON.parse` accepts it
 * (`is_serde_json_text`): a few milliseconds a MiB, whatever the text holds.
 *
 * @module
 */

/** The nesting depth `serde_json` refuses: a value nested this deep or deeper fails. */
export const JSON_DEPTH_LIMIT = 128;

/**
 * The digits a number's mantissa (or exponent, `NUMBER_EXPONENT_DIGITS_CHECKED`)
 * reaches before it can be out of `f64` range: with an exponent of two digits
 * at most, a mantissa needs more than 200 digits to pass `f64::MAX`. A number
 * this long is read with `Number` to see.
 */
const NUMBER_MANTISSA_DIGITS_CHECKED = 200;
const NUMBER_EXPONENT_DIGITS_CHECKED = 3;

const hex4 = (text: string, at: number): number => parseInt(text.slice(at, at + 4), 16);

const is_high_surrogate = (u: number): boolean => u >= 0xd800 && u <= 0xdbff;
const is_low_surrogate = (u: number): boolean => u >= 0xdc00 && u <= 0xdfff;

/**
 * Whether `text`, which `JSON.parse` accepted, holds nothing `serde_json`
 * refuses — one pass over the text, so its cost is linear whatever it holds:
 *
 * - every `\u` escape of a surrogate is a high one followed at once by a low
 *   one's escape, in a string or a key
 * - nesting stays under `JSON_DEPTH_LIMIT`, counted outside strings
 * - a number long enough to leave `f64` range is finite as `Number` reads it
 *
 * The text, not the parsed value, is what is read: `JSON.parse` keeps the last
 * of two duplicate keys, so a refused value under the first would never be seen,
 * where `serde_json` refuses it as it reads.
 */
const is_serde_json_text = (text: string): boolean => {
	let depth = 0;
	const length = text.length;
	for (let i = 0; i < length; i++) {
		const c = text.charCodeAt(i);
		if (c === 0x22) {
			// a string: the text is valid JSON, so every escape is well formed
			for (i++; ; i++) {
				const d = text.charCodeAt(i);
				if (d === 0x22) break;
				if (d !== 0x5c) continue;
				i++;
				if (text.charCodeAt(i) !== 0x75) continue;
				const unit = hex4(text, i + 1);
				i += 4;
				if (is_low_surrogate(unit)) return false;
				if (!is_high_surrogate(unit)) continue;
				if (
					text.charCodeAt(i + 1) !== 0x5c ||
					text.charCodeAt(i + 2) !== 0x75 ||
					!is_low_surrogate(hex4(text, i + 3))
				) {
					return false;
				}
				i += 6;
			}
		} else if (c === 0x5b || c === 0x7b) {
			if (++depth >= JSON_DEPTH_LIMIT) return false;
		} else if (c === 0x5d || c === 0x7d) {
			depth--;
		} else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
			const start = i;
			let mantissa_digits = 0;
			let exponent_digits = 0;
			let in_exponent = false;
			for (; i < length; i++) {
				const d = text.charCodeAt(i);
				if (d >= 0x30 && d <= 0x39) {
					if (in_exponent) exponent_digits++;
					else mantissa_digits++;
				} else if (d === 0x65 || d === 0x45) {
					in_exponent = true;
				} else if (d !== 0x2d && d !== 0x2b && d !== 0x2e) {
					break;
				}
			}
			if (
				(mantissa_digits >= NUMBER_MANTISSA_DIGITS_CHECKED ||
					exponent_digits >= NUMBER_EXPONENT_DIGITS_CHECKED) &&
				!Number.isFinite(Number(text.slice(start, i)))
			) {
				return false;
			}
			i--;
		}
	}
	return true;
};

/**
 * Parses JSON text as `JSON.parse` does, refusing what `serde_json` refuses:
 * an escaped lone surrogate, a number out of `f64` range, and nesting
 * `JSON_DEPTH_LIMIT` deep or more.
 *
 * @param text - the JSON text
 * @returns the parsed value
 * @throws SyntaxError when `JSON.parse` throws or the text has one of the three
 */
export const parse_json_text = (text: string): unknown => {
	const value: unknown = JSON.parse(text);
	if (!is_serde_json_text(text)) {
		throw new SyntaxError('JSON text has a value the Rust spine refuses');
	}
	return value;
};

/** A request body read as JSON by `read_json_body`: the value, or a refusal. */
export type JsonBodyResult = { ok: true; value: unknown } | { ok: false };

/** The request a body is read from: Hono's `c.req`, structurally, so this module stays hono-free. */
export interface JsonBodyRequest {
	raw: Request;
	text: () => Promise<string>;
}

const json_body_cache: WeakMap<Request, Promise<JsonBodyResult>> = new WeakMap();

/**
 * Reads a request body as JSON text through `parse_json_text`, once per
 * request: the authorization phase's `acting` read and input validation share
 * the one parse. Reads the body with `c.req.text()`, as `parse_json_text`
 * reads the text and not a parsed value.
 *
 * @param req - the request, Hono's `c.req`
 * @returns the parsed body, or `{ok: false}` when it isn't JSON text `parse_json_text` accepts
 */
export const read_json_body = (req: JsonBodyRequest): Promise<JsonBodyResult> => {
	let result = json_body_cache.get(req.raw);
	if (!result) {
		result = req.text().then(
			(text): JsonBodyResult => {
				try {
					return { ok: true, value: parse_json_text(text) };
				} catch {
					return { ok: false };
				}
			},
			(): JsonBodyResult => ({ ok: false })
		);
		json_body_cache.set(req.raw, result);
	}
	return result;
};
