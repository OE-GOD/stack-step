import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { CodeListing } from '../../../components/machine'
import { cx } from '../../../components/ui/cx'
import { InlineCode } from '../../../components/ui/InlineCode'

/*
 * The prose helpers for lesson files. `components/index.ts` lists them with an example
 * each; lesson files import them from there.
 */

/** Longer code than this may need to break inside itself on a phone (see `Code`). */
const LONG_CODE = 24

/** The listing or table scrolls, so the keyboard must be able to reach it (and scroll it). */
const SCROLLABLE_TAB_INDEX = 0

/**
 * Code is a little smaller than the text around it (the code font looks bigger), but never
 * smaller than 14 px: in a table cell (15 px), a note (15 px) or a caption (14 px), 0.9 of
 * the text would be too small to read on a phone.
 */
const CODE_SIZE = 'text-[length:max(0.9em,0.875rem)]'

/**
 * Code that never breaks inside itself. It is part of the line around it (not a box), so
 * a comma or a period right after it stays on its line too.
 */
function CodeWord({ children }: { children: string }): ReactNode {
  return (
    <code
      className={cx(
        'rounded-sm bg-chip px-1 py-0.5 font-mono leading-[1.3] whitespace-nowrap print:bg-transparent print:px-0',
        CODE_SIZE,
      )}
    >
      {children}
    </code>
  )
}

/**
 * Code in a table cell. It may break at its spaces (`.type main,` / `@function`) but never
 * inside a word, so a narrow screen shares the width between the columns instead of
 * squeezing the text column. (Breaking anywhere would shrink a column to one letter.)
 */
function TableCode({ children }: { children: string }): ReactNode {
  return (
    <code
      className={cx(
        'rounded-sm bg-chip box-decoration-clone px-1 py-0.5 font-mono leading-[1.3] print:bg-transparent print:px-0',
        CODE_SIZE,
      )}
    >
      {children}
    </code>
  )
}

/**
 * A short piece of code inside a sentence: <Code>rax</Code>.
 *
 * Short code is one unbroken word of the sentence, so a comma or a period right after it
 * stays on its line (a line never starts with a lonely comma). Long code uses the kit's
 * <InlineCode>, which may break inside itself so it never pushes a phone screen sideways.
 */
export function Code({ children }: { children: string }): ReactNode {
  return children.length > LONG_CODE ? (
    <InlineCode>{children}</InlineCode>
  ) : (
    <CodeWord>{children}</CodeWord>
  )
}

/**
 * A string shows the parts in backticks as code (`Piece`); anything else is shown as it
 * is. A string with a backtick that has no partner is shown as it is (the content tests
 * catch that).
 */
function withCode(
  value: ReactNode,
  Piece: (props: { children: string }) => ReactNode = Code,
): ReactNode {
  if (typeof value !== 'string') return value
  const parts = value.split('`')
  if (parts.length % 2 === 0) return value
  return parts.map((part, index) => (index % 2 === 1 ? <Piece key={index}>{part}</Piece> : part))
}

/** A word that the sentence around it defines: bold, no tooltip. */
export function Term({ children }: { children: ReactNode }): ReactNode {
  return <dfn className="font-bold not-italic">{children}</dfn>
}

/** A quiet aside, such as a pointer to a later lesson. */
export function Note({ children }: { children: ReactNode }): ReactNode {
  return (
    <div
      role="note"
      className="border-l-4 border-line-strong pl-4 text-[0.9375rem] text-muted [&>*+*]:mt-2"
    >
      {children}
    </div>
  )
}

export interface StepsProps {
  /** One entry per step, in order. A string may hold code in backticks. */
  items: readonly ReactNode[]
}

/** A numbered list, for things that happen in order. */
export function Steps({ items }: StepsProps): ReactNode {
  return (
    <ol className="list-decimal pl-6 marker:font-semibold marker:text-muted [&>li+li]:mt-2">
      {items.map((item, index) => (
        <li key={index} className="pl-1">
          {withCode(item)}
        </li>
      ))}
    </ol>
  )
}

export interface CodeBlockProps {
  /**
   * The code, 4-space indent as in the examples. A line break at the very start and the
   * spaces and line breaks at the end are left out, so a template string can start and
   * end on lines of its own.
   */
  children: string
  /** The name of the listing for screen readers. Default "Code example". */
  label?: string
}

/**
 * - overscroll-y-auto: the listing keeps scrolling gestures to itself, but this short box
 *   never scrolls up or down, so a vertical swipe or a mouse wheel that starts on it must
 *   scroll the page.
 * - The lesson body is "prose", whose rules for lists (space on the left, space between
 *   items) would also reach the listing's lines: they are undone here.
 */
const CODE_BLOCK = 'overscroll-y-auto [&_li+li]:mt-0 [&_ol]:pl-0'

/**
 * A few lines of code, colored like the editor, with line numbers. A long line scrolls
 * sideways inside the box, never the page.
 */
export function CodeBlock({ children, label = 'Code example' }: CodeBlockProps): ReactNode {
  const source = children.replace(/^\r?\n/, '').replace(/\s+$/, '')
  return <CodeListing source={source} currentLine={null} label={label} className={CODE_BLOCK} />
}

/** True while the content of the box is wider than the box. */
function useScrollsSideways(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolls, setScrolls] = useState(false)
  useEffect(() => {
    const box = ref.current
    if (box === null || typeof ResizeObserver === 'undefined') return
    const measure = () => setScrolls(box.scrollWidth > box.clientWidth + 1)
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    measure()
    return () => observer.disconnect()
  }, [ref])
  return scrolls
}

export interface FactTableProps {
  /** A short title, shown above the table. May hold code in backticks. */
  caption: string
  /** The column headings. A string may hold code in backticks. */
  head: readonly ReactNode[]
  /** The rows, one cell per column. A string may hold code in backticks. */
  rows: readonly (readonly ReactNode[])[]
  /** The first cell of each row names the row (default true). */
  rowHeaders?: boolean
}

/**
 * A small table with a caption. Code in a cell breaks only at its spaces, never inside a
 * word: a table that is still wider than the screen scrolls sideways inside its own box
 * (which the keyboard can then reach), never the page.
 */
export function FactTable({ caption, head, rows, rowHeaders = true }: FactTableProps): ReactNode {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const scrolls = useScrollsSideways(boxRef)
  return (
    <div
      ref={boxRef}
      role={scrolls ? 'region' : undefined}
      aria-label={scrolls ? caption.replaceAll('`', '') : undefined}
      tabIndex={scrolls ? SCROLLABLE_TAB_INDEX : undefined}
      className="max-w-full overflow-x-auto rounded-xl border border-line bg-surface"
    >
      <table className="w-full border-collapse text-left text-[0.9375rem] leading-snug">
        <caption className="px-3 py-2 text-left text-sm font-semibold text-muted">
          {withCode(caption)}
        </caption>
        <thead className="bg-surface-2">
          <tr className="border-t border-line">
            {head.map((cell, index) => (
              <th key={index} scope="col" className="px-3 py-2 font-semibold">
                {withCode(cell, TableCode)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t border-line">
              {row.map((cell, index) =>
                index === 0 && rowHeaders ? (
                  <th key={index} scope="row" className="px-3 py-2 font-semibold">
                    {withCode(cell, TableCode)}
                  </th>
                ) : (
                  <td key={index} className="px-3 py-2">
                    {withCode(cell, TableCode)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
