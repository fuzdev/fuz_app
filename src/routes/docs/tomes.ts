import type {Tome} from '@fuzdev/fuz_ui/tome.ts';
import introduction from './introduction/+page.svelte';
import ApiPage from './api/+page.svelte';
import LibraryPage from './library/+page.svelte';

export const tomes: Array<Tome> = [
	{
		slug: 'introduction',
		category: 'guide',
		Component: introduction,
		related_tomes: [],
		related_modules: [],
		related_declarations: [],
	},
	{
		slug: 'api',
		category: 'reference',
		Component: ApiPage,
		related_tomes: [],
		related_modules: [],
		related_declarations: [],
	},
	{
		slug: 'library',
		category: 'reference',
		Component: LibraryPage,
		related_tomes: [],
		related_modules: [],
		related_declarations: [],
	},
];
