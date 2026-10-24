/**
 * Bootstrap token-file parity probe, run in a backend's pre-bootstrap window.
 *
 * Both spines compare the provided token with the token file's raw bytes less
 * one optional trailing LF, nothing else trimmed. Bootstrap is one-shot per
 * backend, so the cases can't live in a test body: `probe_bootstrap_token_file`
 * runs as `bootstrap_backend`'s `before_bootstrap` hook, rewrites the token
 * file with each refused spelling, records each `POST {bootstrap_path}`
 * answer, and leaves the file as the token plus one LF — so the keeper
 * bootstrap that follows is itself the accepted case.
 * `bootstrap_token.cross.test.ts` asserts the recorded answers.
 *
 * @module
 */

import { writeFile } from 'node:fs/promises';

import type { BackendConfig } from '#lib/testing/cross_backend/backend_config.ts';
import { create_fetch_transport } from '#lib/testing/transports/fetch_transport.ts';

/** One refused token-file spelling and the answer a backend gave for it. */
export interface BootstrapTokenProbeResult {
	readonly label: string;
	readonly status: number;
	readonly error: string | null;
}

/** The token-file spellings a backend must refuse, as `[label, file content]` builders. */
export const BOOTSTRAP_TOKEN_FILE_REFUSED: ReadonlyArray<
	readonly [string, (token: string) => string]
> = [
	['CRLF', (t: string): string => `${t}\r\n`],
	['two trailing LFs', (t: string): string => `${t}\n\n`],
	['trailing spaces', (t: string): string => `${t}  \n`],
	['leading LF', (t: string): string => `\n${t}`]
];

/**
 * Probe the bootstrap token-file rule against a backend that has not
 * bootstrapped yet, then leave the file as the token plus one trailing LF.
 *
 * @param config - the backend's config (its token path, bootstrap path, credentials)
 * @returns one result per refused spelling, in `BOOTSTRAP_TOKEN_FILE_REFUSED` order
 */
export const probe_bootstrap_token_file = async (
	config: BackendConfig
): Promise<Array<BootstrapTokenProbeResult>> => {
	const { token, token_path, username, password } = config.bootstrap;
	const transport = create_fetch_transport({ base_url: config.base_url });
	const results: Array<BootstrapTokenProbeResult> = [];
	for (const [label, content] of BOOTSTRAP_TOKEN_FILE_REFUSED) {
		await writeFile(token_path, content(token), { mode: 0o600 });
		const response = await transport(config.bootstrap_path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, username, password })
		});
		const body: unknown = await response.json().catch(() => null);
		const error =
			body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
				? body.error
				: null;
		results.push({ label, status: response.status, error });
	}
	await writeFile(token_path, `${token}\n`, { mode: 0o600 });
	return results;
};
