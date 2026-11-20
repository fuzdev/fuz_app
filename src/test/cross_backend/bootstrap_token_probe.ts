/**
 * Bootstrap token-file probe, run in a backend's pre-bootstrap window.
 *
 * Bootstrap is one-shot per backend, so these cases can't live in a test
 * body: `probe_bootstrap_token_file` runs as `bootstrap_backend`'s
 * `before_bootstrap` hook and records what the backend answered, and
 * `bootstrap_token.cross.test.ts` asserts it. Two parts:
 *
 * - **The token-file spelling.** Both spines compare the provided token with
 *   the file's raw bytes less one optional trailing LF, nothing else trimmed.
 *   The probe rewrites the file with each refused spelling and records each
 *   `POST {bootstrap_path}` answer's whole body, and whether the refusal left
 *   the file byte for byte as it was.
 * - **The burn.** A bootstrap burns its token last inside its transaction,
 *   and a burn that fails rolls it back. With the token's directory made
 *   read-only (`0500`: the file stays readable, its entry can't be unlinked)
 *   the right token is refused `500 token_file_undeletable`; the probe
 *   records that answer, whether the file and its bytes survived, and what
 *   anonymous `GET /api/account/status` reports afterward (the window stays
 *   open). It restores the directory's mode in a `finally`, and the keeper
 *   bootstrap that follows succeeding proves the lock and the account rolled
 *   back; the global setup then records that the token file is gone.
 *
 * The probe leaves the file as the token plus one LF, so that keeper
 * bootstrap is itself the accepted case. It refuses to run as root, whose
 * unlink a read-only directory doesn't stop.
 *
 * @module
 */

import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

import type { BackendConfig } from '#lib/testing/cross_backend/backend_config.ts';
import { create_fetch_transport } from '#lib/testing/transports/fetch_transport.ts';
import { SPINE_ACCOUNT_STATUS_PATH } from '#lib/testing/cross_backend/spine_surface_constants.ts';

/** One answer the probe recorded: the status and the whole JSON body. */
export interface ProbeAnswer {
	readonly status: number;
	/** The parsed body, `null` for a body that is no JSON. */
	readonly body: unknown;
}

/** One refused token-file spelling and the answer a backend gave for it. */
export interface BootstrapTokenProbeResult extends ProbeAnswer {
	readonly label: string;
	/** Whether the file held exactly what the probe wrote after the refusal. */
	readonly file_intact: boolean;
}

/** What the backend did with the right token while its token couldn't be burned. */
export interface BootstrapBurnProbeResult {
	/** The bootstrap's answer. */
	readonly bootstrap: ProbeAnswer;
	/** Whether the token file held exactly what the probe wrote afterward. */
	readonly file_intact: boolean;
	/** Anonymous `GET /api/account/status` afterward. */
	readonly status_after: ProbeAnswer;
}

/** Everything the probe and its global setup recorded. */
export interface BootstrapTokenProbe {
	readonly refused: Array<BootstrapTokenProbeResult>;
	readonly undeletable: BootstrapBurnProbeResult;
	/** Whether the token file was gone once the keeper bootstrap succeeded. */
	readonly token_file_gone_after_bootstrap: boolean;
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
 * A directory mode that leaves the token file readable and its entry
 * unremovable: read and search, no write.
 */
const UNDELETABLE_DIR_MODE = 0o500;

const read_answer = async (response: Response): Promise<ProbeAnswer> => ({
	status: response.status,
	body: await response.json().catch(() => null)
});

const file_holds = async (path: string, content: string): Promise<boolean> => {
	try {
		return (await readFile(path, 'utf-8')) === content;
	} catch {
		return false;
	}
};

/**
 * Whether `path` is gone.
 *
 * @param path - the token file
 * @returns `true` when nothing is at the path
 */
export const token_file_gone = async (path: string): Promise<boolean> => {
	try {
		await stat(path);
		return false;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
		throw err;
	}
};

/**
 * Probe the bootstrap token-file rules against a backend that has not
 * bootstrapped yet, then leave the file as the token plus one trailing LF.
 *
 * @param config - the backend's config (its token path, bootstrap path, credentials)
 * @returns the spelling refusals, in `BOOTSTRAP_TOKEN_FILE_REFUSED` order, and the burn probe
 * @throws Error when run as root, which a read-only directory doesn't stop from unlinking
 */
export const probe_bootstrap_token_file = async (
	config: BackendConfig
): Promise<Omit<BootstrapTokenProbe, 'token_file_gone_after_bootstrap'>> => {
	if (process.getuid?.() === 0) {
		throw new Error(
			'the bootstrap token probe refuses to run as root: a root process unlinks in a read-only directory, so the undeletable-token case could not fail'
		);
	}
	const { token, token_path, username, password } = config.bootstrap;
	const transport = create_fetch_transport({ base_url: config.base_url });
	const post_bootstrap = () =>
		transport(config.bootstrap_path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, username, password })
		});

	const refused: Array<BootstrapTokenProbeResult> = [];
	for (const [label, spell] of BOOTSTRAP_TOKEN_FILE_REFUSED) {
		const content = spell(token);
		await writeFile(token_path, content, { mode: 0o600 });
		const answer = await read_answer(await post_bootstrap());
		refused.push({ label, ...answer, file_intact: await file_holds(token_path, content) });
	}

	const accepted = `${token}\n`;
	await writeFile(token_path, accepted, { mode: 0o600 });
	const dir = dirname(token_path);
	const { mode: dir_mode } = await stat(dir);
	let undeletable: BootstrapBurnProbeResult;
	try {
		await chmod(dir, UNDELETABLE_DIR_MODE);
		const bootstrap = await read_answer(await post_bootstrap());
		const file_intact = await file_holds(token_path, accepted);
		const status_after = await read_answer(
			await transport(SPINE_ACCOUNT_STATUS_PATH, { method: 'GET' })
		);
		undeletable = { bootstrap, file_intact, status_after };
	} finally {
		await chmod(dir, dir_mode & 0o7777);
	}
	return { refused, undeletable };
};
