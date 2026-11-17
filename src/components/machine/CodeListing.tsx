import {
  Fragment,
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { tokenizeLine, type AsmToken, type AsmTokenKind } from '../../lib/asmHighlight'
import { cx } from '../ui/cx'
import { BreakpointDot, LibraryHourglass, NextLineArrow } from './LineMarks'
import { codeFade, FOCUS_RING_FOR_CHILD, hidesContent, useScrollEdges } from './useScrollEdges'

export interface CodeListingProps {
  source: string
  /** The line that runs next (arrow and tint), or null. */
  currentLine: number | null
  /** While a library function runs: the line of its `call` (hourglass, dashed lines). */
  libraryLine?: number | null
  /** The name of that library function, for the tag on the line ("inside printf"). */
  libraryName?: string | null
  /** Lines with a breakpoint dot. */
  breakpoints?: readonly number[]
  /** The name of the listing for screen readers. Default "Code". */
  label?: string
  /**
   * Wrap long lines inside the box instead of scrolling sideways. For short read-only code
   * that must be read whole on a phone (a practice problem): a continued line is indented
   * under its first row, and the line number stays on the first row. Leave it off where
   * another column must stay row by row beside the code.
   */
  wrap?: boolean
  className?: string
}

/** The same colors as the code editor (src/features/stepper/editor/theme.ts). */
const TOKEN_CLASSES: Partial<Record<AsmTokenKind, string>> = {
  mnemonic: 'font-bold text-syn-mnemonic',
  register: 'text-syn-register',
  number: 'text-syn-number',
  comment: 'italic text-syn-comment',
  directive: 'text-syn-directive',
  string: 'text-syn-string',
  label: 'font-bold',
}

/** One token, in its color. */
function TokenText({ token }: { token: AsmToken }): ReactNode {
  return <span className={TOKEN_CLASSES[token.kind]}>{token.text}</span>
}

/**
 * A line that may wrap (`wrap`): it breaks only between words, never inside an operand
 * such as `[rbp-4],` or a comment such as `# 7 bytes` (each one moves to the next row as a
 * whole; only a word wider than the box breaks inside itself).
 */
function WrappingTokens({ tokens }: { tokens: readonly AsmToken[] }): ReactNode {
  const words: AsmToken[][] = []
  for (const token of tokens) {
    const last = words.at(-1)
    if (token.kind === 'space' || last === undefined || last[0]?.kind === 'space') {
      words.push([token])
    } else {
      last.push(token)
    }
  }
  return words.map((word, index) =>
    word[0]?.kind === 'space' ? (
      <Fragment key={index}>{word[0].text}</Fragment>
    ) : (
      // indent-0: the line's hanging indent is inherited, and must not move the word.
      <span key={index} className="inline-block max-w-full indent-0">
        {word.map((token, tokenIndex) => (
          <TokenText key={tokenIndex} token={token} />
        ))}
      </span>
    ),
  )
}

/**
 * The hanging indent of a wrapped line: its rows after the first start 2 characters to the
 * right of where its text starts (after its own indent), so they never look like a line.
 */
function hangingIndent(tokens: readonly AsmToken[]): CSSProperties {
  const first = tokens[0]
  const indent = (first?.kind === 'space' ? first.text.length : 0) + 2
  return { paddingLeft: `calc(0.375rem + ${indent}ch)`, textIndent: `-${indent}ch` }
}

/** Dashed lines above and below the line whose library call is running. */
const LIBRARY_LINE =
  'bg-[repeating-linear-gradient(90deg,var(--c-primary)_0_5px,transparent_5px_9px),repeating-linear-gradient(90deg,var(--c-primary)_0_5px,transparent_5px_9px)] bg-[length:100%_1px] bg-[position:0_0,0_100%] bg-no-repeat'

/**
 * A read-only listing of a program: colored like the editor, with line numbers, the line
 * that runs next, the library line and breakpoint dots. A long line scrolls sideways
 * inside the box; the line that runs next is kept in view (only the box scrolls).
 *
 * While the box hides code (a long line, more lines than its height), it fades at that
 * edge and the keyboard can reach it, to scroll it. A listing that shows all of its code
 * is not a Tab stop. A vertical swipe that starts on it moves the page, as on any text.
 */
export const CodeListing = memo(function CodeListing({
  source,
  currentLine,
  libraryLine = null,
  libraryName = null,
  breakpoints = [],
  label = 'Code',
  wrap = false,
  className,
}: CodeListingProps): ReactNode {
  // One line break at the very end does not make an extra empty line.
  const lines = useMemo(() => source.replace(/\n$/, '').split('\n').map(tokenizeLine), [source])
  const boxRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLOListElement | null>(null)
  const edges = useScrollEdges(boxRef, true, source, listRef)
  const scrolls = hidesContent(edges)
  const marked = currentLine ?? libraryLine

  useLayoutEffect(() => {
    const box = boxRef.current
    if (box === null || marked === null) return
    const row = box.querySelector<HTMLElement>(`[data-line="${marked}"]`)
    if (row === null) return
    const top = row.offsetTop
    const bottom = top + row.offsetHeight
    if (top < box.scrollTop) box.scrollTop = Math.max(0, top - row.offsetHeight)
    else if (bottom > box.scrollTop + box.clientHeight) {
      box.scrollTop = bottom - box.clientHeight + row.offsetHeight
    }
  }, [marked])

  const digits = String(lines.length).length

  return (
    <div className={cx('min-w-0 rounded-lg', FOCUS_RING_FOR_CHILD)}>
      <div
        ref={boxRef}
        data-code-listing=""
        // A box that scrolls is a named Tab stop (its own region); one that shows all of
        // its code is a named group, and the keyboard passes it by.
        role={scrolls ? 'region' : 'group'}
        aria-label={label}
        tabIndex={scrolls ? 0 : undefined}
        style={codeFade(edges)}
        className={cx(
          'relative overflow-auto overscroll-x-contain rounded-lg border border-line bg-code-bg focus-visible:outline-none',
          className,
        )}
      >
        <ol
          ref={listRef}
          data-code-wrap={wrap ? '' : undefined}
          className={cx(
            'py-1.5 font-mono text-[0.8125rem] leading-6 text-ink max-lg:text-sm',
            !wrap && 'min-w-max',
          )}
        >
          {lines.map((tokens, index) => {
            const line = index + 1
            const isCurrent = line === currentLine
            const isLibrary = line === libraryLine
            const hasBreakpoint = breakpoints.includes(line)
            return (
              <li
                key={index}
                data-line={line}
                aria-current={isCurrent ? 'step' : undefined}
                className={cx(
                  'flex pr-4',
                  isCurrent && 'bg-current-line',
                  isLibrary && LIBRARY_LINE,
                )}
              >
                {/* The numbers stay in place while a long line scrolls sideways under them. */}
                <span
                  aria-hidden="true"
                  className={cx(
                    'sticky left-0 flex shrink-0 items-center gap-1 pr-2 pl-1.5 select-none',
                    // A wrapped line: the number stays beside its first row.
                    wrap && 'self-start',
                    isCurrent ? 'bg-current-line' : 'bg-code-bg',
                  )}
                >
                  <span className="flex w-3 justify-center">
                    {isCurrent && <NextLineArrow />}
                    {isLibrary && <LibraryHourglass />}
                    {!isCurrent && !isLibrary && hasBreakpoint && <BreakpointDot />}
                  </span>
                  <span
                    className={cx(
                      'text-right tabular-nums',
                      isCurrent || isLibrary ? 'font-bold text-ink' : 'text-muted',
                    )}
                    style={{ width: `${digits}ch` }}
                  >
                    {line}
                  </span>
                </span>
                {isCurrent && <span className="sr-only">Runs next: </span>}
                {isLibrary && <span className="sr-only">Inside the library: </span>}
                {hasBreakpoint && <span className="sr-only">Breakpoint: </span>}
                <code
                  className={
                    wrap
                      ? 'min-w-0 flex-1 [overflow-wrap:anywhere] whitespace-pre-wrap'
                      : 'pl-1.5 whitespace-pre'
                  }
                  style={wrap ? hangingIndent(tokens) : undefined}
                >
                  {tokens.length === 0 ? (
                    ' '
                  ) : wrap ? (
                    <WrappingTokens tokens={tokens} />
                  ) : (
                    tokens.map((token, tokenIndex) => <TokenText key={tokenIndex} token={token} />)
                  )}
                </code>
                {isLibrary && (
                  <span className="ml-[2ch] self-center rounded-full border border-dashed border-primary bg-primary-soft px-2 font-sans text-xs leading-4 font-semibold whitespace-nowrap text-primary">
                    {libraryName === null ? 'inside the library' : `inside ${libraryName}`}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
})
