/**
 * The parts of a problem's prompt that the trace table shows.
 *
 * A trace-table problem has sentences (`text`), one or more small tables of starting
 * values (`registers`) and one listing (`code`) whose lines become the rows of the
 * table. Other kinds of block do not belong to this type of problem and are not shown.
 */
import type { PromptBlock } from '../../types'

export interface RegistersPart {
  title?: string
  rows: readonly { name: string; value: string }[]
}

export interface TracePrompt {
  /** The sentences of the question, in order. They may hold code in backticks. */
  texts: readonly string[]
  registers: readonly RegistersPart[]
  /** The lines of the first code listing: line 1 is `lines[0]`. */
  lines: readonly string[]
}

export function readPrompt(prompt: readonly PromptBlock[]): TracePrompt {
  const texts: string[] = []
  const registers: RegistersPart[] = []
  let lines: readonly string[] | null = null
  for (const block of prompt) {
    if (block.type === 'text') texts.push(block.text)
    else if (block.type === 'registers') registers.push({ title: block.title, rows: block.rows })
    else if (block.type === 'code' && lines === null) lines = block.lines
  }
  return { texts, registers, lines: lines ?? [] }
}
