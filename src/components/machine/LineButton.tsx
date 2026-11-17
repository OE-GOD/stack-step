import type { ReactNode } from 'react'

export interface LineButtonProps {
  line: number
  /** What the button does, as a tooltip ("Show line 4 in the code"). */
  title: string
  onClick: (line: number) => void
  /** The words in the sentence ("Line 4", "line 13"). */
  children: ReactNode
}

/**
 * "Line 4" inside a sentence (a message, the heading of a step), as a button that takes
 * the student to that line of code. It looks like a link and keeps the size of the words
 * around it; on a touch screen an invisible edge makes it a 44 px target, without moving
 * any text.
 */
export function LineButton({ line, title, onClick, children }: LineButtonProps): ReactNode {
  return (
    <button
      type="button"
      onClick={() => onClick(line)}
      title={title}
      data-line-button=""
      className="relative cursor-pointer rounded-sm font-semibold underline decoration-1 underline-offset-[0.2em] hover:decoration-2 pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-3 pointer-coarse:after:content-['']"
    >
      {children}
    </button>
  )
}
