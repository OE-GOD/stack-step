/**
 * Splits a reply of the tutor into plain text and code.
 *
 * The tutor writes plain text and puts code in backticks: `mov eax, 5`. Sometimes a
 * model writes a fenced block (three backticks) although it was asked not to; that is
 * shown as a block of code. Nothing else is given a meaning: the reply is never read as
 * HTML or as Markdown.
 */
export type ReplyPart =
  /** Plain text. It can hold line breaks. */
  | { kind: 'text'; text: string }
  /** Code inside a sentence. */
  | { kind: 'code'; text: string }
  /** Code on lines of its own. */
  | { kind: 'block'; text: string }

const FENCE = '```'

/**
 * @param text      the reply (or the part of it that has arrived)
 * @param arriving  true while the reply is still arriving: code whose closing backtick
 *                  has not arrived yet is then already shown as code, so the text does
 *                  not jump when the backtick comes
 */
export function parseReply(text: string, arriving = false): ReplyPart[] {
  const parts: ReplyPart[] = []
  const add = (kind: ReplyPart['kind'], value: string): void => {
    if (value === '') return
    const last = parts[parts.length - 1]
    if (kind === 'text' && last?.kind === 'text') last.text += value
    else parts.push({ kind, text: value })
  }

  /** Text without fenced blocks: find the `code` in it. */
  const addInline = (value: string, isEnd: boolean): void => {
    let from = 0
    for (const match of value.matchAll(/`([^`\n]+)`/g)) {
      add('text', value.slice(from, match.index))
      add('code', match[1] ?? '')
      from = match.index + match[0].length
    }
    const tail = value.slice(from)
    const open = tail.lastIndexOf('`')
    // A backtick that waits for its partner, at the very end of a reply that is arriving.
    if (arriving && isEnd && open !== -1 && !tail.slice(open + 1).includes('\n')) {
      add('text', tail.slice(0, open))
      add('code', tail.slice(open + 1))
      return
    }
    add('text', tail)
  }

  let rest = text
  for (;;) {
    const start = rest.indexOf(FENCE)
    if (start === -1) break
    addInline(rest.slice(0, start), false)
    let inside = rest.slice(start + FENCE.length)
    // A word right after the opening fence names a language ("```asm"): leave it out.
    const lineEnd = inside.indexOf('\n')
    if (lineEnd !== -1 && /^[\w+-]*$/.test(inside.slice(0, lineEnd).trim())) {
      inside = inside.slice(lineEnd + 1)
    }
    const end = inside.indexOf(FENCE)
    // No closing fence: it has not arrived yet, or the model forgot it.
    const code = end === -1 ? inside : inside.slice(0, end)
    add('block', code.replace(/\n$/, ''))
    rest = end === -1 ? '' : inside.slice(end + FENCE.length).replace(/^\n/, '')
  }
  addInline(rest, true)
  return parts
}
