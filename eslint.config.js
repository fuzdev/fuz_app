import {configs} from '@ryanatkn/eslint-config';

// TODO disable until eslint-plugin-svelte fixes crash on empty/boolean attribute values
// https://github.com/sveltejs/eslint-plugin-svelte/issues/1493
export default [
	...configs,
	{rules: {'svelte/no-navigation-without-resolve': 'off'}},
];
