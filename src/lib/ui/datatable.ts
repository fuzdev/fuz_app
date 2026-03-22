/**
 * Types and constants for the `Datatable` component.
 *
 * @module
 */

/** Default minimum column width in pixels. */
export const DATATABLE_MIN_COLUMN_WIDTH = 50;

/** Default initial column width in pixels. */
export const DATATABLE_COLUMN_WIDTH_DEFAULT = 120;

/**
 * Column definition for a `Datatable`.
 */
export interface DatatableColumn<T = unknown> {
	/** Row data accessor key. */
	key: string & keyof T;
	/** Header label text. */
	label: string;
	/** Initial column width in pixels. */
	width?: number;
	/** Minimum column width in pixels. */
	min_width?: number;
	/** Format a cell value for display. Falls back to `format_value` when absent. */
	format?: (value: T[keyof T], row: T) => string;
}
