import { describe, test, assert } from 'vitest';

import { read_content_type } from '#lib/http/request_headers.ts';
import {
	is_cors_simple_content_type,
	is_json_content_type,
	is_post_content_type_refused
} from '#lib/http/simple_request.ts';

/** The reading of one `Content-Type` line, or of none for `undefined`. */
const read = (value: string | undefined) => read_content_type(value === undefined ? [] : [value]);

describe('is_cors_simple_content_type', () => {
	test('an absent content type is simple', () => {
		assert.isTrue(is_cors_simple_content_type(read(undefined)));
	});

	test('the safelisted types are simple in any spelling', () => {
		for (const value of [
			'text/plain',
			'text/plain;charset=UTF-8',
			'TEXT/PLAIN',
			'text/plain ; charset=utf-8',
			'application/x-www-form-urlencoded',
			'multipart/form-data; boundary=x'
		]) {
			assert.isTrue(is_cors_simple_content_type(read(value)), value);
		}
	});

	test('other well-formed types are not simple', () => {
		for (const value of [
			'application/json',
			'application/json; charset=utf-8',
			'application/octet-stream',
			'audio/webm;codecs=opus',
			'text/html'
		]) {
			assert.isFalse(is_cors_simple_content_type(read(value)), value);
		}
	});

	test('a malformed content type counts as simple', () => {
		for (const value of [
			'',
			'text/plain\u00ff',
			'application/json\n',
			'application/octet-stream, text/plain',
			'application'
		]) {
			assert.isTrue(is_cors_simple_content_type(read(value)), JSON.stringify(value));
		}
		assert.isTrue(
			is_cors_simple_content_type(read_content_type(['application/octet-stream', 'audio/webm']))
		);
	});
});

describe('is_json_content_type', () => {
	test('application/json in any case, with parameters', () => {
		for (const value of [
			'application/json',
			'Application/JSON; charset=utf-8',
			'application/json ;charset=utf-8'
		]) {
			assert.isTrue(is_json_content_type(read(value)), value);
		}
	});

	test('anything else is not JSON', () => {
		for (const value of [
			undefined,
			'',
			'text/plain',
			'application/json-seq',
			'application/vnd.api+json',
			'application/json, text/plain',
			'application/json; charset="a,b"',
			'application/json\u00ff'
		]) {
			assert.isFalse(is_json_content_type(read(value)), String(value));
		}
		assert.isFalse(
			is_json_content_type(read_content_type(['application/json', 'application/json']))
		);
	});
});

describe('is_post_content_type_refused', () => {
	test('a JSON route takes only application/json', () => {
		assert.isFalse(is_post_content_type_refused(read('application/json; charset=utf-8'), false));
		for (const value of [undefined, 'text/plain', 'application/octet-stream']) {
			assert.isTrue(is_post_content_type_refused(read(value), false), String(value));
		}
	});

	test('a raw_body route takes any well-formed type a browser preflights', () => {
		for (const value of ['application/octet-stream', 'audio/webm', 'application/json']) {
			assert.isFalse(is_post_content_type_refused(read(value), true), value);
		}
		for (const value of [
			undefined,
			'',
			'text/plain',
			'multipart/form-data; boundary=x',
			'application/octet-stream, x/y'
		]) {
			assert.isTrue(is_post_content_type_refused(read(value), true), String(value));
		}
		assert.isTrue(
			is_post_content_type_refused(read_content_type(['application/octet-stream', 'x/y']), true),
			'two lines'
		);
	});
});
