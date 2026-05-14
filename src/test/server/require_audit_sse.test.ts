import {describe, test, assert} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {require_audit_sse} from '$lib/server/app_server.js';
import {create_audit_log_sse} from '$lib/realtime/sse_auth_guard.js';

const log = new Logger('test:require_audit_sse', {level: 'off'});

describe('require_audit_sse', () => {
	test('returns the audit_sse when non-null', () => {
		const audit_sse = create_audit_log_sse({log});
		const result = require_audit_sse({audit_sse});
		assert.strictEqual(result, audit_sse);
	});

	test('throws a labelled error when audit_sse is null', () => {
		assert.throws(
			() => require_audit_sse({audit_sse: null}),
			/audit_sse is null.*audit_log_sse.*AppServerOptions/,
		);
	});
});
