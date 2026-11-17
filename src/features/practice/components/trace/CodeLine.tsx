import { Fragment, type ReactNode } from 'react'
import { tokenizeLine, type AsmToken, type AsmTokenKind } from '../../../../lib/asmHighlight'

/** The color of each kind of token (the same `text-syn-*` tokens as the editor). */
const TOKEN_CLASS: Partial<Record<AsmTokenKind, string>> = {
  mnemonic: 'font-semibold text-syn-mnemonic',
  register: 'text-syn-register',
  number: 'text-syn-number',
  keyword: 'text-syn-mnemonic',
  directive: 'text-syn-directive',
  string: 'text-syn-string',
  comment: 'text-syn-comment italic',
  label: 'font-semibold',
}

/**
 * Inside a word that is too long for the column, the places where it may go on to the
 * next line: after a `+` or a `,`. So `[r14+r13*8+0x7ffffff0]` breaks between its parts
 * and the number stays in one piece.
 */
const BREAK_AFTER = new Set(['+', ','])

/** A space, a word (the tokens between two spaces), or a piece that has spaces inside. */
type Piece =
  { type: 'space' } | { type: 'word'; tokens: AsmToken[] } | { type: 'free'; token: AsmToken }

/** Split the tokens of a line into words. A comment or a string is left free. */
function piecesOf(tokens: readonly AsmToken[]): Piece[] {
  const pieces: Piece[] = []
  let word: AsmToken[] = []
  const endWord = () => {
    if (word.length > 0) pieces.push({ type: 'word', tokens: word })
    word = []
  }
  for (const token of tokens) {
    if (token.kind === 'space') {
      endWord()
      pieces.push({ type: 'space' })
    } else if (token.kind === 'comment' || token.kind === 'string') {
      endWord()
      pieces.push({ type: 'free', token })
    } else {
      word.push(token)
    }
  }
  endWord()
  return pieces
}

function Token({ token }: { token: AsmToken }): ReactNode {
  return <span className={TOKEN_CLASS[token.kind]}>{token.text}</span>
}

export interface CodeLineProps {
  /** One instruction, for example "mov eax, 5". */
  text: string
}

/**
 * One line of assembly in the code font, with the colors of the editor.
 *
 * Space at the start and the end is dropped and a run of spaces is shown as one: in the
 * narrow column of a table there is no room for the padding of a full program.
 *
 * A long instruction goes on to the next line between two words, so it never pushes the
 * table wider. Each word (`rsi,`, `[rdi+rsi*8+16]`) is an inline block: it moves to the
 * next line whole when it fits there. Only a word that is longer than the column breaks
 * inside, after a `+` or a `,` when it can, and inside a number only as a last resort (a
 * 64-bit number on a phone).
 */
export function CodeLine({ text }: CodeLineProps): ReactNode {
  return (
    <code className="block font-mono text-sm leading-snug text-ink [overflow-wrap:anywhere] sm:text-[0.9375rem]">
      {piecesOf(tokenizeLine(text.trim())).map((piece, index) => {
        if (piece.type === 'space') return ' '
        if (piece.type === 'free') return <Token key={index} token={piece.token} />
        return (
          <span key={index} data-code-word="" className="inline-block">
            {piece.tokens.map((token, at) => (
              <Fragment key={at}>
                <Token token={token} />
                {token.kind === 'punct' && BREAK_AFTER.has(token.text) && <wbr />}
              </Fragment>
            ))}
          </span>
        )
      })}
    </code>
  )
}
