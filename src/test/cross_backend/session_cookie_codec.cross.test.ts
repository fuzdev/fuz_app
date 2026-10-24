/**
 * Cross-process session cookie codec parity for fuz_app's own spine over real
 * HTTP: each spawned backend — the TS spine binaries + the Rust
 * `testing_spine_stub` — accepts exactly one spelling of a signed cookie. The
 * session cookie is on every spine, so the suite is ungated.
 *
 * @module
 */

import { inject } from 'vitest';

import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '#lib/testing/cross_backend/setup.ts';
import { describe_session_cookie_codec_cross_tests } from '#lib/testing/cross_backend/session_cookie_codec.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { cookie_name, rpc_path, env } = handle.config;
const cookie_keys = env.SECRET_FUZ_COOKIE_KEYS;
if (!cookie_keys) throw new Error('the backend config sets no SECRET_FUZ_COOKIE_KEYS');

describe_session_cookie_codec_cross_tests({ setup_test, cookie_name, cookie_keys, rpc_path });
