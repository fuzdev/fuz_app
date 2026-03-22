/**
 * Tests for error_schemas.ts — standard error schemas and auto-derivation.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {
	ApiError,
	ValidationError,
	PermissionError,
	KeeperError,
	RateLimitError,
	PayloadTooLargeError,
	ForeignKeyError,
	derive_error_schemas,
	ERROR_INVALID_REQUEST_BODY,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_ROUTE_PARAMS,
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_KEEPER_REQUIRES_DAEMON_TOKEN,
	ERROR_BEARER_REJECTED_BROWSER,
	ERROR_INVALID_TOKEN,
	ERROR_ACCOUNT_NOT_FOUND,
	ERROR_FORBIDDEN_ORIGIN,
	ERROR_FORBIDDEN_REFERER,
	ERROR_RATE_LIMIT_EXCEEDED,
	ERROR_INVALID_CREDENTIALS,
	ERROR_INVALID_DAEMON_TOKEN,
	ERROR_KEEPER_ACCOUNT_NOT_CONFIGURED,
	ERROR_KEEPER_ACCOUNT_NOT_FOUND,
	ERROR_ALREADY_BOOTSTRAPPED,
	ERROR_TOKEN_FILE_MISSING,
	ERROR_BOOTSTRAP_NOT_CONFIGURED,
	ERROR_ROLE_NOT_WEB_GRANTABLE,
	ERROR_PERMIT_NOT_FOUND,
	ERROR_INVALID_EVENT_TYPE,
	ERROR_PAYLOAD_TOO_LARGE,
	ERROR_FOREIGN_KEY_VIOLATION,
	ERROR_TABLE_NOT_FOUND,
	ERROR_TABLE_NO_PRIMARY_KEY,
	ERROR_ROW_NOT_FOUND,
	ERROR_INVALID_QUERY_PARAMS,
	ERROR_NO_MATCHING_INVITE,
	ERROR_SIGNUP_CONFLICT,
	ERROR_INVITE_NOT_FOUND,
	ERROR_INVITE_MISSING_IDENTIFIER,
	ERROR_INVITE_DUPLICATE,
	ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
	ERROR_INVITE_ACCOUNT_EXISTS_EMAIL,
} from '$lib/http/error_schemas.js';

describe('standard error schemas', () => {
	test('ApiError accepts basic error response', () => {
		const result = ApiError.safeParse({error: ERROR_AUTHENTICATION_REQUIRED});
		assert.isTrue(result.success);
	});

	test('ApiError allows extra fields (looseObject)', () => {
		const result = ApiError.safeParse({error: 'test', extra: 'field'});
		assert.isTrue(result.success);
	});

	test('ApiError rejects missing error field', () => {
		const result = ApiError.safeParse({message: 'wrong'});
		assert.isFalse(result.success);
	});

	test('ValidationError accepts error with issues', () => {
		const result = ValidationError.safeParse({
			error: 'invalid_request_body',
			issues: [{code: 'invalid_type', message: 'Expected string', path: ['name']}],
		});
		assert.isTrue(result.success);
	});

	test('PermissionError requires insufficient_permissions literal', () => {
		const valid = PermissionError.safeParse({
			error: ERROR_INSUFFICIENT_PERMISSIONS,
			required_role: 'admin',
		});
		assert.isTrue(valid.success);

		const invalid = PermissionError.safeParse({
			error: 'wrong_error',
			required_role: 'admin',
		});
		assert.isFalse(invalid.success);
	});

	test('KeeperError requires keeper_requires_daemon_token literal', () => {
		const valid = KeeperError.safeParse({
			error: ERROR_KEEPER_REQUIRES_DAEMON_TOKEN,
			credential_type: 'session',
		});
		assert.isTrue(valid.success);
	});

	test('RateLimitError requires rate_limit_exceeded and retry_after', () => {
		const valid = RateLimitError.safeParse({
			error: ERROR_RATE_LIMIT_EXCEEDED,
			retry_after: 60,
		});
		assert.isTrue(valid.success);

		const missing_retry = RateLimitError.safeParse({
			error: ERROR_RATE_LIMIT_EXCEEDED,
		});
		assert.isFalse(missing_retry.success);
	});

	test('PayloadTooLargeError requires payload_too_large literal', () => {
		const valid = PayloadTooLargeError.safeParse({error: ERROR_PAYLOAD_TOO_LARGE});
		assert.isTrue(valid.success);

		const invalid = PayloadTooLargeError.safeParse({error: 'wrong_error'});
		assert.isFalse(invalid.success);
	});

	test('ForeignKeyError accepts error without detail or constraint', () => {
		const result = ForeignKeyError.safeParse({
			error: ERROR_FOREIGN_KEY_VIOLATION,
		});
		assert.isTrue(result.success);
	});
});

describe('derive_error_schemas', () => {
	test('auth none + no input derives no errors', () => {
		const errors = derive_error_schemas({type: 'none'}, false);
		assert.deepStrictEqual(errors, {});
	});

	test('auth none + has input derives 400', () => {
		const errors = derive_error_schemas({type: 'none'}, true);
		assert.ok(errors[400]);
		assert.strictEqual(errors[401], undefined);
	});

	test('auth authenticated derives 401', () => {
		const errors = derive_error_schemas({type: 'authenticated'}, false);
		assert.ok(errors[401]);
		assert.strictEqual(errors[403], undefined);
	});

	test('auth authenticated + has input derives 400 and 401', () => {
		const errors = derive_error_schemas({type: 'authenticated'}, true);
		assert.ok(errors[400]);
		assert.ok(errors[401]);
	});

	test('auth role derives 401 and 403 with PermissionError', () => {
		const errors = derive_error_schemas({type: 'role', role: 'admin'}, false);
		assert.ok(errors[401]);
		assert.ok(errors[403]);
		// Verify the 403 schema is PermissionError (accepts required_role)
		const result = (errors[403] as any).safeParse({
			error: ERROR_INSUFFICIENT_PERMISSIONS,
			required_role: 'admin',
		});
		assert.isTrue(result.success);
	});

	test('auth keeper derives 401 and 403 with KeeperError', () => {
		const errors = derive_error_schemas({type: 'keeper'}, false);
		assert.ok(errors[401]);
		assert.ok(errors[403]);
		// Verify the 403 schema is KeeperError (accepts credential_type)
		const result = (errors[403] as any).safeParse({
			error: ERROR_KEEPER_REQUIRES_DAEMON_TOKEN,
			credential_type: 'session',
		});
		assert.isTrue(result.success);
	});

	test('does not auto-derive 429 without rate_limit', () => {
		const errors = derive_error_schemas({type: 'none'}, true);
		assert.strictEqual(errors[429], undefined);
	});

	test('rate_limit ip derives 429', () => {
		const errors = derive_error_schemas({type: 'none'}, false, false, false, 'ip');
		assert.ok(errors[429]);
	});

	test('rate_limit account derives 429', () => {
		const errors = derive_error_schemas({type: 'none'}, false, false, false, 'account');
		assert.ok(errors[429]);
	});

	test('rate_limit both derives 429', () => {
		const errors = derive_error_schemas({type: 'none'}, true, false, false, 'both');
		assert.ok(errors[400]);
		assert.ok(errors[429]);
	});

	test('has_params derives 400', () => {
		const errors = derive_error_schemas({type: 'none'}, false, true);
		assert.ok(errors[400]);
	});

	test('has_query derives 400', () => {
		const errors = derive_error_schemas({type: 'none'}, false, false, true);
		assert.ok(errors[400]);
	});
});

describe('error code constants', () => {
	test('constants match expected string values', () => {
		assert.strictEqual(ERROR_INVALID_REQUEST_BODY, 'invalid_request_body');
		assert.strictEqual(ERROR_INVALID_JSON_BODY, 'invalid_json_body');
		assert.strictEqual(ERROR_INVALID_ROUTE_PARAMS, 'invalid_route_params');
		assert.strictEqual(ERROR_INVALID_QUERY_PARAMS, 'invalid_query_params');
		assert.strictEqual(ERROR_AUTHENTICATION_REQUIRED, 'authentication_required');
		assert.strictEqual(ERROR_INSUFFICIENT_PERMISSIONS, 'insufficient_permissions');
		assert.strictEqual(ERROR_KEEPER_REQUIRES_DAEMON_TOKEN, 'keeper_requires_daemon_token');
		assert.strictEqual(ERROR_BEARER_REJECTED_BROWSER, 'bearer_token_rejected_in_browser_context');
		assert.strictEqual(ERROR_INVALID_TOKEN, 'invalid_token');
		assert.strictEqual(ERROR_ACCOUNT_NOT_FOUND, 'account_not_found');
		assert.strictEqual(ERROR_FORBIDDEN_ORIGIN, 'forbidden_origin');
		assert.strictEqual(ERROR_FORBIDDEN_REFERER, 'forbidden_referer');
		assert.strictEqual(ERROR_RATE_LIMIT_EXCEEDED, 'rate_limit_exceeded');
		assert.strictEqual(ERROR_INVALID_CREDENTIALS, 'invalid_credentials');
		assert.strictEqual(ERROR_INVALID_DAEMON_TOKEN, 'invalid_daemon_token');
		assert.strictEqual(ERROR_KEEPER_ACCOUNT_NOT_CONFIGURED, 'keeper_account_not_configured');
		assert.strictEqual(ERROR_KEEPER_ACCOUNT_NOT_FOUND, 'keeper_account_not_found');
		assert.strictEqual(ERROR_ALREADY_BOOTSTRAPPED, 'already_bootstrapped');
		assert.strictEqual(ERROR_TOKEN_FILE_MISSING, 'token_file_missing');
		assert.strictEqual(ERROR_BOOTSTRAP_NOT_CONFIGURED, 'bootstrap_not_configured');
		assert.strictEqual(ERROR_ROLE_NOT_WEB_GRANTABLE, 'role_not_web_grantable');
		assert.strictEqual(ERROR_PERMIT_NOT_FOUND, 'permit_not_found');
		assert.strictEqual(ERROR_INVALID_EVENT_TYPE, 'invalid_event_type');
		assert.strictEqual(ERROR_PAYLOAD_TOO_LARGE, 'payload_too_large');
		assert.strictEqual(ERROR_FOREIGN_KEY_VIOLATION, 'foreign_key_violation');
		assert.strictEqual(ERROR_TABLE_NOT_FOUND, 'table_not_found');
		assert.strictEqual(ERROR_TABLE_NO_PRIMARY_KEY, 'table_no_primary_key');
		assert.strictEqual(ERROR_ROW_NOT_FOUND, 'row_not_found');
		assert.strictEqual(ERROR_NO_MATCHING_INVITE, 'no_matching_invite');
		assert.strictEqual(ERROR_SIGNUP_CONFLICT, 'signup_conflict');
		assert.strictEqual(ERROR_INVITE_NOT_FOUND, 'invite_not_found');
		assert.strictEqual(ERROR_INVITE_MISSING_IDENTIFIER, 'invite_missing_identifier');
		assert.strictEqual(ERROR_INVITE_DUPLICATE, 'invite_duplicate');
		assert.strictEqual(ERROR_INVITE_ACCOUNT_EXISTS_USERNAME, 'invite_account_exists_username');
		assert.strictEqual(ERROR_INVITE_ACCOUNT_EXISTS_EMAIL, 'invite_account_exists_email');
	});

	test('constants are used by standard error schemas', () => {
		assert.isTrue(ApiError.safeParse({error: ERROR_AUTHENTICATION_REQUIRED}).success);
		assert.isTrue(
			PermissionError.safeParse({
				error: ERROR_INSUFFICIENT_PERMISSIONS,
				required_role: 'admin',
			}).success,
		);
		assert.isTrue(
			KeeperError.safeParse({
				error: ERROR_KEEPER_REQUIRES_DAEMON_TOKEN,
				credential_type: 'session',
			}).success,
		);
		assert.isTrue(
			ValidationError.safeParse({
				error: ERROR_INVALID_REQUEST_BODY,
				issues: [{code: 'invalid_type', message: 'Expected string', path: ['name']}],
			}).success,
		);
		assert.isTrue(
			RateLimitError.safeParse({
				error: ERROR_RATE_LIMIT_EXCEEDED,
				retry_after: 60,
			}).success,
		);
		assert.isTrue(
			PayloadTooLargeError.safeParse({
				error: ERROR_PAYLOAD_TOO_LARGE,
			}).success,
		);
		assert.isTrue(
			ForeignKeyError.safeParse({
				error: ERROR_FOREIGN_KEY_VIOLATION,
			}).success,
		);
	});
});
