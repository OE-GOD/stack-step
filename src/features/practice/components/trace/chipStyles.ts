/**
 * The look of a chip and of the cell it goes into (Tailwind classes).
 *
 * A chip looks the same in the tray, in a cell and under the pointer while it is
 * dragged. The dragged copy is drawn outside the trace table (so that nothing can clip
 * it), which is why the inside of a chip (font size, space around the text) follows the
 * width of the SCREEN (`sm:`), not the width of the table (`@lg:`): the copy must match
 * the chip it was picked up from.
 *
 * Widths are in `ch` (the width of one digit), because a chip holds a fixed number of
 * characters: the value is `0x` and 16 digits in four groups with three small gaps between
 * them (0.35ch each, as in HexText), so 19.05ch; with `rax = ` in front, 25.05ch.
 *
 * The table sits beside the tray from a width of 44rem (a laptop's practice card is about
 * 53rem wide); below that the tray comes after the table.
 */

/** Monospace text, 14 px like all the text a student reads on a phone. */
export const CHIP_TEXT = 'font-mono text-sm leading-[1.3]'

/** The box of a chip: at least 44 px tall, so it is easy to hit with a thumb. */
export const CHIP_BOX =
  'relative flex min-h-11 w-full items-center rounded-lg border px-1.5 py-1 text-left sm:px-2.5'

/** A chip that waits: in the tray or in a cell. */
export const CHIP_IDLE = 'border-line-strong bg-surface text-ink shadow-xs'

/** A chip that can be picked up. The hand cursor and the hover color are for mouse users. */
export const CHIP_GRAB =
  'cursor-grab transition-colors hover:border-primary hover:bg-primary-soft active:cursor-grabbing'

/** The selected chip: a thicker blue edge (and the word "selected" on it). */
export const CHIP_SELECTED = 'border-primary bg-primary-soft text-ink ring-2 ring-primary'

/** A chip in a cell that the selected chip would replace: a dashed blue edge (and a label). */
export const CHIP_REPLACE =
  'cursor-pointer border-dashed border-primary bg-surface text-ink shadow-xs ' +
  'hover:border-solid hover:ring-1 hover:ring-primary'

/** A chip in a cell while another chip is held over it: a solid, thicker edge (and a label). */
export const CHIP_OVER = 'border-primary bg-primary-soft text-ink ring-2 ring-primary'

/** What stays behind while the chip is dragged: a faint copy. */
export const CHIP_GHOST = 'opacity-40'

/** The copy that follows the pointer: lifted off the page. */
export const CHIP_LIFTED =
  'h-full -rotate-1 scale-[1.03] cursor-grabbing border-primary bg-surface text-ink shadow-lg ring-2 ring-primary'

/** A chip after Check: it cannot move any more. */
export const CHIP_LOCKED = 'border-line-strong bg-surface text-ink'

/** A chip on a phone or a mouse must not select text, zoom on double tap or open a menu. */
export const NO_TOUCH_EXTRAS = 'touch-manipulation select-none [-webkit-touch-callout:none]'

/** An empty cell: a dashed box of the same size as a chip, with a few words in it. */
export const SLOT_BOX =
  'relative flex min-h-11 w-full items-center justify-center rounded-lg border px-1 py-1 text-center font-sans text-sm leading-tight'

/** Nothing is selected or dragged. */
export const SLOT_IDLE = 'cursor-default border-dashed border-line-strong text-muted'

/** A chip is selected: a tap puts it here. */
export const SLOT_READY =
  'cursor-pointer border-dashed border-primary bg-primary-soft font-semibold text-primary ' +
  'hover:border-solid hover:ring-1 hover:ring-primary'

/** A chip is being dragged, but not over this cell. */
export const SLOT_OPEN = 'border-dashed border-primary text-muted'

/** The dragged chip is over this cell: a solid, thicker edge and other words. */
export const SLOT_OVER =
  'border-solid border-primary bg-primary-soft font-bold text-primary ring-2 ring-primary'

/**
 * A small label that sits on the top edge of a chip: "selected", "tap to replace".
 *
 * On a phone the register name ("r15 =") is on the first line of the chip, at the left,
 * so a label must end before it: the longest one ("Enter to replace") must leave room in
 * a 177 px chip. Keep labels that short (e2e: "a label on a chip never covers the
 * register name").
 */
export const TAG =
  'pointer-events-none absolute -top-2.5 right-1 rounded-full bg-primary px-1 font-sans text-sm leading-5 font-bold whitespace-nowrap text-on-primary'

/**
 * The width of the "changed" cell. It is fixed, so the table does not move when a chip
 * is placed or taken away. Narrow tables hold the value on a line of its own (19.05ch);
 * from 32rem on, the whole chip fits on one line (25.05ch). See the top of this file.
 */
export const CELL_WIDTH =
  'w-[calc(19.1ch+1rem)] sm:w-[calc(19.1ch+1.5rem)] @lg:w-[calc(25.1ch+1.5rem)]'

/**
 * On a phone the tray stays at the bottom of the window while the table scrolls, so every
 * line can be filled with one thumb. It only does so when that helps: the window is
 * narrower than 48rem (a laptop shows the tray beside the table instead, and a tablet has
 * room for it under the table), the table is at least 22.5rem wide (two columns of 14 px
 * chips fit, so the tray is not too tall: with one column of nine chips it would cover
 * half the screen) and the window is at least 37.5rem tall. On a narrower phone the tray
 * comes after the table. Beside the table and after Check it stands still. The page keeps
 * its own Check bar still for a trace table, so the tray is the only thing that sticks.
 */
export const TRAY_STICKY =
  'bottom-0 z-10 @min-[22.5rem]:@max-[44rem]:max-md:[@media(min-height:37.5rem)]:sticky'

/**
 * While the tray sticks to the bottom of the window, it covers the lines that scroll
 * under it. A cell that gets the keyboard focus must not be hidden there, so under the
 * same conditions as `TRAY_STICKY` every cell asks for the height of the tray (plus room
 * for the focus ring) to stay free below it when the browser scrolls it into view. The
 * height is measured on the page (`watchTrayHeight`). Clicks and taps do not scroll.
 */
export const CLEAR_OF_TRAY =
  '@min-[22.5rem]:@max-[44rem]:max-md:[@media(min-height:37.5rem)]:scroll-mb-[calc(var(--trace-tray-h,0px)+0.75rem)]'

/**
 * The tray: as many columns of chips as fit, each at least as wide as a cell of the
 * table (so a chip looks the same in both places). One column on a 360 px phone, two from
 * a table of about 22.5rem. Beside the table (from 44rem): one column, or two when there
 * is room for them (from 68rem).
 */
export const TRAY_GRID =
  'grid gap-1 sm:gap-1.5 grid-cols-[repeat(auto-fill,minmax(min(100%,calc(19.1ch+1rem)),1fr))] ' +
  'sm:grid-cols-[repeat(auto-fill,minmax(min(100%,calc(19.1ch+1.5rem)),1fr))] ' +
  '@lg:grid-cols-[repeat(auto-fill,minmax(min(100%,calc(25.1ch+1.5rem)),1fr))] ' +
  '@min-[44rem]:grid-cols-1 @min-[68rem]:grid-cols-2'
