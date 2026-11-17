import type { ReactNode } from 'react'

export interface NoWrapProps {
  children: ReactNode
}

/**
 * Keeps a short piece of text on one line.
 *
 * - A name such as "x86-64" is never broken after its hyphen: <NoWrap>x86-64</NoWrap>.
 * - A comma or a period stays with the code in front of it:
 *   <NoWrap><InlineCode>rax</InlineCode>,</NoWrap>
 */
export function NoWrap({ children }: NoWrapProps): ReactNode {
  // Code inside leaves room for the mark kept next to it, so the two never stick out of
  // the line together. (The percentage is of the paragraph: this span is inline.)
  return <span className="whitespace-nowrap [&>code]:max-w-[calc(100%-1.5em)]">{children}</span>
}
