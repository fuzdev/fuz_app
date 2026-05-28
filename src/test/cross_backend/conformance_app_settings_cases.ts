/**
 * App-settings conformance cases.
 *
 * Pins the admin gate on both app-settings RPC methods across every spine:
 * an anonymous caller is refused (401), an authenticated non-admin is
 * refused (403), and an admin holder succeeds (200, output validated
 * against the spec). Both methods live on the standard declared surface, so
 * the table runner resolves them directly on the TS spines and the Rust
 * `spine_stub` alike — no live-mount.
 *
 * Every `note` cites a **public** `security.md` property (the table ships
 * in a public package — no grimoire refs).
 *
 * @module
 */

import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
} from '$lib/http/error_schemas.js';
import type {ConformanceCase} from '$lib/testing/cross_backend/conformance_case.js';

export const conformance_app_settings_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'anonymous → app_settings_get → 401',
		request: {method: 'app_settings_get', as: 'anonymous'},
		expect: {status: 401, error_reason: ERROR_AUTHENTICATION_REQUIRED},
		note: 'security.md §Signup — app settings are admin-only; an unauthenticated caller cannot read them',
	},
	{
		name: 'fresh non-admin → app_settings_get → 403',
		request: {method: 'app_settings_get', as: 'fresh_non_admin'},
		expect: {status: 403, error_reason: ERROR_INSUFFICIENT_PERMISSIONS},
		note: 'security.md §Signup — reading app settings requires the admin role',
	},
	{
		name: 'admin → app_settings_get → 200',
		request: {method: 'app_settings_get', as: 'keeper'},
		expect: {status: 200},
		note: 'security.md §Signup — an admin reads app settings; the result validates against the app_settings_get output schema',
	},
	{
		name: 'anonymous → app_settings_update → 401',
		request: {method: 'app_settings_update', as: 'anonymous', params: {open_signup: true}},
		expect: {status: 401, error_reason: ERROR_AUTHENTICATION_REQUIRED},
		note: 'security.md §Signup — the open_signup toggle is admin-only; an unauthenticated caller cannot change it',
	},
	{
		name: 'fresh non-admin → app_settings_update → 403',
		request: {method: 'app_settings_update', as: 'fresh_non_admin', params: {open_signup: true}},
		expect: {status: 403, error_reason: ERROR_INSUFFICIENT_PERMISSIONS},
		note: 'security.md §Signup — changing the open_signup toggle requires the admin role',
	},
	{
		name: 'admin → app_settings_update → 200',
		request: {method: 'app_settings_update', as: 'keeper', params: {open_signup: true}},
		expect: {status: 200},
		note: 'security.md §Signup — an admin toggles open_signup; the result validates against the app_settings_update output schema',
	},
];
