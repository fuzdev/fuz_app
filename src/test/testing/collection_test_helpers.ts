/**
 * A probe for what a suite factory throws while it registers its tests.
 *
 * @module
 */

import { describe, type RunnerTask } from 'vitest';

/** What a registration threw, read once collection has finished. */
export interface RegistrationOutcome {
	/** The thrown message, or `null` when the registration threw nothing. */
	readonly error: string | null;
}

/**
 * Run `register` inside a `describe.skip` callback, so the suite factory
 * collects as it would in a consumer's file but none of its tests run, and
 * record what it threw. vitest runs a describe callback during collection,
 * so read the outcome from a test.
 *
 * @param label - the skipped describe's title
 * @param register - calls the suite factory under test
 * @returns the outcome, filled in at collection
 */
export const probe_registration = (label: string, register: () => void): RegistrationOutcome => {
	const outcome: { error: string | null } = { error: null };
	describe.skip(label, () => {
		try {
			register();
		} catch (e) {
			outcome.error = e instanceof Error ? e.message : String(e);
		}
	});
	return outcome;
};

/**
 * The names of every test registered under the describe titled `label` in
 * `file` — read from a test, once collection has finished.
 *
 * @param file - the test file's task (`ctx.task.file`)
 * @param label - the describe's title, as passed to `probe_registration`
 * @returns the test names, depth first
 * @throws Error when no describe in `file` has that title
 */
export const registered_test_names = (file: RunnerTask, label: string): Array<string> => {
	const find = (task: RunnerTask): RunnerTask | null => {
		if (task.type === 'suite' && task.name === label) return task;
		if (!('tasks' in task)) return null;
		for (const child of task.tasks) {
			const found = find(child);
			if (found) return found;
		}
		return null;
	};
	const suite = find(file);
	if (!suite) throw new Error(`no describe titled '${label}'`);
	const names: Array<string> = [];
	const walk = (task: RunnerTask): void => {
		if (task.type === 'test') names.push(task.name);
		else if ('tasks' in task) for (const child of task.tasks) walk(child);
	};
	walk(suite);
	return names;
};
