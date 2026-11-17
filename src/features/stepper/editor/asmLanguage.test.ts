import { ensureSyntaxTree, StringStream } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { highlightTree } from '@lezer/highlight'
import { describe, expect, it } from 'vitest'
import { EXAMPLES } from '../../../examples'
import { tokenizeLine, type AsmTokenKind } from '../../../lib/asmHighlight'
import {
  ASM_STYLED_KINDS,
  asmHighlightStyle,
  asmStreamParser,
  asmTokenClass,
  assembly,
  type AsmLineState,
} from './asmLanguage'

type Piece = [text: string, kind: string]

/** What the shared tokenizer says about a line, without the white space. */
function expectedPieces(line: string): Piece[] {
  return tokenizeLine(line)
    .filter((token) => token.kind !== 'space')
    .map((token) => [token.text, token.kind])
}

function newState(): AsmLineState {
  const state = asmStreamParser.startState?.(4)
  if (state === undefined) throw new Error('The parser has no start state.')
  return state
}

/** Read a line the way CodeMirror does: ask for one token after the other. */
function readLine(line: string, state: AsmLineState = newState(), from = 0): Piece[] {
  const stream = new StringStream(line, 8, 4)
  stream.pos = from
  const pieces: Piece[] = []
  while (!stream.eol()) {
    stream.start = stream.pos
    const style = asmStreamParser.token(stream, state)
    expect(stream.pos, `the reader must move forward in "${line}"`).toBeGreaterThan(stream.start)
    if (style !== null) pieces.push([stream.current(), style])
  }
  return pieces
}

/** The pieces of the syntax tree that CodeMirror builds for a whole program. */
function treePieces(source: string): Piece[] {
  const state = EditorState.create({ doc: source, extensions: [assembly()] })
  const tree = ensureSyntaxTree(state, state.doc.length, 5000)
  if (tree === null) throw new Error('The program was not parsed in time.')
  const pieces: Piece[] = []
  tree.iterate({
    enter(node) {
      if (node.name !== 'Document') pieces.push([state.sliceDoc(node.from, node.to), node.name])
    },
  })
  return pieces
}

const ODD_LINES = [
  '',
  '   ',
  '\tmov\trax,\t5',
  'main: push rbp   # save it',
  'mov dword ptr [rbp-4], 0x1F',
  'MOV EAX, DWORD PTR [RBP-4]',
  '.string "a # b"  # real comment',
  '.string "say \\"hi\\""',
  '"unfinished',
  "mov al, 'A'",
  '[[,,',
  '%rax, $5',
  'x = 5',
  '  weird ;; stuff "x',
  'é ü 😀',
  'call printf@PLT',
]

const EXAMPLE_LINES = EXAMPLES.flatMap((example) => example.source.split('\n'))

describe('asmStreamParser', () => {
  it('hands out exactly the tokens of tokenizeLine, for every line of every example', () => {
    for (const line of [...EXAMPLE_LINES, ...ODD_LINES]) {
      expect(readLine(line), line).toEqual(expectedPieces(line))
    }
  })

  it('names a token after its kind', () => {
    expect(readLine('main: mov eax, dword ptr [rbp-4]  # load')).toEqual([
      ['main', 'label'],
      [':', 'punct'],
      ['mov', 'mnemonic'],
      ['eax', 'register'],
      [',', 'punct'],
      ['dword', 'keyword'],
      ['ptr', 'keyword'],
      ['[', 'punct'],
      ['rbp', 'register'],
      ['-', 'punct'],
      ['4', 'number'],
      [']', 'punct'],
      ['# load', 'comment'],
    ])
    expect(readLine('    .string "Hi\\n"')).toEqual([
      ['.string', 'directive'],
      ['"Hi\\n"', 'string'],
    ])
    expect(readLine('    jmp loop_start')).toEqual([
      ['jmp', 'mnemonic'],
      ['loop_start', 'symbol'],
    ])
  })

  it('keeps nothing from one line to the next', () => {
    const state = newState()
    // The same state reads many lines, as CodeMirror does. Two equal lines in a row and
    // a line that starts like the one before are the cases that could go wrong.
    const lines = [
      '    mov eax, 0',
      '    mov eax, 0',
      '    mov eax, 0x10',
      'mov:',
      '    mov eax, 0',
    ]
    for (const line of lines) expect(readLine(line, state), line).toEqual(expectedPieces(line))
  })

  it('starts with a fresh state after a copy', () => {
    const state = newState()
    readLine('    push rbp', state)
    const copy = asmStreamParser.copyState?.(state)
    expect(copy).toEqual(newState())
  })

  it('finds its place when reading starts in the middle of a line', () => {
    const line = '    mov     rbp, rsp'
    expect(readLine(line, newState(), line.indexOf('rbp'))).toEqual([
      ['rbp', 'register'],
      [',', 'punct'],
      ['rsp', 'register'],
    ])
    // In the middle of a token: the rest of that token keeps its kind.
    expect(readLine(line, newState(), line.indexOf('bp,'))).toEqual([
      ['bp', 'register'],
      [',', 'punct'],
      ['rsp', 'register'],
    ])
  })
})

describe('the assembly language in an editor state', () => {
  it('builds a syntax tree with exactly the tokens of tokenizeLine', () => {
    for (const example of EXAMPLES) {
      const expected = example.source.split('\n').flatMap(expectedPieces)
      expect(treePieces(example.source), example.id).toEqual(expected)
    }
    const odd = ODD_LINES.join('\n')
    expect(treePieces(odd)).toEqual(ODD_LINES.flatMap(expectedPieces))
  })

  it('gives every kind of token its own class', () => {
    const source = 'main: mov eax, dword ptr [rbp-4]  # load\n    .string "Hi"\n    jmp done'
    const state = EditorState.create({ doc: source, extensions: [assembly()] })
    const tree = ensureSyntaxTree(state, state.doc.length, 5000)
    if (tree === null) throw new Error('The program was not parsed in time.')

    const classOf = new Map<string, string>()
    highlightTree(tree, asmHighlightStyle, (from, to, classes) => {
      classOf.set(state.sliceDoc(from, to), classes)
    })

    const expected: [string, AsmTokenKind][] = [
      ['main', 'label'],
      ['mov', 'mnemonic'],
      ['eax', 'register'],
      ['dword', 'keyword'],
      ['4', 'number'],
      ['# load', 'comment'],
      ['.string', 'directive'],
      ['"Hi"', 'string'],
      ['done', 'symbol'],
      ['[', 'punct'],
    ]
    for (const [text, kind] of expected) {
      expect(classOf.get(text), text).toBe(`cm-asm-${kind}`)
    }
  })

  it('has a class name for every kind except white space', () => {
    expect([...ASM_STYLED_KINDS].sort()).toEqual(
      [
        'comment',
        'directive',
        'keyword',
        'label',
        'mnemonic',
        'number',
        'punct',
        'register',
        'string',
        'symbol',
      ].sort(),
    )
    expect(asmTokenClass('mnemonic')).toBe('cm-asm-mnemonic')
    expect(asmTokenClass('register')).toBe('cm-asm-register')
    expect(asmTokenClass('comment')).toBe('cm-asm-comment')
  })
})
