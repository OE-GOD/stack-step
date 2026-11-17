import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cx } from './cx'

/**
 * A short piece of code inside a sentence: <InlineCode>mov rax, 5</InlineCode>.
 *
 * - The soft background is a tint of the text color (the `chip` token), so it works on
 *   any card or callout.
 * - It stays in one piece and moves to the next line as a whole. Only code that is wider
 *   than the line is broken, so it can never push a phone screen sideways.
 *
 * Because it moves as one piece, the browser may start a new line right after it, even
 * in front of a comma or a period. When a punctuation mark follows the code, keep the two
 * together with <NoWrap>:
 *
 *   from <InlineCode>rax</InlineCode> to <NoWrap><InlineCode>r15</InlineCode>.</NoWrap>
 *
 * <RichText> does this by itself for code in backticks.
 *
 * On paper the background is left out (most printers leave backgrounds out anyway), and
 * so is the space at its sides: the code then stands in the sentence like any word.
 */
export function InlineCode({
  className,
  children,
  ...rest
}: ComponentPropsWithRef<'code'>): ReactNode {
  return (
    <code
      className={cx(
        // `max-w-full` + `break-word`: only code wider than its block is broken. (Not
        // `anywhere`: that would let a table column or a box sized to its text shrink the
        // code to one letter per line, and a smaller limit such as calc(100% - 1.5em)
        // would break code that is the only thing in a box sized to it. <NoWrap> makes
        // the limit smaller only for code that has a punctuation mark kept next to it.)
        // `whitespace-normal`: inside a <NoWrap>, long code can still break inside itself.
        // The size: a little smaller than the text around it (the code font looks bigger),
        // but never under 14 px, which would be too small to read on a phone (in a 14 px
        // line, 0.9em would be 12.6 px). The lessons' own code uses the same rule.
        'inline-block max-w-full rounded-sm bg-chip px-1 py-0.5 align-baseline font-mono text-[length:max(0.9em,0.875rem)] leading-[1.3] [overflow-wrap:break-word] whitespace-normal print:bg-transparent print:px-0',
        className,
      )}
      {...rest}
    >
      {children}
    </code>
  )
}
