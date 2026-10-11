import { describe, test, assert } from 'vitest';

import {
	is_cors_simple_content_type,
	is_json_content_type,
	is_post_content_type_refused
} from '#lib/http/simple_request.ts';

describe('is_cors_simple_content_type', () => {
	test('an absent content type is simple', () => {
		assert.isTrue(is_cors_simple_content_type(undefined));
	});

	test('the safelisted types are simple in any spelling', () => {
		for (const value of [
			'text/plain',
			'text/plain;charset=UTF-8',
			'TEXT/PLAIN',
			' text/plain ; charset=utf-8',
			'application/x-www-form-urlencoded',
			'multipart/form-data; boundary=x'
		]) {
			assert.isTrue(is_cors_simple_content_type(value), value);
		}
	});

	test('other types are not simple', () => {
		for (const value of [
			'application/json',
			'application/json; charset=utf-8',
			'application/octet-stream',
			'audio/webm;codecs=opus',
			'text/html',
			'',
			'   '
		]) {
			assert.isFalse(is_cors_simple_content_type(value), value);
		}
	});

	test('a value with non-visible-ASCII characters counts as simple', () => {
		assert.isTrue(is_cors_simple_content_type('text/plain\u00ff'));
		assert.isTrue(is_cors_simple_content_type('application/json\n'));
	});
});

describe('is_json_content_type', () => {
	test('application/json in any case, with parameters', () => {
		for (const value of [
			'application/json',
			'Application/JSON; charset=utf-8',
			' application/json ;charset=utf-8'
		]) {
			assert.isTrue(is_json_content_type(value), value);
		}
	});

	test('anything else is not JSON', () => {
		for (const value of [
			undefined,
			'',
			'   ',
			'text/plain',
			'application/json-seq',
			'application/vnd.api+json',
			'application/json, text/plain',
			'application/json\u00ff'
		]) {
			assert.isFalse(is_json_content_type(value), String(value));
		}
	});
});

describe('is_post_content_type_refused', () => {
	test('a JSON route takes only application/json', () => {
		assert.isFalse(is_post_content_type_refused('application/json; charset=utf-8', false));
		for (const value of [undefined, 'text/plain', 'application/octet-stream']) {
			assert.isTrue(is_post_content_type_refused(value, false), String(value));
		}
	});

	test('a raw_body route takes any type a browser preflights', () => {
		for (const value of ['application/octet-stream', 'audio/webm', 'application/json']) {
			assert.isFalse(is_post_content_type_refused(value, true), value);
		}
		for (const value of [undefined, 'text/plain', 'multipart/form-data; boundary=x']) {
			assert.isTrue(is_post_content_type_refused(value, true), String(value));
		}
	});
});
