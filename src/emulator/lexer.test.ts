import { describe, expect, it } from 'vitest'
import { isInvisible, lexLine, utf8Text, type Token } from './lexer'

/** The text without its invisible characters. */
function strip(text: string): string {
  return [...text].filter((ch) => !isInvisible(ch)).join('')
}

/** Token kinds and texts, the short way to compare a whole line. */
function shape(text: string): string[] {
  return lexLine(text).tokens.map((token) => `${token.kind}:${token.text}`)
}

function only(text: string): Token {
  const { tokens } = lexLine(text)
  expect(tokens, text).toHaveLength(1)
  return tokens[0]
}

describe('words, numbers and punctuation', () => {
  it('splits an instruction into tokens', () => {
    expect(shape('mov rax, 5')).toEqual(['ident:mov', 'ident:rax', 'punct:,', 'number:5'])
  })

  it('records where each token starts and ends', () => {
    const { tokens } = lexLine('  mov  rax,5')
    expect(tokens.map((token) => [token.start, token.end])).toEqual([
      [2, 5],
      [7, 10],
      [10, 11],
      [11, 12],
    ])
  })

  it('reads a memory operand piece by piece', () => {
    expect(shape('[rax+rbx*8-16]')).toEqual([
      'punct:[',
      'ident:rax',
      'punct:+',
      'ident:rbx',
      'punct:*',
      'number:8',
      'punct:-',
      'number:16',
      'punct:]',
    ])
  })

  it.each(['_start', '.L3', '.LC0', 'my_label2', '$weird', 'a.b.c', 'Main'])(
    'reads %s as one word',
    (name) => {
      expect(shape(name)).toEqual([`ident:${name}`])
    },
  )

  it('keeps the letter case of words', () => {
    expect(shape('MOV Rax')).toEqual(['ident:MOV', 'ident:Rax'])
  })

  it('reads a label and its colon', () => {
    expect(shape('main:')).toEqual(['ident:main', 'punct::'])
  })

  it('reads `printf@PLT` as word, @, word', () => {
    expect(shape('call printf@PLT')).toEqual(['ident:call', 'ident:printf', 'punct:@', 'ident:PLT'])
  })

  it('reads every punctuation mark', () => {
    expect(shape(', : [ ] + - * ( ) = @')).toEqual(
      [',', ':', '[', ']', '+', '-', '*', '(', ')', '=', '@'].map((mark) => `punct:${mark}`),
    )
  })

  it.each([
    ['42', 42n],
    ['0', 0n],
    ['0x2A', 42n],
    ['0X2a', 42n],
    ['0xffffffffffffffff', 0xffff_ffff_ffff_ffffn],
    ['0b101', 5n],
    ['0B11', 3n],
    ['18446744073709551616', 2n ** 64n],
  ])('reads the number %s', (text, value) => {
    const token = only(text)
    expect(token).toMatchObject({ kind: 'number', value, character: false })
  })

  it('reads a minus sign as its own token', () => {
    expect(shape('-8')).toEqual(['punct:-', 'number:8'])
  })

  it('treats tabs and other spaces as spaces', () => {
    expect(shape('\tmov\u00a0rax ,\t5 ')).toEqual(['ident:mov', 'ident:rax', 'punct:,', 'number:5'])
  })

  it('gives no tokens for an empty or blank line', () => {
    expect(lexLine('')).toEqual({ tokens: [], badComment: null, odd: null })
    expect(lexLine('   \t ')).toEqual({ tokens: [], badComment: null, odd: null })
  })
})

describe('characters pasted from a web page, a slide or a phone', () => {
  it.each([
    ['\u00a0', 'no-break space'],
    ['\u202f', 'narrow no-break space'],
    ['\u2009', 'thin space'],
    ['\u3000', 'ideographic space'],
    ['\u2028', 'line separator'],
  ])('reads %j (%s) as a space and reports it', (space, _name) => {
    const line = lexLine(`mov${space}rax, 5`)
    expect(line.tokens.map((token) => token.text)).toEqual(['mov', 'rax', ',', '5'])
    expect(line.odd).toEqual({ kind: 'space', codePoint: space.codePointAt(0), start: 3 })
  })

  it.each(['\u200b', '\u00ad', '\u2060', '\ufeff', '\u200e'])(
    'reads past the invisible character %j, even inside a word',
    (invisible) => {
      const line = lexLine(`${invisible}mov ra${invisible}x, 1${invisible}2`)
      expect(line.tokens.map((token) => token.text)).toEqual(['mov', 'rax', ',', '12'])
      expect(line.odd).toEqual({ kind: 'invisible', codePoint: invisible.codePointAt(0), start: 0 })
    },
  )

  it('keeps special spaces and invisible characters that are inside text', () => {
    const line = lexLine('.string "a\u00a0b\u200bc" # \u00a0 in a comment')
    expect(line.odd).toBeNull()
    expect(line.tokens[1]).toMatchObject({ kind: 'string', value: 'a\u00a0b\u200bc' })
  })

  it.each([
    ['\u201chi\u201d', '"', '"hi"'],
    ['\u201ehi\u201c', '"', '"hi"'],
    ['\u201chi"', '"', '"hi"'],
    ['\u201cno end', '"', '"no end'],
    ['\u2018A\u2019', "'", "'A'"],
    ['\u2019A\u2019', "'", "'A'"],
  ])('reads %j as one look-alike, fixed as %s\u2026%s', (text, plain, fixed) => {
    expect(only(text)).toMatchObject({
      kind: 'problem',
      text,
      problem: { type: 'look-alike', char: text[0], plain, fixed },
    })
  })

  it('reads a # or ; inside curly quotes as part of the text, not as a comment', () => {
    const line = lexLine('.string \u201cItem #1; done\u201d')
    expect(line.badComment).toBeNull()
    expect(line.tokens[1]).toMatchObject({ problem: { fixed: '"Item #1; done"' } })
  })

  it.each([
    ['"Hello\u201d', '"Hello"'],
    ["'A\u2019", "'A'"],
  ])('says that %j ends with a curly quote', (text, fixed) => {
    expect(only(text)).toMatchObject({ problem: { type: 'look-alike', fixed } })
  })

  it.each([
    ['\u2013', '-'],
    ['\u2014', '-'],
    ['\u2212', '-'],
    ['\u00d7', '*'],
    ['\uff0c', ','],
    ['\uff1a', ':'],
    ['\uff3b', '['],
    ['\uff4d', 'm'],
    ['\uff11', '1'],
  ])('reads %j as a look-alike of %j', (char, plain) => {
    expect(only(char)).toMatchObject({
      kind: 'problem',
      problem: { type: 'look-alike', char, plain, fixed: plain },
    })
  })
})

describe('character literals', () => {
  it.each([
    ["'A'", 65n],
    ["' '", 32n],
    ["'#'", 35n],
    ["';'", 59n],
    ["'\"'", 34n],
    ["'\\n'", 10n],
    ["'\\t'", 9n],
    ["'\\r'", 13n],
    ["'\\0'", 0n],
    ["'\\\\'", 92n],
    ["'\\''", 39n],
    ["'''", 39n],
    ["'é'", 233n],
    ["'\\012'", 10n],
    ["'\\x41'", 65n],
    ["'\\b'", 8n],
  ])('reads %s', (text, value) => {
    expect(only(text)).toMatchObject({ kind: 'number', value, character: true, text })
  })

  it.each([
    ["''", 'empty'],
    ["'AB'", 'too-long'],
    ["'A", 'unclosed'],
    ["'", 'unclosed'],
    ["'\\q'", 'escape'],
    ["'\\777'", 'octal-range'],
    ["'\\xg'", 'hex-digits'],
  ])('reports %s as a problem (%s)', (text, reason) => {
    expect(only(text)).toMatchObject({ kind: 'problem', problem: { type: 'character', reason } })
  })

  it('names the unknown escape', () => {
    expect(only("'\\q'")).toMatchObject({ problem: { escape: '\\q' } })
  })
})

describe('quoted text', () => {
  it('reads text and keeps what is inside', () => {
    expect(only('"Hello, World!"')).toMatchObject({ kind: 'string', value: 'Hello, World!' })
  })

  it('decodes every escape', () => {
    expect(only('"a\\n\\t\\r\\0\\\\\\"\\\'b"')).toMatchObject({
      kind: 'string',
      value: 'a\n\t\r\0\\"\'b',
    })
  })

  // gcc writes accented letters and control characters as octal escapes. Each byte
  // below was checked against clang (x86-64 target).
  it.each([
    ['"a\\012b"', [0x61, 0x0a, 0x62], 'a\nb'],
    ['"\\033[0m"', [0x1b, 0x5b, 0x30, 0x6d], '\u001b[0m'],
    ['"caf\\303\\251"', [0x63, 0x61, 0x66, 0xc3, 0xa9], 'café'],
    ['"\\x41\\x4a"', [0x41, 0x4a], 'AJ'],
    ['"\\x414"', [0x14], '\u0014'],
    ['"\\b\\f"', [0x08, 0x0c], '\b\f'],
    ['"\\08"', [0x00, 0x38], '\u00008'],
    ['"\\1234"', [0x53, 0x34], 'S4'],
    ['"é€"', [0xc3, 0xa9, 0xe2, 0x82, 0xac], 'é€'],
    ['"\\377"', [0xff], '\ufffd'],
  ])('reads the bytes of %s like gcc', (text, bytes, value) => {
    expect(only(text)).toMatchObject({ kind: 'string', bytes, value })
  })

  it.each([
    ['"\\777"', 'octal-range', '\\777'],
    ['"a\\x"', 'hex-digits', '\\x'],
    ['"\\v"', 'escape', '\\v'],
  ])('reports the bad escape in %s (%s)', (text, reason, escape) => {
    expect(only(text)).toMatchObject({ problem: { type: 'string', reason, escape } })
  })

  it('does not treat # ; // or % inside text as special', () => {
    const line = lexLine('.string "50% # not; a // comment"')
    expect(line.badComment).toBeNull()
    expect(line.tokens).toHaveLength(2)
    expect(line.tokens[1]).toMatchObject({ kind: 'string', value: '50% # not; a // comment' })
  })

  it('reads several texts on one line', () => {
    expect(shape('.string "a", "b"')).toEqual([
      'ident:.string',
      'string:"a"',
      'punct:,',
      'string:"b"',
    ])
  })

  it('reads empty text', () => {
    expect(only('""')).toMatchObject({ kind: 'string', value: '' })
  })

  it('reports text with no closing quote', () => {
    const token = only('"abc # not a comment')
    expect(token).toMatchObject({
      kind: 'problem',
      problem: { type: 'string', reason: 'unclosed' },
    })
    expect(token.text).toBe('"abc # not a comment')
  })

  it('reports a backslash at the end of the line as not closed', () => {
    expect(only('"abc\\')).toMatchObject({ problem: { type: 'string', reason: 'unclosed' } })
  })

  it('reports an unknown escape and names it', () => {
    expect(only('"a\\qb"')).toMatchObject({
      kind: 'problem',
      problem: { type: 'string', reason: 'escape', escape: '\\q' },
    })
  })

  it('reports text in curly quotes as one look-alike token', () => {
    const kinds = lexLine('.string \u201chi\u201d, 5').tokens.map((token) =>
      token.kind === 'problem' ? token.problem.type : token.kind,
    )
    expect(kinds).toEqual(['ident', 'look-alike', 'punct', 'number'])
  })
})

describe('comments', () => {
  it('stops at #', () => {
    expect(shape('ret # go back')).toEqual(['ident:ret'])
    expect(shape('# a whole line; with // other marks')).toEqual([])
  })

  it.each([
    ['mov rax, 5 ; five', ';', 11],
    ['; whole line', ';', 0],
    ['ret // back', '//', 4],
    ['/* block */ ret', '/*', 0],
  ] as const)('reports the wrong comment marker in %j', (text, marker, start) => {
    expect(lexLine(text).badComment).toEqual({ marker, start })
  })

  it('keeps the tokens in front of a wrong comment marker', () => {
    expect(shape('mov rax, 5 ; five')).toEqual(['ident:mov', 'ident:rax', 'punct:,', 'number:5'])
  })

  it('does not report ; after #', () => {
    expect(lexLine('ret # one; two').badComment).toBeNull()
  })

  it('does not report ; or # inside a character', () => {
    expect(lexLine("mov al, ';'").badComment).toBeNull()
    expect(shape("mov al, '#'")).toHaveLength(4)
  })

  it('reports a single / as a stray character, not as a comment', () => {
    const line = lexLine('mov rax, 6 / 2')
    expect(line.badComment).toBeNull()
    expect(line.tokens[4]).toMatchObject({ kind: 'problem', problem: { type: 'stray' }, text: '/' })
  })
})

describe('things the lexer cannot read', () => {
  it.each([
    ['010', 'leading-zero'],
    ['08', 'leading-zero'],
    ['00', 'leading-zero'],
    ['1Fh', 'hex-suffix'],
    ['0FFh', 'hex-suffix'],
    ['0xZZ', 'hex'],
    ['0x', 'hex'],
    ['0b102', 'binary'],
    ['12abc', 'other'],
    ['1.5', 'other'],
    ['1f', 'other'],
  ])('reports %s as a bad number (%s)', (text, reason) => {
    expect(only(text)).toMatchObject({ kind: 'problem', text, problem: { type: 'number', reason } })
  })

  it('reports %rax as AT&T syntax', () => {
    expect(only('%rax')).toMatchObject({
      kind: 'problem',
      text: '%rax',
      problem: { type: 'att-register' },
    })
  })

  it.each(['$5', '$-8', '$0x10', '$+3'])('reports %s as AT&T syntax', (text) => {
    expect(only(text)).toMatchObject({ kind: 'problem', text, problem: { type: 'att-immediate' } })
  })

  it('reads $name as a word (it is a legal label name)', () => {
    expect(shape('$name')).toEqual(['ident:$name'])
  })

  it('reports a % that is not in front of a name as a stray character', () => {
    expect(lexLine('5 % 2').tokens[1]).toMatchObject({
      kind: 'problem',
      problem: { type: 'stray' },
    })
  })

  it.each(['!', '&', '{', '`', '\\', 'é', '\u0007', '😀'])(
    'reports %j as one stray character',
    (text) => {
      expect(only(text)).toMatchObject({ kind: 'problem', text, problem: { type: 'stray' } })
    },
  )

  it('goes on after a problem', () => {
    expect(shape('mov %rax, 5')).toEqual(['ident:mov', 'problem:%rax', 'punct:,', 'number:5'])
  })
})

describe('robustness', () => {
  it('turns UTF-8 bytes back into text, with U+FFFD for broken bytes', () => {
    expect(utf8Text([0x48, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80])).toBe('Hé\u{1f600}')
    expect(utf8Text([0xc3])).toBe('\ufffd')
    expect(utf8Text([0x80, 0x41])).toBe('\ufffdA')
    // A surrogate and an overlong form are not correct UTF-8.
    expect(utf8Text([0xed, 0xa0, 0x80])).toBe('\ufffd\ufffd\ufffd')
    expect(utf8Text([0xc0, 0x80])).toBe('\ufffd\ufffd')
  })

  it('reads a very long line', () => {
    const line = `mov rax, ${'1+'.repeat(2500)}1`
    expect(lexLine(line).tokens).toHaveLength(3 + 2500 * 2 + 1)
  })

  it('never throws on random characters', () => {
    let seed = 12345
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed
    }
    for (let round = 0; round < 300; round++) {
      let text = ''
      const length = next() % 60
      for (let i = 0; i < length; i++) text += String.fromCharCode(next() % 0x300)
      const { tokens } = lexLine(text)
      // Every token is a piece of the line, in order, with no overlap. (A word leaves out
      // the invisible characters inside it.)
      let end = 0
      for (const token of tokens) {
        expect(token.start).toBeGreaterThanOrEqual(end)
        const piece = text.slice(token.start, token.end)
        const visible = token.kind === 'ident' || token.kind === 'number' ? strip(piece) : piece
        expect(visible).toBe(token.text)
        end = token.end
      }
    }
  })
})
