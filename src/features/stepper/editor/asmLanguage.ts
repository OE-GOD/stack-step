/**
 * Assembly for CodeMirror: which color each piece of a line gets.
 *
 * The rules are NOT written here. They live in `tokenizeLine` (src/lib/asmHighlight.ts),
 * the same function that colors the code listings in lessons, so the editor and the
 * lessons can never disagree. This file hands those tokens to CodeMirror one by one and
 * gives every kind of token a CSS class. The colors of the classes are in `theme.ts`.
 */
import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
  type StreamParser,
} from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { Tag, tags } from '@lezer/highlight'
import { tokenizeLine, type AsmToken, type AsmTokenKind } from '../../../lib/asmHighlight'

/** Every kind of token that gets a class. White space gets none. */
export type AsmStyledKind = Exclude<AsmTokenKind, 'space'>

/**
 * One highlighting tag per kind of token. Each tag has a standard tag as its parent, so
 * a stock CodeMirror highlighter would still color the code in a sensible way.
 */
export const asmTags: Readonly<Record<AsmStyledKind, Tag>> = {
  comment: Tag.define('asmComment', tags.lineComment),
  string: Tag.define('asmString', tags.string),
  label: Tag.define('asmLabel', tags.labelName),
  directive: Tag.define('asmDirective', tags.meta),
  mnemonic: Tag.define('asmMnemonic', tags.keyword),
  register: Tag.define('asmRegister', tags.variableName),
  number: Tag.define('asmNumber', tags.number),
  keyword: Tag.define('asmKeyword', tags.modifier),
  symbol: Tag.define('asmSymbol', tags.name),
  punct: Tag.define('asmPunct', tags.punctuation),
}

export const ASM_STYLED_KINDS = Object.keys(asmTags) as AsmStyledKind[]

/** The CSS class of a kind of token: 'mnemonic' → 'cm-asm-mnemonic'. */
export function asmTokenClass(kind: AsmStyledKind): string {
  return `cm-asm-${kind}`
}

/** What the tokenizer remembers while it reads one line. Nothing is kept between lines. */
export interface AsmLineState {
  /** The line being read; null before the first line. */
  line: string | null
  tokens: readonly AsmToken[]
  /** Index in `tokens` of the token that is handed out next. */
  next: number
  /** Where that token starts in the line. */
  offset: number
}

function startState(): AsmLineState {
  return { line: null, tokens: [], next: 0, offset: 0 }
}

/** Tokenize `line` and skip the tokens that end at or before `position`. */
function loadLine(state: AsmLineState, line: string, position: number): void {
  state.line = line
  state.tokens = tokenizeLine(line)
  state.next = 0
  state.offset = 0
  for (const token of state.tokens) {
    if (state.offset + token.text.length > position) break
    state.offset += token.text.length
    state.next += 1
  }
}

/**
 * The CodeMirror side of the tokenizer. CodeMirror asks for one token at a time; the
 * whole line is tokenized once, when its first token is asked for.
 *
 * The name of a token is its kind ('mnemonic', 'register', …), so the syntax tree that
 * CodeMirror builds has exactly the pieces `tokenizeLine` returns.
 */
export const asmStreamParser: StreamParser<AsmLineState> = {
  name: 'asm',
  startState,
  // A line never depends on the line before it, so a copy can start empty.
  copyState: startState,
  token(stream, state) {
    // A new line (or a reader that jumped): tokenize it and find the token at the reader.
    if (state.line !== stream.string || state.offset !== stream.pos) {
      loadLine(state, stream.string, stream.pos)
    }
    const token = state.tokens[state.next]
    if (token === undefined) {
      // Cannot happen while `tokenizeLine` covers the whole line. Never stand still.
      stream.skipToEnd()
      return null
    }
    state.next += 1
    state.offset += token.text.length
    stream.pos = state.offset
    return token.kind === 'space' ? null : token.kind
  },
  tokenTable: asmTags,
  // One piece of the syntax tree per token, also for two tokens of one kind in a row.
  mergeTokens: false,
}

export const asmLanguage = StreamLanguage.define(asmStreamParser)

/** Gives every token its `cm-asm-…` class. */
export const asmHighlightStyle = HighlightStyle.define(
  ASM_STYLED_KINDS.map((kind) => ({ tag: asmTags[kind], class: asmTokenClass(kind) })),
)

/** The assembly language and its highlighting, ready to add to an editor. */
export function assembly(): Extension {
  return [asmLanguage, syntaxHighlighting(asmHighlightStyle)]
}
