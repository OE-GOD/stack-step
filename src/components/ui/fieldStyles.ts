/**
 * The look of a form field, shared by <Input> and <Select>: 44 px tall, a border that
 * stands out enough from the page (3:1), and the site's focus outline.
 */
export const FIELD_CLASSES =
  'block min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-base text-ink ' +
  'placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-55 ' +
  'aria-invalid:border-bad'
