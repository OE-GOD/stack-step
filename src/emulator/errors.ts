/**
 * The message catalog: every sentence the assembler can say to a student.
 *
 * One function per error code. Each takes the line number and the details of the
 * mistake and returns a finished `Diagnostic`. Wording lives here and nowhere else, so
 * it can be read, translated and tested in one place.
 *
 * Writing rules (see PLAN.md): short sentences, common words, one idea per sentence.
 * A message says what is wrong, then what to do instead, usually with a tiny example.
 * Code is wrapped in backticks (the UI shows backticked text in a code font).
 * When `line > 0` the message starts with "Line N: ".
 * A message never says the CPU cannot do something that x86-64 can do: when only this
 * emulator lacks it, the message says "this emulator".
 */
import { joinAnd, joinOr, signedHex } from './format'
import { lookupRegister, subRegister } from './registers'
import {
  LIBRARY_FUNCTIONS,
  MNEMONICS,
  type AssembleCode,
  type Diagnostic,
  type Mnemonic,
  type OperandSize,
} from './types'

/* ───────────────────────────── Small helpers ───────────────────────────── */

/** Longest piece of student text repeated inside a message (in characters). */
const QUOTE_LIMIT = 40

/** Longest corrected line shown in a message (a whole line needs more room). */
export const LINE_LIMIT = 60

/** Longest suggested fix built from the student's own name (it must stay copyable). */
const FIX_LIMIT = 120

/**
 * Wrap code in backticks. Student text is made safe first: a backtick inside it would
 * end the code font early, control characters cannot be shown, and a very long piece
 * is cut short. (One parameter only: other modules call `items.map(code)`.)
 */
export function code(text: string): string {
  return quote(text, QUOTE_LIMIT)
}

/**
 * Code the student can copy as it is (a suggested fix built from their own text). It has
 * more room than `code`, so a long name is not cut short in the middle of the fix.
 */
function fix(text: string): string {
  return quote(text, FIX_LIMIT)
}

/** `code` with room for `limit` characters. */
function quote(text: string, limit: number): string {
  const shown: string[] = []
  let cut = false
  for (const ch of text) {
    if (shown.length === limit) {
      cut = true
      break
    }
    const point = ch.codePointAt(0) ?? 0
    const hidden = point < 0x20 || (point >= 0x7f && point < 0xa0)
    const brokenPair = point >= 0xd800 && point <= 0xdfff
    if (ch === '`') shown.push("'")
    else if (hidden || brokenPair) shown.push(' ')
    else shown.push(ch)
  }
  const body = shown.join('').trim()
  return '`' + (body === '' ? ' ' : body) + (cut ? '…' : '') + '`'
}

/** "`a`", "`a` or `b`", "`a`, `b` or `c`". */
function orList(items: readonly string[]): string {
  return joinOr(items.map(code))
}

/** "`a`", "`a` and `b`", "`a`, `b` and `c`". */
function andList(items: readonly string[]): string {
  return joinAnd(items.map(code))
}

/** The smallest and biggest number that fits in `size` bits (signed or unsigned view). */
function rangeOf(size: OperandSize): string {
  const bits = BigInt(size)
  return `${-(1n << (bits - 1n))} and ${(1n << bits) - 1n}`
}

/** `U+00A0` */
function unicodeName(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
}

function make(
  severity: Diagnostic['severity'],
  which: AssembleCode,
  line: number,
  text: string,
): Diagnostic {
  return { severity, code: which, line, message: line > 0 ? `Line ${line}: ${text}` : text }
}

function error(which: AssembleCode, line: number, text: string): Diagnostic {
  return make('error', which, line, text)
}

function warning(which: AssembleCode, line: number, text: string): Diagnostic {
  return make('warning', which, line, text)
}

const SIZE_WORDS_TEXT = `${code('byte ptr')} (1 byte), ${code('word ptr')} (2), ${code('dword ptr')} (4) or ${code('qword ptr')} (8)`
const OPERAND_KINDS_TEXT = `a register, a number or memory, like ${code('rax')}, ${code('5')} or ${code('[rbp-8]')}`

/** A piece of an instruction and its width, for size messages. */
export interface SizedText {
  text: string
  size: OperandSize
}

/* ───────────────────────── Reading one line ───────────────────────── */

export function commentStyle(line: number, detail: { marker: ';' | '//' | '/*' }): Diagnostic {
  // gcc does read `/* … */` comments, so for those the limit is this emulator's.
  return error(
    'comment-style',
    line,
    detail.marker === '/*'
      ? `this emulator reads only ${code('#')} comments, not ${code('/* */')}. Change ${code('/*')} to ${code('#')}.`
      : `in gcc assembly a comment starts with ${code('#')}, not ${code(detail.marker)}. Change ${code(detail.marker)} to ${code('#')}.`,
  )
}

/**
 * A character that looks like one gcc reads but is another one (a curly quote, a dash,
 * a wide comma), often pasted from a slide or typed on a phone. `fixed` is the line
 * with every such character replaced.
 */
export function lookAlike(
  line: number,
  detail: { char: string; plain: string; fixed: string },
): Diagnostic {
  const isQuote = detail.plain === '"' || detail.plain === "'"
  return error(
    isQuote ? 'bad-string' : 'bad-operand',
    line,
    `${code(detail.char)} looks like ${code(detail.plain)}, but gcc can't read it. Type ${code(detail.plain)} instead: ${quote(detail.fixed, LINE_LIMIT)}.`,
  )
}

/**
 * A warning: a special space or an invisible character, which gcc refuses. The
 * emulator reads it as a space (or as nothing), so the program still runs.
 */
export function oddCharacter(
  line: number,
  detail: { kind: 'space' | 'invisible'; codePoint: number },
): Diagnostic {
  const name = unicodeName(detail.codePoint)
  return warning(
    'bad-operand',
    line,
    detail.kind === 'space'
      ? `this line has a special space (${name}) that gcc can't read. Delete the spaces on this line and type them again.`
      : `this line has an invisible character (${name}) that gcc can't read. Delete the line and type it again.`,
  )
}

export type AttSyntaxDetail =
  /** `movq`: an instruction name with an AT&T size letter at the end. */
  | { reason: 'mnemonic'; written: string; instead: string }
  /** `%rax` */
  | { reason: 'register'; text: string }
  /** `$5` or `$name` */
  | { reason: 'immediate'; text: string }
  /**
   * A whole line in AT&T syntax (`movq %rbx, %rax`). `intel` is the same instruction in
   * Intel syntax (`mov rax, rbx`). `order` says what happened to the operands:
   * 'destination' when the destination moved to the front, 'swapped' for the two
   * operands of `cmp` or `test`, 'same' when there was nothing to turn around.
   */
  | { reason: 'line'; intel: string; order: 'destination' | 'swapped' | 'same' }

export function attSyntax(line: number, detail: AttSyntaxDetail): Diagnostic {
  switch (detail.reason) {
    case 'line': {
      // Followed piece by piece, the other messages would keep the AT&T order, and
      // `mov rbx, rax` copies the other way. So the whole line is shown, turned around.
      const intel = `This emulator uses Intel syntax`
      const how = {
        destination: `${intel}, which puts the destination first`,
        swapped: `${intel}, which puts the two operands in the other order`,
        same: intel,
      }[detail.order]
      return error(
        'att-syntax',
        line,
        `this line is AT&T syntax. ${how}: write ${quote(detail.intel, LINE_LIMIT)}.`,
      )
    }
    case 'mnemonic':
      return error(
        'att-syntax',
        line,
        `${code(detail.written)} is AT&T syntax. This emulator uses Intel syntax: write ${code(detail.instead)}, not ${code(detail.written)}.`,
      )
    case 'register':
      return error(
        'att-syntax',
        line,
        `this looks like AT&T syntax (${code(detail.text)}). This emulator uses Intel syntax: write ${code(detail.text.replace(/^%/, ''))} with no ${code('%')}, like ${code('mov rax, 5')}.`,
      )
    case 'immediate':
      return error(
        'att-syntax',
        line,
        `this looks like AT&T syntax (${code(detail.text)}). This emulator uses Intel syntax: write ${code(detail.text.replace(/^\$/, ''))} with no ${code('$')}, like ${code('mov rax, 5')}.`,
      )
  }
}

export type BadNumberDetail =
  /** `010`: gcc would read it as octal. `fixed` is the number without the zero. */
  | { reason: 'leading-zero'; text: string; fixed: string }
  /** `1Fh`: hex the MASM way. `fixed` is the gcc spelling. */
  | { reason: 'hex-suffix'; text: string; fixed: string }
  /** `0xZZ` */
  | { reason: 'hex'; text: string }
  /** `0b102` */
  | { reason: 'binary'; text: string }
  /** `12abc` */
  | { reason: 'other'; text: string }
  /** `''` */
  | { reason: 'empty-character' }
  /** `'AB'` */
  | { reason: 'long-character'; text: string }

export function badNumber(line: number, detail: BadNumberDetail): Diagnostic {
  switch (detail.reason) {
    case 'leading-zero': {
      // gcc refuses `08` and `09`: 8 and 9 are not octal digits.
      const notOctal = /[89]/.exec(detail.text)?.[0]
      const reads =
        notOctal === undefined
          ? 'so gcc reads it as an octal (base 8) number'
          : `so gcc tries to read it as an octal (base 8) number, and ${notOctal} is not an octal digit`
      return error(
        'bad-number',
        line,
        `${code(detail.text)} starts with a zero, ${reads}. Remove the zero: write ${code(detail.fixed)}.`,
      )
    }
    case 'hex-suffix':
      return error(
        'bad-number',
        line,
        `${code(detail.text)} is the way other assemblers write hex. In gcc assembly, write ${code(detail.fixed)}.`,
      )
    case 'hex':
      return error(
        'bad-number',
        line,
        `${code(detail.text)} is not a hex number. After ${code('0x')}, use only the digits 0 to 9 and the letters a to f.`,
      )
    case 'binary':
      return error(
        'bad-number',
        line,
        `${code(detail.text)} is not a binary number. After ${code('0b')}, use only 0 and 1.`,
      )
    case 'other':
      return error(
        'bad-number',
        line,
        `${code(detail.text)} is not a number. A number looks like ${code('42')}, ${code('0x2A')} or ${code('0b101')}.`,
      )
    case 'empty-character':
      return error(
        'bad-number',
        line,
        `there is nothing between the two ${code("'")} marks. Put one character there, like ${code("'A'")}.`,
      )
    case 'long-character':
      return error(
        'bad-number',
        line,
        `${code(detail.text)} has more than one character. Single quotes hold one character, like ${code("'A'")}.`,
      )
  }
}

export type BadStringDetail =
  /** `"Hello` */
  | { reason: 'unclosed' }
  /** `'A` */
  | { reason: 'unclosed-character'; text: string }
  /** `\q` inside text or a character */
  | { reason: 'escape'; escape: string }
  /** `\777`: an octal escape bigger than one byte */
  | { reason: 'octal-range'; escape: string }
  /** `\x` with no hex digit after it */
  | { reason: 'hex-digits' }

export function badString(line: number, detail: BadStringDetail): Diagnostic {
  switch (detail.reason) {
    case 'unclosed':
      return error(
        'bad-string',
        line,
        `the text has no closing ${code('"')}. Put a ${code('"')} at the end of the text, like ${code('"Hello"')}.`,
      )
    case 'unclosed-character':
      return error(
        'bad-string',
        line,
        `${code(detail.text)} has no closing ${code("'")}. Write ${fix(`${detail.text}'`)}.`,
      )
    case 'escape':
      return error(
        'bad-string',
        line,
        `${code(detail.escape)} is not an escape gcc knows. The common ones are ${code('\\n')} (new line), ${code('\\t')} (tab), ${code('\\"')} (a quote) and ${code('\\\\')} (a backslash).`,
      )
    case 'octal-range':
      return error(
        'bad-string',
        line,
        `${code(detail.escape)} is too big for one byte. An octal escape can be at most ${code('\\377')}.`,
      )
    case 'hex-digits':
      return error(
        'bad-string',
        line,
        `${code('\\x')} needs hex digits after it, like ${code('\\x41')}.`,
      )
  }
}

export type BadLabelDetail =
  | { reason: 'register'; name: string }
  /** `byte`, `word`, `dword`, `qword`: the size words of `byte ptr` and its friends */
  | { reason: 'size'; name: string }
  /** `1loop:` */
  | { reason: 'digit'; text: string }
  /** `:` with nothing in front */
  | { reason: 'empty' }
  /** `my-label:`; `fixed` is a name that works */
  | { reason: 'characters'; text: string; fixed: string }

export function badLabel(line: number, detail: BadLabelDetail): Diagnostic {
  switch (detail.reason) {
    case 'register':
      return error(
        'bad-label',
        line,
        `${code(detail.name)} is a register name, so it can't be a label. Choose a different name.`,
      )
    case 'size':
      return error(
        'bad-label',
        line,
        `${code(detail.name)} is a size word, as in ${code(`${detail.name.toLowerCase()} ptr`)}, so it can't be a label. Choose a different name.`,
      )
    case 'digit':
      return error(
        'bad-label',
        line,
        `the label ${code(detail.text)} starts with a digit. Start a label with a letter or ${code('_')}.`,
      )
    case 'empty':
      return error(
        'bad-label',
        line,
        `there is a ${code(':')} with no label name in front of it. Write a name first, like ${code('done:')}.`,
      )
    case 'characters':
      return error(
        'bad-label',
        line,
        `${code(detail.text)} is not a label name gcc accepts. Use only letters, digits and ${code('_')}, like ${fix(detail.fixed)}.`,
      )
  }
}

export function duplicateLabel(
  line: number,
  detail: { name: string; firstLine: number; what: 'label' | 'name' },
): Diagnostic {
  const text =
    detail.what === 'label'
      ? `the label ${code(detail.name)} is already defined on line ${detail.firstLine}. Give this label a different name.`
      : `the name ${code(detail.name)} is already defined on line ${detail.firstLine}. Use a different name, or delete one of the two lines.`
  return error('duplicate-label', line, text)
}

export type UnknownInstructionDetail =
  /** A word that is not an instruction. `suggestions` holds the closest real ones. */
  | { reason: 'typo'; written: string; suggestions: readonly string[] }
  /** A word alone on its line: probably a label without its colon. */
  | { reason: 'label-without-colon'; written: string }
  /** The line starts with a register: `rax, 5`. */
  | { reason: 'register'; written: string }
  /** `globl main`: a directive without its dot. */
  | { reason: 'missing-dot'; written: string }
  /** `section .data`, `msg db 5`: NASM syntax. `instead` is what gcc wants (nothing: delete the line). */
  | { reason: 'nasm'; written: string; instead: readonly string[] }
  /**
   * `buf resb 8`, `SIZE equ 8`: a NASM line that gcc writes another way. `written` is the
   * NASM word, `fix` the whole gcc line, like `buf: .zero 8` or `.equ SIZE, 8`.
   */
  | { reason: 'nasm-line'; written: string; fix: string }
  /** The line starts with something that is not a word at all: `5 + 3`. */
  | { reason: 'not-a-word'; written: string }

export function unknownInstruction(line: number, detail: UnknownInstructionDetail): Diagnostic {
  const written = code(detail.written)
  switch (detail.reason) {
    case 'typo':
      return error(
        'unknown-instruction',
        line,
        detail.suggestions.length > 0
          ? `${written} is not an instruction this emulator knows. Did you mean ${orList(detail.suggestions)}?`
          : `${written} is not an instruction this emulator knows. Check the spelling.`,
      )
    case 'label-without-colon':
      return error(
        'unknown-instruction',
        line,
        `${written} is not an instruction this emulator knows. If it is a label, put ${code(':')} after it, like ${fix(`${detail.written}:`)}.`,
      )
    case 'register':
      return error(
        'unknown-instruction',
        line,
        `${written} is a register, not an instruction. Start the line with an instruction, like ${code('mov rax, 5')}.`,
      )
    case 'missing-dot':
      return error(
        'unknown-instruction',
        line,
        `${written} is not an instruction. Did you mean ${fix(`.${detail.written}`)}, with a dot in front?`,
      )
    case 'nasm':
      return error(
        'unknown-instruction',
        line,
        detail.instead.length > 0
          ? `${written} is NASM syntax. In gcc assembly, write ${orList(detail.instead)}.`
          : `${written} is NASM syntax. gcc assembly does not need this line. Delete it.`,
      )
    case 'nasm-line':
      return error(
        'unknown-instruction',
        line,
        `${written} is NASM syntax. In gcc assembly, write ${fix(detail.fix)}.`,
      )
    case 'not-a-word':
      return error(
        'unknown-instruction',
        line,
        `a line can't start with ${written}. Start it with an instruction, like ${code('mov rax, 5')}.`,
      )
  }
}

/** One more sentence of help for a few instructions students often reach for. */
const UNSUPPORTED_TIPS: ReadonlyMap<string, string> = new Map([
  ['mul', `To multiply, use ${code('imul')}.`],
  ['movabs', `Use ${code('mov')}: it can copy any 64-bit number into a register.`],
  // `movsxd` is the spelling that both gcc and clang accept for a 32-bit source.
  ['cdqe', `Use ${code('movsxd rax, eax')} instead.`],
  ['cltq', `Use ${code('movsxd rax, eax')} instead.`],
  ['syscall', `To print, use ${code('call printf@PLT')}. To stop, use ${code('ret')}.`],
  ['int', `To print, use ${code('call printf@PLT')}. To stop, use ${code('ret')}.`],
])

/**
 * "`mov`, `movzx`, … `jmp`, the conditional jumps like `je` and `jg`, `call`, `ret`, `nop`
 * and `leave`": every mnemonic in code font, with the fourteen conditional jumps as one item.
 */
const SUPPORTED_TEXT = (() => {
  const isConditional = (mnemonic: string): boolean => /^j/.test(mnemonic) && mnemonic !== 'jmp'
  const firstJump = MNEMONICS.findIndex(isConditional)
  const before = MNEMONICS.slice(0, firstJump)
  const after = MNEMONICS.slice(firstJump).filter((mnemonic) => !isConditional(mnemonic))
  const jumps = `the conditional jumps like ${code('je')} and ${code('jg')}`
  return `${before.map(code).join(', ')}, ${jumps}, ${andList(after)}`
})()

export function unsupportedInstruction(
  line: number,
  /** `base` is the Intel name when `written` has an AT&T size letter (`shlq` → `shl`). */
  detail: { written: string; base?: string },
): Diagnostic {
  const base = detail.base ?? detail.written
  const start =
    base === detail.written
      ? `${code(base)} is a real instruction, but this emulator does not support it.`
      : `${code(detail.written)} is the AT&T name of ${code(base)}. ${code(base)} is a real instruction, but this emulator does not support it.`
  const tip = UNSUPPORTED_TIPS.get(base)
  return error(
    'unsupported-instruction',
    line,
    `${start} ${tip ?? `It supports ${SUPPORTED_TEXT}.`}`,
  )
}

/** The operands an instruction takes, as shown in "needs 2 operands: …". */
function shapeOf(mnemonic: Mnemonic): string {
  switch (mnemonic) {
    case 'mov':
    case 'movzx':
    case 'movsx':
    case 'add':
    case 'sub':
    case 'imul':
    case 'and':
    case 'or':
    case 'xor':
      return 'destination, source'
    case 'cmp':
    case 'test':
      return 'first, second'
    case 'lea':
      return 'register, [address]'
    case 'inc':
    case 'dec':
    case 'pop':
      return 'destination'
    case 'push':
      return 'source'
    case 'ret':
    case 'nop':
    case 'leave':
      return ''
    default:
      return 'label'
  }
}

export function operandCount(
  line: number,
  detail: {
    /** The instruction as typed (lower case). */
    written: string
    mnemonic: Mnemonic
    expected: number
    found: number
    /** Two operands were written with no comma between them. */
    missingComma?: boolean
  },
): Diagnostic {
  const name = code(detail.written)
  if (detail.expected === 0) {
    // x86-64 also has `ret 16` and `nop dword ptr [rax]`; this emulator does not.
    const here = detail.written === 'ret' || detail.written === 'nop' ? ' in this emulator' : ''
    return error(
      'operand-count',
      line,
      `${name} takes no operands${here}. Write ${name} by itself.`,
    )
  }
  const shape = code(`${detail.written} ${shapeOf(detail.mnemonic)}`)
  // "Operand" is explained where students meet it most: the parts after the instruction.
  const what = detail.expected === 1 ? 'operand (the part' : 'operands (the parts'
  const needs = `${name} needs ${detail.expected} ${what} after ${name}): ${shape}.`
  if (detail.missingComma === true) {
    return error('operand-count', line, `${needs} Put a comma between the operands.`)
  }
  const has = detail.found === 0 ? 'none' : String(detail.found)
  return error('operand-count', line, `${needs} This line has ${has}.`)
}

/* ───────────────────────────── Operands ───────────────────────────── */

export type BadOperandDetail =
  /** A character that means nothing in assembly: `!`, `&`, `{` … */
  | { reason: 'character'; text: string }
  /** A character that cannot be shown (a control character). */
  | { reason: 'hidden-character'; codePoint: number }
  /** `mov rax, , 5` or `mov rax,` */
  | { reason: 'empty' }
  /** `rax+8` without brackets */
  | { reason: 'register-arithmetic'; text: string }
  /** `"text"` used as an operand */
  | { reason: 'string' }
  /** `fs:40` */
  | { reason: 'segment'; text: string }
  /** `5 +`: `after` is the sign with nothing behind it */
  | { reason: 'missing-value'; text: string; after: string }
  /** `(5+3` */
  | { reason: 'parenthesis'; text: string }
  /** `offset` with no label behind it */
  | { reason: 'offset'; text: string }
  /** `msg*2`, `msg-other` outside brackets */
  | { reason: 'label-arithmetic'; text: string }
  /** `printf@GOT`, `done@PLT` in the wrong place */
  | { reason: 'suffix'; text: string }
  /** Anything else the parser cannot read. */
  | { reason: 'unreadable'; text: string }

export function badOperand(line: number, detail: BadOperandDetail): Diagnostic {
  switch (detail.reason) {
    case 'character':
      return error(
        'bad-operand',
        line,
        detail.text === '`'
          ? `this emulator can't read the backquote character here. An operand is ${OPERAND_KINDS_TEXT}.`
          : `this emulator can't read ${code(detail.text)} here. An operand is ${OPERAND_KINDS_TEXT}.`,
      )
    case 'hidden-character':
      return error(
        'bad-operand',
        line,
        `this line has a character that can't be shown (${unicodeName(detail.codePoint)}). Delete the line and type it again.`,
      )
    case 'empty':
      return error(
        'bad-operand',
        line,
        `there is a comma with nothing next to it. Write the operands like ${code('mov rax, 5')}.`,
      )
    case 'register-arithmetic':
      return error(
        'bad-operand',
        line,
        `${code(detail.text)} is not a register and not a number. If you mean memory, put it in brackets: ${fix(`[${detail.text}]`)}.`,
      )
    case 'string':
      return error(
        'bad-operand',
        line,
        `text in quotes can't be an operand. Put it on its own line with a label, like ${code('msg: .string "Hi"')}, then use ${code('msg')}.`,
      )
    case 'segment':
      return error(
        'bad-operand',
        line,
        /\bfs:(40|0x28)$/i.test(detail.text)
          ? `${code(detail.text)} is gcc's stack protector, and this emulator has no segment registers. Compile with ${code('-fno-stack-protector')} to leave it out.`
          : `${code(detail.text)} uses a segment register. This emulator does not support segment registers.`,
      )
    case 'missing-value':
      return error(
        'bad-operand',
        line,
        `something is missing after ${code(detail.after)} in ${code(detail.text)}. Put a number or a name there.`,
      )
    case 'parenthesis':
      return error(
        'bad-operand',
        line,
        `the ${code('(')} and ${code(')')} in ${code(detail.text)} do not match. Each ${code('(')} needs a ${code(')')}.`,
      )
    case 'offset':
      return error(
        'bad-operand',
        line,
        `${code('offset')} must be followed by a label, like ${code('offset message')}.`,
      )
    case 'label-arithmetic':
      return error(
        'bad-operand',
        line,
        `this emulator can't calculate ${code(detail.text)}. You can only add a number to a label, like ${code('message+8')}.`,
      )
    case 'suffix':
      return error(
        'bad-operand',
        line,
        `this emulator can't read ${code(detail.text)}. ${code('@PLT')} goes after a function name in a call, like ${code('call printf@PLT')}.`,
      )
    case 'unreadable':
      return error(
        'bad-operand',
        line,
        `this emulator can't read ${code(detail.text)}. An operand is ${OPERAND_KINDS_TEXT}.`,
      )
  }
}

export type BadMemoryOperandDetail =
  /** `[rbp-8` */
  | { reason: 'missing-close'; text: string }
  /** `rbp-8]` */
  | { reason: 'missing-open'; text: string }
  /** `[]` */
  | { reason: 'empty' }
  /** `[rax]rbx`: `after` is the stray text */
  | { reason: 'after-bracket'; text: string; after: string }
  /** `[[rax]]` */
  | { reason: 'nested'; text: string }
  /** `[rax+rbx*3]` */
  | { reason: 'scale'; scale: string }
  /** `[rbp-rax]` */
  | { reason: 'minus-register'; text: string }
  /** `[rbp-message]` */
  | { reason: 'minus-label'; text: string }
  /** `[a+b]` */
  | { reason: 'two-labels'; text: string }
  /** `[message*2]` */
  | { reason: 'label-arithmetic'; text: string }
  /** `[rip+rax+message]` */
  | { reason: 'rip-register'; text: string }
  /** `[rip]`, `[rip+8]` */
  | { reason: 'rip-label'; text: string }
  /** `[rip*2+message]` */
  | { reason: 'rip-scale'; text: string }
  /** `rax[rbx]` */
  | { reason: 'register-prefix'; text: string }
  /** `dword [rbp-8]`: the size word without `ptr` (NASM style). `fixed` has the `ptr`. */
  | { reason: 'missing-ptr'; word: string; fixed: string }
  /** `dword ptr eax`, `dword ptr 5`, `ptr [rax]` */
  | { reason: 'size-without-memory'; text: string }
  /** `[rax*rbx]` */
  | { reason: 'register-product'; text: string }
  /** `[rax+0x100000000]` */
  | { reason: 'displacement'; text: string }

export function badMemoryOperand(line: number, detail: BadMemoryOperandDetail): Diagnostic {
  switch (detail.reason) {
    case 'missing-close':
      return error(
        'bad-memory-operand',
        line,
        `${code(detail.text)} is missing its closing ${code(']')}. Write ${fix(`${detail.text}]`)}.`,
      )
    case 'missing-open':
      return error(
        'bad-memory-operand',
        line,
        `${code(detail.text)} has a ${code(']')} with no ${code('[')} before it. A memory operand looks like ${code('[rbp-8]')}.`,
      )
    case 'empty':
      return error(
        'bad-memory-operand',
        line,
        `the brackets ${code('[]')} are empty. Put an address inside, like ${code('[rax]')} or ${code('[rbp-8]')}.`,
      )
    case 'after-bracket':
      return error(
        'bad-memory-operand',
        line,
        `this emulator can't read ${code(detail.after)} after the ${code(']')} in ${code(detail.text)}. A memory operand ends at the ${code(']')}.`,
      )
    case 'nested':
      return error(
        'bad-memory-operand',
        line,
        `${code(detail.text)} has brackets inside brackets. Use one pair, like ${code('[rax+8]')}.`,
      )
    case 'scale':
      return error(
        'bad-memory-operand',
        line,
        `a register in an address can't be multiplied by ${detail.scale}. Use 1, 2, 4 or 8, like ${code('[rax+rbx*8]')}.`,
      )
    case 'minus-register':
      return error(
        'bad-memory-operand',
        line,
        `you can't subtract a register in an address, as ${code(detail.text)} does. Only a number can follow ${code('-')}, like ${code('[rbp-8]')}.`,
      )
    case 'minus-label':
      return error(
        'bad-memory-operand',
        line,
        `you can't subtract a label in an address, as ${code(detail.text)} does. Only a number can follow ${code('-')}, like ${code('[rbp-8]')}.`,
      )
    case 'two-labels':
      return error(
        'bad-memory-operand',
        line,
        `${code(detail.text)} uses two labels. An address can use only one label.`,
      )
    case 'label-arithmetic':
      return error(
        'bad-memory-operand',
        line,
        `this emulator can't calculate the address ${code(detail.text)}. You can only add a number to a label, like ${code('message+8')}.`,
      )
    case 'rip-register':
      return error(
        'bad-memory-operand',
        line,
        `${code('rip')} can't be used with another register, as ${code(detail.text)} does. Write a label and ${code('rip')} only, like ${code('message[rip]')}.`,
      )
    case 'rip-label':
      return error(
        'bad-memory-operand',
        line,
        `${code(detail.text)} uses ${code('rip')} without a label. Write a label in front, like ${code('message[rip]')}.`,
      )
    case 'rip-scale':
      return error(
        'bad-memory-operand',
        line,
        `${code('rip')} can't be multiplied or subtracted, as ${code(detail.text)} does. Write a label and ${code('rip')} only, like ${code('message[rip]')}.`,
      )
    case 'register-prefix':
      return error(
        'bad-memory-operand',
        line,
        `${code(detail.text)} has a register in front of the brackets. Put every register inside them, like ${code('[rax+rbx]')}.`,
      )
    case 'missing-ptr':
      return error(
        'bad-memory-operand',
        line,
        `${code(detail.word)} needs the word ${code('ptr')} after it. Write ${code(detail.fixed)}.`,
      )
    case 'size-without-memory':
      return error(
        'bad-memory-operand',
        line,
        `this emulator can't read ${code(detail.text)}. A size like ${code('dword ptr')} goes in front of memory, like ${code('dword ptr [rbp-8]')}.`,
      )
    case 'register-product':
      return error(
        'bad-memory-operand',
        line,
        `${code(detail.text)} multiplies two registers. A register can only be multiplied by 1, 2, 4 or 8, like ${code('[rax+rbx*8]')}.`,
      )
    case 'displacement':
      return error(
        'bad-memory-operand',
        line,
        `the number in ${code(detail.text)} is too big for an address. Copy it into a register first, then use the register in the brackets.`,
      )
  }
}

export type AddressRegisterDetail =
  /** `[ebp-8]`: `wide` is the 64-bit name of the same register */
  | { reason: 'not-64'; name: string; size: OperandSize; wide: string }
  /** `[rax+rsp*2]` */
  | { reason: 'rsp-index'; text: string }
  /** `[rax*2+rbx*4]` */
  | { reason: 'two-scaled'; text: string }
  /** `[rax+rbx+rcx]` */
  | { reason: 'three-registers'; text: string }

export function addressRegister(line: number, detail: AddressRegisterDetail): Diagnostic {
  switch (detail.reason) {
    case 'not-64':
      // x86-64 can build an address from 32-bit registers too; this emulator cannot.
      return error(
        'address-register',
        line,
        `${code(detail.name)} is ${detail.size} bits. This emulator builds addresses only from 64-bit registers, so write ${code(detail.wide)} here.`,
      )
    case 'rsp-index':
      // Two shapes reach here: rsp multiplied (`[rax+rsp*2]`) and rsp used twice (`[rsp+rsp]`).
      return error(
        'address-register',
        line,
        /\brsp\s*\*/i.test(detail.text)
          ? `${code('rsp')} can't be the multiplied register in an address, as in ${code(detail.text)}. Multiply a different register, like ${code('[rax+rbx*2]')}.`
          : `${code('rsp')} can be used only once in an address, and ${code(detail.text)} uses it twice. Use a different register for the second one, like ${code('[rsp+rax]')}.`,
      )
    case 'two-scaled':
      return error(
        'address-register',
        line,
        `${code(detail.text)} multiplies two registers. An address can multiply only one, like ${code('[rax+rbx*8]')}.`,
      )
    case 'three-registers':
      return error(
        'address-register',
        line,
        `${code(detail.text)} uses three registers. An address can use at most two, like ${code('[rax+rbx*8]')}.`,
      )
  }
}

export type UnknownRegisterDetail =
  /** A register-like word. `suggestions` holds the real names one edit away (maybe none). */
  | { reason: 'typo'; name: string; suggestions: readonly string[] }
  /** `rip` used as a plain operand */
  | { reason: 'rip'; name: string }
  /** `eip` */
  | { reason: 'eip'; name: string }
  /** `xmm0`, `cs`, `st0`: real, but not one of the sixteen */
  | { reason: 'not-general'; name: string }

export function unknownRegister(line: number, detail: UnknownRegisterDetail): Diagnostic {
  const name = code(detail.name)
  switch (detail.reason) {
    case 'typo':
      return error(
        'unknown-register',
        line,
        detail.suggestions.length > 0
          ? `${name} is not a register. Did you mean ${orList(detail.suggestions)}?`
          : `${name} is not a register. The 64-bit registers are ${code('rax')}, ${code('rbx')}, ${code('rcx')}, ${code('rdx')}, ${code('rsi')}, ${code('rdi')}, ${code('rbp')}, ${code('rsp')} and ${code('r8')} to ${code('r15')}.`,
      )
    case 'rip':
      return error(
        'unknown-register',
        line,
        `${name} can't be an operand by itself. Use it only inside an address with a label, like ${code('message[rip]')}.`,
      )
    case 'eip':
      return error(
        'unknown-register',
        line,
        `${name} is not a register you can use. For the address of a label, write ${code('label[rip]')}.`,
      )
    case 'not-general':
      return error(
        'unknown-register',
        line,
        `${name} is a real register, but this emulator only has the 16 general registers, ${code('rax')} to ${code('r15')}.`,
      )
  }
}

export type UndefinedSymbolDetail =
  /** A name used as an operand or inside an address. `suggestion` is a close defined name. */
  | { use: 'operand'; name: string; suggestion: string | null }
  /** `jmp nowhere` */
  | { use: 'jump'; name: string; suggestion: string | null }
  /** `call nowhere` */
  | { use: 'call'; name: string; suggestion: string | null }
  /** `mov rax, printf`: a library function used as data */
  | { use: 'library'; name: string }
  /** `.` (the address of the current line), as in `len = . - msg` */
  | { use: 'here' }
  /** `call __stack_chk_fail@PLT`: gcc's stack protector */
  | { use: 'stack-protector'; name: string }

/** "`printf`, `scanf`, `puts`, `putchar` or `exit`" */
const LIBRARY_TEXT = orList(Object.keys(LIBRARY_FUNCTIONS))

export function undefinedSymbol(line: number, detail: UndefinedSymbolDetail): Diagnostic {
  if (detail.use === 'here') {
    return error(
      'undefined-symbol',
      line,
      `this emulator does not support ${code('.')} (the address of the current line). Write a number or a label instead.`,
    )
  }
  const name = code(detail.name)
  if (detail.use === 'library') {
    return error(
      'undefined-symbol',
      line,
      `${name} is a library function. You can only use it with ${code('call')}, like ${code(`call ${detail.name}@PLT`)}.`,
    )
  }
  if (detail.use === 'stack-protector') {
    return error(
      'undefined-symbol',
      line,
      `${name} is part of gcc's stack protector, and this emulator does not have it. Compile with ${code('-fno-stack-protector')} to leave it out.`,
    )
  }
  if (detail.suggestion !== null) {
    const what =
      detail.use === 'operand' ? `${name} is not defined` : `there is no label named ${name}`
    return error('undefined-symbol', line, `${what}. Did you mean ${code(detail.suggestion)}?`)
  }
  switch (detail.use) {
    case 'operand':
      return error(
        'undefined-symbol',
        line,
        `${name} is not defined. Add a label ${fix(`${detail.name}:`)} or a constant like ${fix(`.equ ${detail.name}, 8`)}.`,
      )
    case 'jump':
      return error(
        'undefined-symbol',
        line,
        `there is no label named ${name}. Put ${fix(`${detail.name}:`)} in front of the line the jump should go to.`,
      )
    case 'call':
      return error(
        'undefined-symbol',
        line,
        `there is no function named ${name}. Add a label ${fix(`${detail.name}:`)}, or call a library function this emulator knows: ${LIBRARY_TEXT}.`,
      )
  }
}

/**
 * A `.equ` constant that gcc does not know yet on the line that uses it, because its
 * own line (or the line of a constant its value uses) comes later. gcc reads a file
 * from top to bottom.
 */
export type ConstantTooLateDetail =
  /** The constant gets its value on a later line. */
  | { reason: 'later'; name: string; value: bigint; definedLine: number }
  /** The constant comes first, but its value uses `late`, which gets its value on a later line. */
  | {
      reason: 'depends'
      name: string
      value: bigint
      late: string
      lateLine: number
      /** The line of the constant that uses `late` (move `late` above this line). */
      userLine: number
    }

function constantTooLateStart(line: number, detail: ConstantTooLateDetail): [string, string] {
  if (detail.reason === 'later') {
    return [
      `${code(detail.name)} is used before line ${detail.definedLine}, where it gets its value.`,
      `Move line ${detail.definedLine} above line ${line}.`,
    ]
  }
  return [
    `${code(detail.name)} uses ${code(detail.late)}, and ${code(detail.late)} gets its value later, on line ${detail.lateLine}.`,
    `Move line ${detail.lateLine} above line ${detail.userLine}.`,
  ]
}

/**
 * A warning: a constant used as a number before gcc knows it. gcc then reads the name
 * as a memory address (and the real program would crash); this emulator uses the value.
 */
export function constantUsedTooEarly(line: number, detail: ConstantTooLateDetail): Diagnostic {
  const [what, fix] = constantTooLateStart(line, detail)
  return warning(
    'undefined-symbol',
    line,
    `${what} Here gcc reads ${code(detail.name)} as a memory address, not as the number ${detail.value}. ${fix}`,
  )
}

/** An error: a constant used as the scale of a register (`rbx*size`) before gcc knows it. */
export function scaleUsedTooEarly(line: number, detail: ConstantTooLateDetail): Diagnostic {
  const [what, fix] = constantTooLateStart(line, detail)
  return error(
    'undefined-symbol',
    line,
    `${what} gcc must know the value of ${code(detail.name)} here, so it refuses this line. ${fix}`,
  )
}

export type JumpTargetDetail =
  /** `jmp rax` */
  | { reason: 'register'; written: string }
  /** `jmp [rax]` */
  | { reason: 'memory'; written: string }
  /** `jmp 5`, or a jump to an `.equ` name */
  | { reason: 'number'; written: string }
  /** `jmp printf` */
  | { reason: 'library'; written: string; name: string }
  /** `jmp message` where message names data */
  | { reason: 'data'; written: string; name: string }
  /** Anything else that is not one label. */
  | { reason: 'other'; written: string }

export function jumpTarget(line: number, detail: JumpTargetDetail): Diagnostic {
  const name = code(detail.written)
  const isCall = detail.written === 'call'
  const example = isCall ? code('call printf@PLT') : code(`${detail.written} done`)
  const ownLabel = isCall ? code('call helper') : example
  switch (detail.reason) {
    case 'register':
    case 'memory':
      return error(
        'jump-target',
        line,
        `${name} needs a label, like ${example}. This emulator can't jump to an address held in a register or in memory.`,
      )
    case 'number':
      return error(
        'jump-target',
        line,
        `${name} needs a label, not a number. Put a label in front of the line you want, then use that label, like ${ownLabel}.`,
      )
    case 'library':
      return error(
        'jump-target',
        line,
        `${code(detail.name)} is a library function. Run it with ${code(`call ${detail.name}@PLT`)}, not with ${name}.`,
      )
    case 'data':
      return error(
        'jump-target',
        line,
        `${code(detail.name)} is a label for data, not for code. ${name} needs a label that is in front of an instruction.`,
      )
    case 'other':
      return error('jump-target', line, `${name} needs one label, like ${example}.`)
  }
}

/* ─────────────────────── Rules of each instruction ─────────────────────── */

export function memoryToMemory(line: number, detail: { written: string }): Diagnostic {
  // The wording for `mov` is fixed by the product brief.
  const text =
    detail.written === 'mov'
      ? `you can't move memory into memory. Load it into a register first.`
      : `${code(detail.written)} can't use two memory operands (two parts in brackets). Copy one of them into a register first.`
  return error('memory-to-memory', line, text)
}

export type ImmediateDestinationDetail =
  /** `mov 5, rax`: `example` is the same line the right way round */
  | { reason: 'destination'; example: string }
  /** `cmp 5, rax` */
  | { reason: 'first'; written: string; example: string }
  /** `inc 5` */
  | { reason: 'single'; written: string }
  /** `imul 5, rax`, `movzx 5, al`: the destination must be a register */
  | { reason: 'register'; written: string; example: string }

export function immediateDestination(line: number, detail: ImmediateDestinationDetail): Diagnostic {
  switch (detail.reason) {
    case 'destination':
      return error(
        'immediate-destination',
        line,
        `a number can't be the destination. Put the register or memory first: ${code(detail.example)}.`,
      )
    case 'first':
      return error(
        'immediate-destination',
        line,
        `a number can't be the first operand of ${code(detail.written)}. Put the register or memory first: ${code(detail.example)}.`,
      )
    case 'single':
      return error(
        'immediate-destination',
        line,
        `${code(detail.written)} can't change a number. Give it a register or memory, like ${code(`${detail.written} rax`)}.`,
      )
    case 'register':
      return error(
        'immediate-destination',
        line,
        `a number can't be the destination of ${code(detail.written)}. Put a register first, like ${code(detail.example)}.`,
      )
  }
}

export type SizeMismatchDetail =
  /** Two operands of different widths: `mov eax, bx`, `mov eax, qword ptr [rbp-8]` */
  | { reason: 'different'; written: string; first: SizedText; second: SizedText }
  /** `movzx eax, ebx`: the source must be smaller. `example` is a line that works. */
  | {
      reason: 'not-smaller'
      written: string
      destination: SizedText
      source: SizedText
      example: string
    }

/**
 * The last sentences of a size message for `mov` when a smaller value goes into a bigger
 * register: what to write instead. Every line the student gets by following it must
 * assemble:
 * - x86-64 has no `movzx` from 32 bits, because writing the 32-bit name already sets the
 *   top 32 bits to 0 (and `movsxd` keeps the sign);
 * - `ah`, `bh`, `ch` and `dh` can't go into a 64-bit register, even with `movzx`.
 * A memory destination gets no hint: `movzx` and `movsx` write only registers.
 * The hint stays short: practice problems show the whole message as one line.
 */
function widenHint(destination: SizedText, source: SizedText): string | null {
  if (destination.size <= source.size) return null
  const register = lookupRegister(destination.text)
  if (register === undefined) return null
  const low = subRegister(register.base, 32).name
  const topHalf = `writing ${code(low)} also sets the top 32 bits of ${code(register.base)} to 0`
  if (source.size === 32) {
    // When the address also uses the register (`[rax]`), "instead of `rax`" could be read
    // as "change both", and `[eax]` is not an address: then show the whole line.
    const inAddress = new RegExp(`\\b${register.base}\\b`, 'i').test(source.text)
    const change = inAddress
      ? `Write ${fix(`mov ${low}, ${source.text}`)}`
      : `Use ${code(low)} instead of ${code(register.base)}`
    return `${change}: ${topHalf}. To keep the sign, use ${code('movsxd')}.`
  }
  if (destination.size === 64 && lookupRegister(source.text)?.highByte === true) {
    return `Write ${fix(`movzx ${low}, ${source.text}`)}: ${topHalf}.`
  }
  return `To copy a smaller value into a bigger register, use ${code('movzx')} or ${code('movsx')}.`
}

export function sizeMismatch(line: number, detail: SizeMismatchDetail): Diagnostic {
  switch (detail.reason) {
    case 'different': {
      const { first, second, written } = detail
      const sizes = `${code(first.text)} is ${first.size} bits but ${code(second.text)} is ${second.size} bits. Both sides of ${code(written)} must be the same size.`
      // Copying a smaller value into a bigger register has its own instructions.
      const hint = written === 'mov' ? widenHint(first, second) : null
      return error('size-mismatch', line, hint === null ? sizes : `${sizes} ${hint}`)
    }
    case 'not-smaller':
      return error(
        'size-mismatch',
        line,
        `${code(detail.written)} copies a smaller value into a bigger register. ${code(detail.source.text)} (${detail.source.size} bits) is not smaller than ${code(detail.destination.text)} (${detail.destination.size} bits), so write ${code(detail.example)}.`,
      )
  }
}

export function missingSize(
  line: number,
  detail: {
    /** The memory operand as written, e.g. `[rbp-8]`. */
    memory: string
    /** What the instruction does with the memory. */
    action: 'write' | 'change' | 'compare' | 'read'
    /** The same line with a size added, e.g. `mov dword ptr [rbp-8], 5`. */
    example: string
  },
): Diagnostic {
  const what = {
    write: 'write to',
    change: 'change at',
    compare: 'compare at',
    read: 'read from',
  }[detail.action]
  const sizes =
    detail.action === 'read'
      ? `${code('byte ptr')} (1 byte) or ${code('word ptr')} (2 bytes)`
      : SIZE_WORDS_TEXT
  // gcc can't tell either: the size is simply not written anywhere on the line.
  return error(
    'missing-size',
    line,
    `this line does not say how many bytes to ${what} ${code(detail.memory)}. Add ${sizes} in front, like ${code(detail.example)}.`,
  )
}

/** A number as the student wrote it, and what it is worth. */
export interface ImmediateText {
  text: string
  value: bigint
  /** 'number' for `256`; 'constant' for an `.equ` name; 'address' for `offset label`. */
  kind: 'number' | 'constant' | 'address'
}

function immediateSubject(imm: ImmediateText): string {
  if (imm.kind === 'constant') return `${code(imm.text)} is ${imm.value}. It`
  if (imm.kind === 'address') return `${code(imm.text)} is the address ${signedHex(imm.value)}. It`
  return code(imm.text)
}

export type ImmediateTooLargeDetail =
  /** `mov al, 256`: a destination of 8, 16 or 32 bits */
  | { reason: 'destination'; immediate: ImmediateText; destination: SizedText }
  /** `add rax, 0x100000000`: 64-bit destination, but the number may only use 32 bits */
  | { reason: 'signed-32'; immediate: ImmediateText; written: string }
  /** `mov rax, 99999999999999999999`: more than 64 bits */
  | { reason: 'over-64'; immediate: ImmediateText }
  /** `.byte 300` */
  | { reason: 'data'; text: string; directive: string; size: OperandSize }

export function immediateTooLarge(line: number, detail: ImmediateTooLargeDetail): Diagnostic {
  switch (detail.reason) {
    case 'destination': {
      const dest = detail.destination
      return error(
        'immediate-too-large',
        line,
        `${immediateSubject(detail.immediate)} does not fit in ${code(dest.text)}. ${code(dest.text)} holds ${dest.size} bits, so the number must be between ${rangeOf(dest.size)}.`,
      )
    }
    case 'signed-32':
      return error(
        'immediate-too-large',
        line,
        detail.written === 'mov'
          ? `${immediateSubject(detail.immediate)} is too big to copy into 64-bit memory in one step. Copy it into a register first, then copy the register into memory.`
          : `${immediateSubject(detail.immediate)} is too big for ${code(detail.written)}. Here the number must be between -2147483648 and 2147483647. Copy it into a register first with ${code('mov')}.`,
      )
    case 'over-64':
      return error(
        'immediate-too-large',
        line,
        `${immediateSubject(detail.immediate)} does not fit in 64 bits. A register can't hold a number this big.`,
      )
    case 'data':
      return error(
        'immediate-too-large',
        line,
        `${code(detail.text)} does not fit in ${code(detail.directive)}. Each ${code(detail.directive)} value holds ${detail.size} bits, so it must be between ${rangeOf(detail.size)}.`,
      )
  }
}

export type PushPopOperandDetail =
  /** `push eax`. `wide` is the 64-bit register of the same family (`rax`). */
  | { reason: 'small-register'; written: 'push' | 'pop'; register: SizedText; wide: string }
  /**
   * `push [rax]`, `pop [rax]`. `memory` is the operand as written, `scratch` a 64-bit
   * register the memory operand does not use (for the example).
   */
  | { reason: 'memory'; written: 'push' | 'pop'; memory: string; scratch: string }
  /** `pop 5` */
  | { reason: 'number'; written: 'pop' }
  /** `push 0x100000000` */
  | { reason: 'too-large'; written: 'push'; text: string }

export function pushPopOperand(line: number, detail: PushPopOperandDetail): Diagnostic {
  const needs =
    detail.written === 'push'
      ? `${code('push')} needs a 64-bit register (like ${code('rax')}) or a number.`
      : `${code('pop')} needs a 64-bit register, like ${code('rax')}.`
  switch (detail.reason) {
    case 'small-register': {
      const { register, written, wide } = detail
      // x86-64 can push and pop 16-bit registers; this emulator cannot.
      if (register.size === 16) {
        return error(
          'push-pop-operand',
          line,
          `${code(`${written} ${register.text}`)} is a real x86 instruction, but this emulator only uses 64-bit registers with ${code(written)}. Write ${code(`${written} ${wide}`)}.`,
        )
      }
      return error(
        'push-pop-operand',
        line,
        `${needs} ${code(register.text)} is only ${register.size} bits.`,
      )
    }
    case 'memory': {
      const { memory, scratch } = detail
      return error(
        'push-pop-operand',
        line,
        detail.written === 'push'
          ? `this emulator can't push memory. Copy it into a register first: ${code(`mov ${scratch}, ${memory}`)}, then ${code(`push ${scratch}`)}.`
          : `this emulator can't pop into memory. Pop into a register first: ${code(`pop ${scratch}`)}, then ${code(`mov ${memory}, ${scratch}`)}.`,
      )
    }
    case 'number':
      return error('push-pop-operand', line, `${needs} A number can't take the popped value.`)
    case 'too-large':
      return error(
        'push-pop-operand',
        line,
        `${code('push')} can only take a number between -2147483648 and 2147483647, and ${code(detail.text)} is not. Copy it into a register first: ${code(`mov rax, ${detail.text}`)}, then ${code('push rax')}.`,
      )
  }
}

export type InvalidOperandsDetail =
  /** `imul rbx` or `imul rax, rbx, 5` */
  | { reason: 'imul-form'; found: number }
  /** `imul al, bl`, `imul [rax], rbx` */
  | { reason: 'imul-destination' }
  /** `lea rax, rbx` and every other wrong `lea` */
  | { reason: 'lea' }
  /** `movzx eax, 5`, `movzx [rax], al` */
  | { reason: 'extend'; written: string }
  /** `movzx rax, ebx`: `example` is the plain `mov` that does the job */
  | { reason: 'extend-32'; written: string; example: string }
  /** A shape no rule allows. */
  | { reason: 'other'; written: string; mnemonic: Mnemonic }

export function invalidOperands(line: number, detail: InvalidOperandsDetail): Diagnostic {
  switch (detail.reason) {
    case 'imul-form':
      return error(
        'invalid-operands',
        line,
        `this emulator supports only the 2-operand form of ${code('imul')}, like ${code('imul rax, rbx')}. This line has ${detail.found}.`,
      )
    case 'imul-destination':
      return error(
        'invalid-operands',
        line,
        `the destination of ${code('imul')} must be a register of 16, 32 or 64 bits, like ${code('imul eax, ebx')}.`,
      )
    case 'lea':
      return error(
        'invalid-operands',
        line,
        `${code('lea')} needs a register of 16, 32 or 64 bits, then a memory operand, like ${code('lea rax, [rbp-8]')}.`,
      )
    case 'extend':
      return error(
        'invalid-operands',
        line,
        `${code(detail.written)} needs a register, then a smaller register or memory, like ${code(`${detail.written} eax, al`)}.`,
      )
    case 'extend-32':
      return error(
        'invalid-operands',
        line,
        `${code(detail.written)} can't take a 32-bit source. Writing a 32-bit register already clears the upper half, so use ${code(detail.example)}.`,
      )
    case 'other': {
      const shape = shapeOf(detail.mnemonic)
      const form = shape === '' ? detail.written : `${detail.written} ${shape}`
      return error(
        'invalid-operands',
        line,
        `${code(detail.written)} can't use these operands. It is written as ${code(form)}.`,
      )
    }
  }
}

export type HighByteRexDetail =
  /** `mov ah, r8b`: `other` is the register that can't share an instruction with it */
  | { reason: 'register'; high: string; other: string }
  /** `movzx rax, ah`: `example` is a 32-bit form that does the same job, when there is one */
  | { reason: 'wide'; high: string; example: string | null }

export function highByteRex(line: number, detail: HighByteRexDetail): Diagnostic {
  switch (detail.reason) {
    case 'register':
      return error(
        'high-byte-rex',
        line,
        `${code(detail.high)} and ${code(detail.other)} can't be in the same instruction. x86-64 machine code has no way to write that. Use a different register for one of them.`,
      )
    case 'wide':
      return error(
        'high-byte-rex',
        line,
        detail.example !== null
          ? `${code(detail.high)} can't be used with a 64-bit register. x86-64 machine code has no way to write that. Write ${code(detail.example)} instead.`
          : `${code(detail.high)} can't be used with a 64-bit register. x86-64 machine code has no way to write that. Copy ${code(detail.high)} into a different 8-bit register first, like ${code('cl')}.`,
      )
  }
}

/* ───────────────────────── Directives and layout ───────────────────────── */

export type BadDirectiveDetail =
  /** `.equ count` */
  | { reason: 'equ-shape'; written: string }
  /** `.equ rax, 5`, `.equ byte, 1` */
  | { reason: 'equ-name'; name: string; why: 'register' | 'size' }
  /** `rax = 5` */
  | { reason: 'assign-register'; name: string; value: string }
  /** `.equ a, main`, `.zero rax`: a label or a register where a number must be */
  | { reason: 'not-a-number'; written: string; name: string; what: 'label' | 'register' }
  /** `.equ a, a+1` */
  | { reason: 'equ-cycle'; name: string }
  /** A very long chain of constants, each defined with the next one */
  | { reason: 'equ-too-deep'; name: string }
  /** `.string` with no text, or with something that is not text */
  | { reason: 'string'; written: string }
  /** `.quad` with no values, or text where a number should be */
  | { reason: 'values'; written: string }
  /** `.quad 5 +` */
  | { reason: 'value-syntax'; written: string; text: string }
  /** `.zero` with no count, or with two */
  | { reason: 'count'; written: string }
  /** `.zero -4` */
  | { reason: 'count-negative'; written: string; text: string }
  /** `.zero 99999999999` */
  | { reason: 'count-too-big'; written: string; limit: number }
  /** Many big `.zero` lines: more zero bytes in all than the emulator allows */
  | { reason: 'total-too-big'; limit: number }
  /** `.globl` with no name */
  | { reason: 'name'; written: string }
  /** `.section` with no name */
  | { reason: 'section' }
  /** `.intel_syntax` without `noprefix` */
  | { reason: 'intel-syntax' }

export function badDirective(line: number, detail: BadDirectiveDetail): Diagnostic {
  switch (detail.reason) {
    case 'equ-shape': {
      const example = detail.written === '=' ? 'count = 8' : `${detail.written} count, 8`
      return error(
        'bad-directive',
        line,
        `${code(detail.written)} needs a name and a value, like ${code(example)}.`,
      )
    }
    case 'equ-name': {
      const why =
        detail.why === 'register'
          ? 'is a register name'
          : `is a size word, as in ${code(`${detail.name.toLowerCase()} ptr`)}`
      return error(
        'bad-directive',
        line,
        `${code(detail.name)} ${why}, so it can't be the name of a constant. Choose a different name, like ${code('count')}.`,
      )
    }
    case 'assign-register':
      return error(
        'bad-directive',
        line,
        `${code(`${detail.name} = ${detail.value}`)} does not put a number in a register. Write ${code(`mov ${detail.name}, ${detail.value}`)}.`,
      )
    case 'not-a-number':
      return error(
        'bad-directive',
        line,
        `${code(detail.name)} is a ${detail.what}, not a number. ${code(detail.written)} needs a number here.`,
      )
    case 'equ-cycle':
      return error(
        'bad-directive',
        line,
        `the constant ${code(detail.name)} is defined using itself. Give it a number, like ${fix(`.equ ${detail.name}, 8`)}.`,
      )
    case 'equ-too-deep':
      return error(
        'bad-directive',
        line,
        `the constant ${code(detail.name)} is defined through too many other constants. Give it a number, like ${fix(`.equ ${detail.name}, 8`)}.`,
      )
    case 'string':
      return error(
        'bad-directive',
        line,
        `${code(detail.written)} needs text in double quotes, like ${code(`${detail.written} "Hello"`)}.`,
      )
    case 'values':
      return error(
        'bad-directive',
        line,
        `${code(detail.written)} needs one or more numbers with commas between them, like ${code(`${detail.written} 1, 2, 3`)}.`,
      )
    case 'value-syntax':
      return error(
        'bad-directive',
        line,
        `this emulator can't read ${code(detail.text)} after ${code(detail.written)}. Write numbers with commas between them, like ${code(`${detail.written} 1, 2, 3`)}.`,
      )
    case 'count':
      return error(
        'bad-directive',
        line,
        `${code(detail.written)} needs one number: how many zero bytes to make, like ${code(`${detail.written} 16`)}.`,
      )
    case 'count-negative':
      return error(
        'bad-directive',
        line,
        `${code(detail.written)} can't make ${code(detail.text)} bytes. Use a number that is 0 or more, like ${code(`${detail.written} 16`)}.`,
      )
    case 'count-too-big':
      return error(
        'bad-directive',
        line,
        `${code(detail.written)} can make at most ${detail.limit} bytes in this emulator. Use a smaller number.`,
      )
    case 'total-too-big':
      return error(
        'bad-directive',
        line,
        `this program asks for too many zero bytes. This emulator allows ${detail.limit} in all. Use smaller numbers.`,
      )
    case 'name':
      return error(
        'bad-directive',
        line,
        `${code(detail.written)} needs a name, like ${code(`${detail.written} main`)}.`,
      )
    case 'section':
      return error(
        'bad-directive',
        line,
        `${code('.section')} needs the name of a section, like ${code('.section .rodata')}.`,
      )
    case 'intel-syntax':
      return error(
        'bad-directive',
        line,
        `write this line as ${code('.intel_syntax noprefix')}. The word ${code('noprefix')} lets you write ${code('rax')} with no ${code('%')}.`,
      )
  }
}

export function wrongSection(line: number, detail: { section: string }): Diagnostic {
  return error(
    'wrong-section',
    line,
    `this instruction is inside ${code(detail.section)}. Put code after ${code('.text')}.`,
  )
}

export function emptyProgram(): Diagnostic {
  return error(
    'empty-program',
    0,
    `This program has no instructions. Write at least one, like ${code('mov rax, 5')}.`,
  )
}

/** The last-resort message when the assembler itself fails (a bug in the emulator). */
export function internalProblem(): Diagnostic {
  return error(
    'bad-operand',
    0,
    'The emulator hit an internal problem while reading this program. This is a mistake in the emulator, not in your program.',
  )
}

/* ─────────────────────────────── Warnings ─────────────────────────────── */

export type UnknownDirectiveDetail =
  /** `.foo`, or `.sting` with `suggestions` = [`.string`] */
  | { reason: 'directive'; name: string; suggestions: readonly string[] }
  /** `.section .weird`: treated as read-only data. `suggestion` is e.g. `.data` for `data`. */
  | { reason: 'section'; name: string; suggestion: string | null }
  /** `.att_syntax` */
  | { reason: 'att-syntax'; name: string }

export function unknownDirective(line: number, detail: UnknownDirectiveDetail): Diagnostic {
  const name = code(detail.name)
  switch (detail.reason) {
    case 'directive': {
      // "Directive" is explained here: the word students meet when they mistype one.
      const skipped = `${name} is not a directive this emulator knows, so it skipped this line. A directive is a word that starts with a dot, like ${code('.text')}.`
      return warning(
        'unknown-directive',
        line,
        detail.suggestions.length > 0
          ? `${skipped} Did you mean ${orList(detail.suggestions)}?`
          : skipped,
      )
    }
    case 'section':
      return warning(
        'unknown-directive',
        line,
        detail.suggestion !== null
          ? `${name} is not a section this emulator knows, so it treats it as read-only data. Did you mean ${code(detail.suggestion)}?`
          : `${name} is not a section this emulator knows, so it treats it as read-only data.`,
      )
    case 'att-syntax':
      return warning(
        'unknown-directive',
        line,
        `${name} switches to AT&T syntax. This emulator uses Intel syntax, so it skipped this line.`,
      )
  }
}

/**
 * A warning: `.comm` or `.lcomm`, which gcc writes for a variable that starts at 0. This
 * emulator does not support them, so the variable does not exist. `fix` is the line to
 * write after `.data` instead, like `buf: .zero 16`.
 */
export function commonSymbol(line: number, detail: { written: string; fix: string }): Diagnostic {
  return warning(
    'unknown-directive',
    line,
    `this emulator does not support ${code(detail.written)}, so it skipped this line. Put the variable after ${code('.data')} instead, like ${fix(detail.fix)}.`,
  )
}

/**
 * A warning on the line of `main:` when no instruction comes after it: the program starts
 * there and has nothing to run.
 */
export function emptyMain(line: number): Diagnostic {
  return warning(
    'no-main',
    line,
    `the label ${code('main:')} has no instruction after it, so the program has nothing to run. Put the instructions of the program after ${code('main:')}.`,
  )
}

/**
 * The note after the first 20 errors: more errors follow. `lastLine` is the line of the
 * last error shown. A warning about the whole program, so the errors stay at most 20.
 */
export function moreErrors(lastLine: number): Diagnostic {
  return warning('more-errors', 0, `There are more errors after line ${lastLine}. Fix these first.`)
}

export function missingIntelSyntax(): Diagnostic {
  return warning(
    'missing-intel-syntax',
    0,
    `The line ${code('.intel_syntax noprefix')} is missing. This emulator works without it, but gcc needs it: put it at the top of the program.`,
  )
}

/**
 * No `main` the program can start at. `dataLine` is set when `main:` names data
 * instead of an instruction.
 */
export function noMain(detail: { dataLine: number | null } = { dataLine: null }): Diagnostic {
  return warning(
    'no-main',
    0,
    detail.dataLine === null
      ? `There is no ${code('main:')} label, so the program starts at its first instruction. gcc needs a ${code('main:')} label and the line ${code('.globl main')}. Put ${code('main:')} in front of the first instruction.`
      : `The label ${code('main:')} on line ${detail.dataLine} names data, not an instruction, so the program starts at its first instruction. Put ${code('main:')} in front of an instruction.`,
  )
}

// ── Run-time messages ──
// (Milestone 2: messages for problems that happen while the program runs go here.)
