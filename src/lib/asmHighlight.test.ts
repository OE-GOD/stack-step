import { describe, expect, it } from 'vitest'
import { EXAMPLES } from '../examples'
import { tokenizeLine, type AsmTokenKind } from './asmHighlight'

/** The non-space tokens as [text, kind] pairs. */
function kinds(line: string): [string, AsmTokenKind][] {
  return tokenizeLine(line)
    .filter((t) => t.kind !== 'space')
    .map((t) => [t.text, t.kind])
}

describe('tokenizeLine', () => {
  it('colors a plain instruction', () => {
    expect(kinds('    mov     rbp, rsp')).toEqual([
      ['mov', 'mnemonic'],
      ['rbp', 'register'],
      [',', 'punct'],
      ['rsp', 'register'],
    ])
  })

  it('colors a label, an instruction and a comment on one line', () => {
    expect(kinds('main: push rbp   # save it')).toEqual([
      ['main', 'label'],
      [':', 'punct'],
      ['push', 'mnemonic'],
      ['rbp', 'register'],
      ['# save it', 'comment'],
    ])
  })

  it('colors directives and strings', () => {
    expect(kinds('    .string "Hello World!\\n"')).toEqual([
      ['.string', 'directive'],
      ['"Hello World!\\n"', 'string'],
    ])
    expect(kinds('.intel_syntax noprefix')).toEqual([
      ['.intel_syntax', 'directive'],
      ['noprefix', 'symbol'],
    ])
  })

  it('does not treat # inside a string as a comment', () => {
    expect(kinds('.string "a # b"  # real comment')).toEqual([
      ['.string', 'directive'],
      ['"a # b"', 'string'],
      ['# real comment', 'comment'],
    ])
  })

  it('handles an escaped quote inside a string', () => {
    expect(kinds('.string "say \\"hi\\""')).toEqual([
      ['.string', 'directive'],
      ['"say \\"hi\\""', 'string'],
    ])
  })

  it('colors memory operands, sizes and numbers', () => {
    expect(kinds('mov dword ptr [rbp-4], 0x1F')).toEqual([
      ['mov', 'mnemonic'],
      ['dword', 'keyword'],
      ['ptr', 'keyword'],
      ['[', 'punct'],
      ['rbp', 'register'],
      ['-', 'punct'],
      ['4', 'number'],
      [']', 'punct'],
      [',', 'punct'],
      ['0x1F', 'number'],
    ])
  })

  it('colors names used as operands as symbols', () => {
    expect(kinds('lea rdi, message[rip]')).toEqual([
      ['lea', 'mnemonic'],
      ['rdi', 'register'],
      [',', 'punct'],
      ['message', 'symbol'],
      ['[', 'punct'],
      ['rip', 'symbol'],
      [']', 'punct'],
    ])
    expect(kinds('call printf@PLT')).toEqual([
      ['call', 'mnemonic'],
      ['printf@PLT', 'symbol'],
    ])
    expect(kinds('jmp loop_start')).toEqual([
      ['jmp', 'mnemonic'],
      ['loop_start', 'symbol'],
    ])
  })

  it('is case-insensitive for registers and keywords', () => {
    expect(kinds('MOV EAX, DWORD PTR [RBP-4]').map(([, kind]) => kind)).toEqual([
      'mnemonic',
      'register',
      'punct',
      'keyword',
      'keyword',
      'punct',
      'register',
      'punct',
      'number',
      'punct',
    ])
  })

  it('treats the first word as the instruction even when it is not a real one', () => {
    expect(kinds('mvo rax, 5')[0]).toEqual(['mvo', 'mnemonic'])
  })

  it('accepts a label that has the same name as an instruction', () => {
    expect(kinds('loop: dec ecx')).toEqual([
      ['loop', 'label'],
      [':', 'punct'],
      ['dec', 'mnemonic'],
      ['ecx', 'register'],
    ])
  })

  it('handles a comment-only line, an empty line and odd input', () => {
    expect(kinds('# just a comment')).toEqual([['# just a comment', 'comment']])
    expect(tokenizeLine('')).toEqual([])
    expect(kinds('"unfinished')).toEqual([['"unfinished', 'string']])
    expect(kinds('[[,,')).toEqual([
      ['[', 'punct'],
      ['[', 'punct'],
      [',', 'punct'],
      [',', 'punct'],
    ])
  })

  it('always gives the line back when the pieces are joined', () => {
    const lines = EXAMPLES.flatMap((example) => example.source.split('\n'))
    lines.push(
      '\tmov\trax,\t5',
      '  weird ;; stuff "x',
      "mov al, 'A'",
      'x = 5',
      '%rax, $5',
      'é ü 😀',
    )
    for (const line of lines) {
      expect(
        tokenizeLine(line)
          .map((t) => t.text)
          .join(''),
      ).toBe(line)
    }
  })

  it('never produces an empty token', () => {
    for (const example of EXAMPLES) {
      for (const line of example.source.split('\n')) {
        for (const token of tokenizeLine(line)) expect(token.text.length).toBeGreaterThan(0)
      }
    }
  })
})
