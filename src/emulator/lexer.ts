/**
 * The lexer: one line of program text → tokens.
 *
 * It knows the small things: where a word, a number, a piece of quoted text or a
 * character literal starts and ends, and that `#` starts a comment (but not inside
 * quotes). It never fails. Something it cannot read becomes a `problem` token, and the
 * parser decides whether that matters (a `%` after `.type` is fine; a `%` in front of
 * a register is AT&T syntax). A `;`, `//` or `/*` used as a comment marker ends the
 * line and is reported in `badComment`.
 *
 * Text pasted from a web page, a slide or a phone keyboard often holds characters that
 * look right but are not the ones gcc reads:
 * - a curly quote, a dash or a wide comma (`“`, `–`, `，`) becomes a `look-alike`
 *   problem that knows the plain character to type instead;
 * - a special space (U+00A0, …) is read as a space, and an invisible character
 *   (U+200B, U+FEFF, …) is read as nothing. Both are reported in `odd`, so the student
 *   can be warned: gcc refuses them.
 */

export type Punctuation = ',' | ':' | '[' | ']' | '+' | '-' | '*' | '(' | ')' | '=' | '@'

/** Why an escape in quoted text or in a character literal could not be read. */
export type EscapeProblem =
  /** `\q`: not an escape */
  | 'escape'
  /** `\777`: more than one byte */
  | 'octal-range'
  /** `\x` with no hex digit after it */
  | 'hex-digits'

/** Why the lexer could not read a piece of the line. */
export type LexProblem =
  /** `%rax` */
  | { type: 'att-register' }
  /** `$5` */
  | { type: 'att-immediate' }
  /** A word that starts with a digit but is not a number: `010`, `1Fh`, `0xZZ`, `12abc`. */
  | { type: 'number'; reason: 'leading-zero' | 'hex-suffix' | 'hex' | 'binary' | 'other' }
  /** A character literal that is empty, too long, not closed or has a bad escape. */
  | { type: 'character'; reason: 'empty' | 'too-long' | 'unclosed' | EscapeProblem; escape: string }
  /** Quoted text that is not closed or has a bad escape. */
  | { type: 'string'; reason: 'unclosed' | EscapeProblem; escape: string }
  /**
   * A character that looks like one gcc reads but is another one: `“` for `"`, `–` for
   * `-`, `，` for `,`. `char` is the first such character, `plain` the one to type
   * instead, and `fixed` the whole token with every such character replaced.
   */
  | { type: 'look-alike'; char: string; plain: string; fixed: string }
  /** Any other character that means nothing in assembly. */
  | { type: 'stray' }

interface TokenBase {
  /**
   * The text of the token. It is the piece of the line from `start` to `end`, except
   * that invisible characters inside a word or a number are left out.
   */
  text: string
  /** Offset of the first character in the line. */
  start: number
  /** Offset just after the last character. */
  end: number
}

/** A word: a mnemonic, a register, a directive, a label or a keyword. */
export interface IdentToken extends TokenBase {
  kind: 'ident'
}

/** A number (`42`, `0x2A`, `0b101`) or a character literal (`'A'`). */
export interface NumberToken extends TokenBase {
  kind: 'number'
  value: bigint
  /** True for a character literal. */
  character: boolean
}

/** Text in double quotes, with the escapes already decoded. */
export interface StringToken extends TokenBase {
  kind: 'string'
  /** The text as the student meant it (the bytes read as UTF-8). */
  value: string
  /** The bytes the text stands for: UTF-8, with each escape as the byte it names. */
  bytes: number[]
}

export interface PunctToken extends TokenBase {
  kind: 'punct'
  text: Punctuation
}

export interface ProblemToken extends TokenBase {
  kind: 'problem'
  problem: LexProblem
}

export type Token = IdentToken | NumberToken | StringToken | PunctToken | ProblemToken

export interface BadComment {
  marker: ';' | '//' | '/*'
  start: number
}

/** A character gcc refuses but the emulator can read past (see the file comment). */
export interface OddCharacter {
  /** 'space': looks like a space (U+00A0 …). 'invisible': has no width at all (U+200B …). */
  kind: 'space' | 'invisible'
  codePoint: number
  /** Offset in the line. */
  start: number
}

export interface LexedLine {
  tokens: Token[]
  /** Set when the line uses `;`, `//` or `/*` as a comment. The tokens stop there. */
  badComment: BadComment | null
  /** The first special space or invisible character outside text and comments, if any. */
  odd: OddCharacter | null
}

/** Escapes that stand for one fixed byte. Octal (`\012`) and hex (`\x0a`) are read apart. */
const ESCAPES: ReadonlyMap<string, number> = new Map([
  ['n', 0x0a],
  ['t', 0x09],
  ['r', 0x0d],
  ['b', 0x08],
  ['f', 0x0c],
  ['\\', 0x5c],
  ['"', 0x22],
  ["'", 0x27],
])

const PUNCTUATION: ReadonlySet<string> = new Set<Punctuation>([
  ',',
  ':',
  '[',
  ']',
  '+',
  '-',
  '*',
  '(',
  ')',
  '=',
  '@',
])

/** Characters that look like a plain one, and that plain one. (Wide forms are worked out.) */
const LOOK_ALIKES: ReadonlyMap<string, string> = new Map([
  ['\u201c', '"'], // “
  ['\u201d', '"'], // ”
  ['\u201e', '"'], // „
  ['\u201f', '"'], // ‟
  ['\u2033', '"'], // ″
  ['\u2018', "'"], // ‘
  ['\u2019', "'"], // ’
  ['\u201a', "'"], // ‚
  ['\u201b', "'"], // ‛
  ['\u2032', "'"], // ′
  ['\u2010', '-'], // ‐
  ['\u2011', '-'], // ‑
  ['\u2012', '-'], // ‒
  ['\u2013', '-'], // –
  ['\u2014', '-'], // —
  ['\u2015', '-'], // ―
  ['\u2212', '-'], // −
  ['\u00d7', '*'], // ×
])

/** The plain character a look-alike stands for, or undefined. */
function plainOf(ch: string | undefined): string | undefined {
  if (ch === undefined) return undefined
  const known = LOOK_ALIKES.get(ch)
  if (known !== undefined) return known
  // Wide forms from a Chinese, Japanese or Korean keyboard: `，` `：` `［` `ｍ` `１` …
  const point = ch.codePointAt(0) ?? 0
  return point >= 0xff01 && point <= 0xff5e ? String.fromCharCode(point - 0xfee0) : undefined
}

/** Spaces that are not the space key: no-break, thin, wide, ideographic, line separator, … */
function isSpecialSpace(ch: string | undefined): boolean {
  return ch !== undefined && /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(ch)
}

/** Characters with no width: zero-width space and joiners, direction marks, soft hyphen, BOM. */
export function isInvisible(ch: string | undefined): boolean {
  return (
    ch !== undefined &&
    /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/.test(ch)
  )
}

function isPunctuation(ch: string): ch is Punctuation {
  return PUNCTUATION.has(ch)
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

function isOctalDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '7'
}

function isHexDigit(ch: string | undefined): boolean {
  return ch !== undefined && /^[0-9a-fA-F]$/.test(ch)
}

function isLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
}

/** First character of a name: `[A-Za-z_.$]`. */
function isNameStart(ch: string | undefined): boolean {
  return ch !== undefined && (isLetter(ch) || ch === '_' || ch === '.' || ch === '$')
}

/** Later characters of a name: `[A-Za-z0-9_.$]`. */
function isNamePart(ch: string | undefined): boolean {
  return isNameStart(ch) || isDigit(ch)
}

/** Characters that can follow the first digit of a number-like word. */
function isNumberPart(ch: string | undefined): boolean {
  return ch !== undefined && (isDigit(ch) || isLetter(ch) || ch === '_' || ch === '.')
}

/** The spaces of a keyboard (and the line ends, should one reach the lexer). */
function isPlainSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\v' || ch === '\f' || ch === '\n' || ch === '\r'
}

type NumberReading =
  | { ok: true; value: bigint }
  | { ok: false; reason: 'leading-zero' | 'hex-suffix' | 'hex' | 'binary' | 'other' }

/** Read a word that starts with a digit: decimal, `0x` hex or `0b` binary. */
function readNumber(raw: string): NumberReading {
  if (raw === '0' || /^[1-9][0-9]*$/.test(raw)) return { ok: true, value: BigInt(raw) }
  if (/^0[xX][0-9a-fA-F]+$/.test(raw)) return { ok: true, value: BigInt(raw.toLowerCase()) }
  if (/^0[bB][01]+$/.test(raw)) return { ok: true, value: BigInt(raw.toLowerCase()) }
  if (/^0[0-9]+$/.test(raw)) return { ok: false, reason: 'leading-zero' }
  if (/^0[xX]/.test(raw)) return { ok: false, reason: 'hex' }
  if (/^[0-9][0-9a-fA-F]*[hH]$/.test(raw)) return { ok: false, reason: 'hex-suffix' }
  if (/^0[bB]/.test(raw)) return { ok: false, reason: 'binary' }
  return { ok: false, reason: 'other' }
}

/** Length in UTF-16 units of the character that starts at `index`. */
function characterLength(text: string, index: number): number {
  const point = text.codePointAt(index)
  return point !== undefined && point > 0xffff ? 2 : 1
}

type EscapeReading =
  | { ok: true; byte: number; length: number }
  | { ok: false; reason: EscapeProblem; escape: string; length: number }

/**
 * Read the escape whose backslash is just before `at`, the way gcc does:
 * `\n \t \r \b \f \\ \" \'`, one to three octal digits (`\0`, `\012`, `\303`), or `\x`
 * and hex digits (all of them are read; the last two give the byte). `length` is the
 * number of characters after the backslash.
 */
function readEscape(text: string, at: number): EscapeReading {
  const ch = text[at]
  if (isOctalDigit(ch)) {
    let end = at
    while (end < at + 3 && isOctalDigit(text[end])) end++
    const digits = text.slice(at, end)
    const value = parseInt(digits, 8)
    if (value > 0xff) {
      return { ok: false, reason: 'octal-range', escape: `\\${digits}`, length: end - at }
    }
    return { ok: true, byte: value, length: end - at }
  }
  if (ch === 'x') {
    let end = at + 1
    while (isHexDigit(text[end])) end++
    if (end === at + 1) return { ok: false, reason: 'hex-digits', escape: '\\x', length: 1 }
    const digits = text.slice(Math.max(at + 1, end - 2), end)
    return { ok: true, byte: parseInt(digits, 16), length: end - at }
  }
  const byte = ESCAPES.get(ch)
  if (byte !== undefined) return { ok: true, byte, length: 1 }
  const size = characterLength(text, at)
  return { ok: false, reason: 'escape', escape: `\\${text.slice(at, at + size)}`, length: size }
}

/** Text as UTF-8 bytes. */
export function utf8Bytes(text: string): number[] {
  const bytes: number[] = []
  for (const ch of text) {
    let point = ch.codePointAt(0) ?? 0
    // Half of a surrogate pair cannot be stored: use the replacement character.
    if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd
    if (point < 0x80) {
      bytes.push(point)
    } else if (point < 0x800) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f))
    } else if (point < 0x10000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f))
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      )
    }
  }
  return bytes
}

/** UTF-8 bytes as text. A byte that is not part of a correct UTF-8 character becomes `�`. */
export function utf8Text(bytes: readonly number[]): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const first = bytes[i]
    if (first < 0x80) {
      out += String.fromCharCode(first)
      i++
      continue
    }
    let follow = 0
    let point = 0
    let smallest = 0
    if (first >= 0xc2 && first <= 0xdf) {
      follow = 1
      point = first & 0x1f
      smallest = 0x80
    } else if (first >= 0xe0 && first <= 0xef) {
      follow = 2
      point = first & 0x0f
      smallest = 0x800
    } else if (first >= 0xf0 && first <= 0xf4) {
      follow = 3
      point = first & 0x07
      smallest = 0x10000
    }
    let read = 0
    while (read < follow) {
      const next = bytes.at(i + 1 + read)
      if (next === undefined || (next & 0xc0) !== 0x80) break
      point = (point << 6) | (next & 0x3f)
      read++
    }
    const whole =
      follow > 0 &&
      read === follow &&
      point >= smallest &&
      point <= 0x10ffff &&
      !(point >= 0xd800 && point <= 0xdfff)
    if (whole) {
      out += String.fromCodePoint(point)
      i += 1 + follow
    } else {
      out += '\ufffd'
      i++
    }
  }
  return out
}

/** Turn one line (without its line ending) into tokens. Never throws. */
export function lexLine(text: string): LexedLine {
  const tokens: Token[] = []
  const length = text.length
  let badComment: BadComment | null = null
  let odd: OddCharacter | null = null
  let i = 0

  const problem = (start: number, end: number, what: LexProblem): void => {
    tokens.push({ kind: 'problem', text: text.slice(start, end), start, end, problem: what })
  }

  const noteOdd = (kind: OddCharacter['kind'], at: number): void => {
    odd ??= { kind, codePoint: text.codePointAt(at) ?? 0, start: at }
  }

  /**
   * Read a word from `start`: the characters that pass `part`. Invisible characters
   * inside the word are skipped (the student sees one word, so it is one word).
   */
  const readRun = (start: number, part: (ch: string | undefined) => boolean): string => {
    let clean = ''
    i = start
    while (i < length) {
      if (part(text[i])) {
        clean += text[i]
        i++
        continue
      }
      let after = i
      while (isInvisible(text[after])) after++
      if (after === i || !part(text[after])) break
      noteOdd('invisible', i)
      i = after
    }
    return clean
  }

  /**
   * Quoted text that starts with a curly quote: read up to the next quote of the same
   * kind (curly or plain), so a `#` or `;` inside is not taken for a comment.
   */
  const lookAlikeQuote = (start: number, plain: '"' | "'"): void => {
    let close = start + 1
    while (close < length && text[close] !== plain && plainOf(text[close]) !== plain) close++
    const end = Math.min(close + 1, length)
    const inside = text.slice(start + 1, close)
    const fixed = close < length ? `${plain}${inside}${plain}` : `${plain}${inside}`
    problem(start, end, { type: 'look-alike', char: text[start], plain, fixed })
    i = end
  }

  while (i < length) {
    const ch = text[i]

    if (isPlainSpace(ch)) {
      i++
      continue
    }
    if (isSpecialSpace(ch)) {
      noteOdd('space', i)
      i++
      continue
    }
    if (isInvisible(ch)) {
      noteOdd('invisible', i)
      i++
      continue
    }

    // Comments. `#` is the real one; the others are common mistakes.
    if (ch === '#') break
    if (ch === ';') {
      badComment = { marker: ';', start: i }
      break
    }
    if (ch === '/') {
      const next = text[i + 1]
      if (next === '/' || next === '*') {
        badComment = { marker: next === '/' ? '//' : '/*', start: i }
        break
      }
      problem(i, i + 1, { type: 'stray' })
      i++
      continue
    }

    // Quoted text: "…"
    if (ch === '"') {
      const start = i
      const bytes: number[] = []
      let bad: { reason: EscapeProblem; escape: string } | null = null
      let closed = false
      i++
      while (i < length) {
        const c = text[i]
        if (c === '"') {
          closed = true
          i++
          break
        }
        if (c === '\\') {
          if (i + 1 >= length) {
            i = length
            break
          }
          const escape = readEscape(text, i + 1)
          if (escape.ok) bytes.push(escape.byte)
          else bad ??= { reason: escape.reason, escape: escape.escape }
          i += 1 + escape.length
          continue
        }
        const size = characterLength(text, i)
        for (const byte of utf8Bytes(text.slice(i, i + size))) bytes.push(byte)
        i += size
      }
      if (!closed) {
        // `"Hello”`: closed with a curly quote. Say that, not "not closed".
        let curly = start + 1
        while (curly < length && plainOf(text[curly]) !== '"') curly++
        if (curly < length) {
          const fixed = `${text.slice(start, curly)}"`
          problem(start, curly + 1, { type: 'look-alike', char: text[curly], plain: '"', fixed })
          i = curly + 1
        } else {
          problem(start, length, { type: 'string', reason: 'unclosed', escape: '' })
        }
      } else if (bad !== null) {
        problem(start, i, { type: 'string', reason: bad.reason, escape: bad.escape })
      } else {
        const value = utf8Text(bytes)
        tokens.push({ kind: 'string', text: text.slice(start, i), start, end: i, value, bytes })
      }
      continue
    }

    // Character literal: 'A'
    if (ch === "'") {
      const start = i
      const fail = (end: number, reason: 'empty' | 'too-long' | 'unclosed'): void => {
        problem(start, end, { type: 'character', reason, escape: '' })
        i = end
      }
      if (text.startsWith("'''", start)) {
        tokens.push({
          kind: 'number',
          text: "'''",
          start,
          end: start + 3,
          value: 39n,
          character: true,
        })
        i = start + 3
        continue
      }
      if (text[start + 1] === "'") {
        fail(start + 2, 'empty')
        continue
      }
      if (start + 1 >= length) {
        fail(length, 'unclosed')
        continue
      }
      let after: number
      let value: bigint
      let bad: { reason: EscapeProblem; escape: string } | null = null
      if (text[start + 1] === '\\') {
        if (start + 2 >= length) {
          fail(length, 'unclosed')
          continue
        }
        const escape = readEscape(text, start + 2)
        if (escape.ok) value = BigInt(escape.byte)
        else {
          bad = { reason: escape.reason, escape: escape.escape }
          value = 0n
        }
        after = start + 2 + escape.length
      } else {
        value = BigInt(text.codePointAt(start + 1) ?? 0)
        after = start + 1 + characterLength(text, start + 1)
      }
      if (bad !== null) {
        // The bad escape is the first thing to fix, whatever comes after it.
        const close = text.indexOf("'", after)
        const end = close === -1 ? after : close + 1
        problem(start, end, { type: 'character', reason: bad.reason, escape: bad.escape })
        i = end
        continue
      }
      if (text[after] === "'") {
        const end = after + 1
        tokens.push({
          kind: 'number',
          text: text.slice(start, end),
          start,
          end,
          value,
          character: true,
        })
        i = end
        continue
      }
      // `'A’`: closed with a curly quote.
      if (plainOf(text[after]) === "'") {
        const fixed = `${text.slice(start, after)}'`
        problem(start, after + 1, { type: 'look-alike', char: text[after], plain: "'", fixed })
        i = after + 1
        continue
      }
      // Not closed after one character: either too long ('AB') or never closed ('A).
      const close = text.indexOf("'", after)
      if (close !== -1) fail(close + 1, 'too-long')
      else fail(after, 'unclosed')
      continue
    }

    // Numbers, and words that start with a digit but are not numbers.
    if (isDigit(ch)) {
      const start = i
      const raw = readRun(start, isNumberPart)
      const reading = readNumber(raw)
      if (reading.ok) {
        tokens.push({
          kind: 'number',
          text: raw,
          start,
          end: i,
          value: reading.value,
          character: false,
        })
      } else {
        tokens.push({
          kind: 'problem',
          text: raw,
          start,
          end: i,
          problem: { type: 'number', reason: reading.reason },
        })
      }
      continue
    }

    // AT&T syntax: %rax
    if (ch === '%') {
      const start = i
      i++
      if (isNameStart(text[i])) {
        while (i < length && isNamePart(text[i])) i++
        problem(start, i, { type: 'att-register' })
      } else {
        problem(start, i, { type: 'stray' })
      }
      continue
    }

    // AT&T syntax: $5, $-8, $0x10. (`$name` is a legal label name, so it stays a word.)
    if (ch === '$') {
      const signed = text[i + 1] === '-' || text[i + 1] === '+'
      if (isDigit(text[i + 1]) || (signed && isDigit(text[i + 2]))) {
        const start = i
        i += signed ? 2 : 1
        while (i < length && isNumberPart(text[i])) i++
        problem(start, i, { type: 'att-immediate' })
        continue
      }
    }

    if (isNameStart(ch)) {
      const start = i
      const word = readRun(start, isNamePart)
      tokens.push({ kind: 'ident', text: word, start, end: i })
      continue
    }

    if (isPunctuation(ch)) {
      tokens.push({ kind: 'punct', text: ch, start: i, end: i + 1 })
      i++
      continue
    }

    const plain = plainOf(ch)
    if (plain === '"' || plain === "'") {
      lookAlikeQuote(i, plain)
      continue
    }
    if (plain !== undefined) {
      problem(i, i + 1, { type: 'look-alike', char: ch, plain, fixed: plain })
      i++
      continue
    }

    const size = characterLength(text, i)
    problem(i, i + size, { type: 'stray' })
    i += size
  }

  return { tokens, badComment, odd }
}
