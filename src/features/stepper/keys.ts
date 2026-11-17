/**
 * The names of the modifier keys, as the student's keyboard shows them: Cmd and Option on
 * a Mac, Ctrl and Alt everywhere else.
 */
const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

export const MOD_KEY = {
  /** What a key cap says. */
  label: IS_MAC ? 'Cmd' : 'Ctrl',
  /** The name for `aria-keyshortcuts`. */
  aria: IS_MAC ? 'Meta' : 'Control',
  alt: IS_MAC ? 'Option' : 'Alt',
} as const
