/**
 * A tiny tokenizer for coloring one line of assembly.
 *
 * It is NOT the emulator's parser: it never rejects anything and it does not need the
 * line to be valid. It only decides which color each piece of text gets, and it is
 * shared by the CodeMirror editor and by the read-only code listings in lessons.
 *
 * Guarantee: joining the `text` of every token gives back the input line exactly.
 */
import { isRegisterName } from '../emulator'

export type AsmTokenKind =
  | 'space'
  | 'comment'
  | 'string'
  | 'label' // a label being defined: `main` in `main:`
  | 'directive' // `.string`, `.equ`, …
  | 'mnemonic' // the instruction name
  | 'register'
  | 'number'
  | 'keyword' // byte / word / dword / qword / ptr / offset / flat
  | 'symbol' // any other name: a label being used, an `.equ` constant
  | 'punct'

export interface AsmToken {
  text: string
  kind: AsmTokenKind
}

const KEYWORDS = new Set(['byte', 'word', 'dword', 'qword', 'ptr', 'offset', 'flat'])

const IDENT_START = /[A-Za-z_.$]/
const IDENT_PART = /[A-Za-z0-9_.$@]/
const DIGIT = /[0-9]/
const ALNUM = /[A-Za-z0-9_]/
const SPACE = /[ \t]/

/** Split one source line (without its line break) into colored pieces. */
export function tokenizeLine(line: string): AsmToken[] {
  const tokens: AsmToken[] = []
  let i = 0
  // True until the instruction or directive name of this line has been seen.
  let atStatementStart = true

  const push = (text: string, kind: AsmTokenKind) => {
    if (text.length > 0) tokens.push({ text, kind })
  }

  while (i < line.length) {
    const ch = line.charAt(i)

    if (SPACE.test(ch)) {
      let j = i + 1
      while (j < line.length && SPACE.test(line.charAt(j))) j++
      push(line.slice(i, j), 'space')
      i = j
      continue
    }

    if (ch === '#') {
      push(line.slice(i), 'comment')
      break
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < line.length && line.charAt(j) !== ch) {
        // Skip an escaped character such as \" or \n.
        j += line.charAt(j) === '\\' ? 2 : 1
      }
      j = Math.min(j + 1, line.length)
      push(line.slice(i, j), 'string')
      i = j
      continue
    }

    if (DIGIT.test(ch)) {
      let j = i + 1
      while (j < line.length && ALNUM.test(line.charAt(j))) j++
      push(line.slice(i, j), 'number')
      i = j
      continue
    }

    if (IDENT_START.test(ch)) {
      let j = i + 1
      while (j < line.length && IDENT_PART.test(line.charAt(j))) j++
      const word = line.slice(i, j)
      const lower = word.toLowerCase()

      // Look past spaces for a colon: `main:` or `main :` defines a label.
      let k = j
      while (k < line.length && SPACE.test(line.charAt(k))) k++
      const definesLabel = atStatementStart && line.charAt(k) === ':'

      if (definesLabel) {
        push(word, 'label')
      } else if (atStatementStart) {
        push(word, word.startsWith('.') ? 'directive' : 'mnemonic')
        atStatementStart = false
      } else if (isRegisterName(lower)) {
        push(word, 'register')
      } else if (KEYWORDS.has(lower)) {
        push(word, 'keyword')
      } else {
        push(word, 'symbol')
      }
      i = j
      continue
    }

    push(ch, 'punct')
    i += 1
  }

  return tokens
}
