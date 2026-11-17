/**
 * Where each section goes on the two printed pages.
 *
 * The index card is small (5 × 3 inches), so its sections are placed by hand: the columns
 * are filled as evenly as the content allows, and the hex ladder runs along the bottom
 * edge like a ruler. The letter page has room, so it only needs three even columns.
 * `content.test.ts` checks that every section is on each page exactly once.
 */
import type { SectionId } from './content'

export interface PrintLayout {
  /** The sections of each column, top to bottom. */
  columns: readonly (readonly SectionId[])[]
  /** Sections that run across the whole width, under the columns. */
  footer: readonly SectionId[]
}

export const CARD_LAYOUT: PrintLayout = {
  columns: [
    ['registers', 'partial-writes'],
    ['mov', 'addressing', 'lea-vs-mov'],
    ['sizes', 'equ', 'flags-and-jumps'],
    ['stack', 'calling-convention'],
  ],
  footer: ['hex-ladder'],
}

export const LETTER_LAYOUT: PrintLayout = {
  columns: [
    ['registers', 'partial-writes', 'addressing'],
    ['mov', 'lea-vs-mov', 'flags-and-jumps'],
    ['sizes', 'equ', 'stack', 'calling-convention'],
  ],
  footer: ['hex-ladder'],
}
