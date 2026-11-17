/**
 * The parser: tokens → statements, and the operands of an instruction → `Operand`s.
 *
 * It works in two steps, because a name may be used before the line that defines it:
 *
 *   1. `parseLine` reads one line without knowing any names. It finds the labels and
 *      the statement (a directive with its arguments, or an instruction with its
 *      operands still as raw tokens) and reports mistakes that need no names:
 *      a misspelled instruction, AT&T syntax, a bad number, a wrong operand count.
 *   2. `resolveOperands` turns the raw operands into `Operand` objects once the
 *      assembler knows every `.equ` constant and label (it passes them in a
 *      `SymbolEnv`).
 *
 * A mistake in the student's program is thrown as an `AsmError` inside this file and
 * caught once per line: `parseLine` and `resolveOperands` never throw for bad input.
 * The smaller pieces (`parseExpression`, `parseOperand`, `parseTarget`) do throw
 * `AsmError`; the assembler uses them only through code that catches it.
 */
import * as say from './errors'
import {
  isInvisible,
  lexLine,
  type EscapeProblem,
  type ProblemToken,
  type Punctuation,
  type Token,
} from './lexer'
import { ALL_REGISTER_NAMES, lookupRegister } from './registers'
import {
  LIBRARY_FUNCTIONS,
  MNEMONICS,
  type Diagnostic,
  type ImmOperand,
  type LibraryFunctionName,
  type MemOperand,
  type Mnemonic,
  type Operand,
  type OperandSize,
  type Reg64,
  type RegisterInfo,
  type SectionName,
  type TargetOperand,
} from './types'
import { expectedOperandCount, isBranch, operandCountProblem } from './validate'

/* ─────────────────────────────── Errors ─────────────────────────────── */

/** A mistake in the student's program. Thrown inside the parser, caught once per line. */
export class AsmError extends Error {
  readonly diagnostic: Diagnostic

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message)
    this.name = 'AsmError'
    this.diagnostic = diagnostic
  }
}

/**
 * Characters that have no picture: control characters and broken surrogate pairs.
 * (Zero-width spaces and the like never get here: the lexer reads past them.)
 */
function isHiddenCharacter(point: number): boolean {
  return point < 0x20 || (point >= 0x7f && point < 0xa0) || (point >= 0xd800 && point <= 0xdfff)
}

/** A bad escape in quoted text or in a character literal. */
function escapeProblem(line: number, reason: EscapeProblem, escape: string): Diagnostic {
  switch (reason) {
    case 'escape':
      return say.badString(line, { reason: 'escape', escape })
    case 'octal-range':
      return say.badString(line, { reason: 'octal-range', escape })
    case 'hex-digits':
      return say.badString(line, { reason: 'hex-digits' })
  }
}

/** A word that starts with a digit but is not a number. */
function numberProblem(
  line: number,
  text: string,
  reason: 'leading-zero' | 'hex-suffix' | 'hex' | 'binary' | 'other',
): Diagnostic {
  switch (reason) {
    case 'leading-zero':
      // `010` → `10`, `08` → `8`, `00` → `0`
      return say.badNumber(line, { reason, text, fixed: text.replace(/^0+(?=\d)/, '') })
    case 'hex-suffix':
      // `1Fh` → `0x1F`, `0FFh` → `0xFF`
      return say.badNumber(line, {
        reason,
        text,
        fixed: `0x${text.slice(0, -1).replace(/^0+(?=.)/, '')}`,
      })
    case 'hex':
    case 'binary':
    case 'other':
      return say.badNumber(line, { reason, text })
  }
}

/** A character literal that is not exactly one character in single quotes. */
function characterProblem(
  line: number,
  text: string,
  reason: 'empty' | 'too-long' | 'unclosed' | EscapeProblem,
  escape: string,
): Diagnostic {
  switch (reason) {
    case 'empty':
      return say.badNumber(line, { reason: 'empty-character' })
    case 'too-long':
      return say.badNumber(line, { reason: 'long-character', text })
    case 'unclosed':
      return say.badString(line, { reason: 'unclosed-character', text })
    default:
      return escapeProblem(line, reason, escape)
  }
}

/**
 * The message for a piece of the line the lexer could not read. `fixedLine` is the
 * whole line with every look-alike character replaced (for the look-alike message).
 */
function problemDiagnostic(
  line: number,
  token: ProblemToken,
  fixedLine: string | null = null,
): Diagnostic {
  const text = token.text
  const problem = token.problem
  switch (problem.type) {
    case 'att-register':
      return say.attSyntax(line, { reason: 'register', text })
    case 'att-immediate':
      return say.attSyntax(line, { reason: 'immediate', text })
    case 'number':
      return numberProblem(line, text, problem.reason)
    case 'character':
      return characterProblem(line, text, problem.reason, problem.escape)
    case 'string':
      return problem.reason === 'unclosed'
        ? say.badString(line, { reason: 'unclosed' })
        : escapeProblem(line, problem.reason, problem.escape)
    case 'look-alike':
      return say.lookAlike(line, {
        char: problem.char,
        plain: problem.plain,
        fixed: fixedLine ?? problem.fixed,
      })
    case 'stray': {
      const point = text.codePointAt(0) ?? 0
      return isHiddenCharacter(point)
        ? say.badOperand(line, { reason: 'hidden-character', codePoint: point })
        : say.badOperand(line, { reason: 'character', text })
    }
  }
}

/* ───────────────────────── Words the parser knows ───────────────────────── */

/** Other spellings of the canonical mnemonics. */
const ALIASES: ReadonlyMap<string, Mnemonic> = new Map<string, Mnemonic>([
  ['jz', 'je'],
  ['jnz', 'jne'],
  ['jnle', 'jg'],
  ['jnl', 'jge'],
  ['jnge', 'jl'],
  ['jng', 'jle'],
  ['jnbe', 'ja'],
  ['jnb', 'jae'],
  ['jnc', 'jae'],
  ['jnae', 'jb'],
  ['jc', 'jb'],
  ['jna', 'jbe'],
  ['movsxd', 'movsx'],
  ['endbr64', 'nop'],
])

const CANONICAL: ReadonlyMap<string, Mnemonic> = new Map<string, Mnemonic>(
  MNEMONICS.map((name) => [name, name]),
)

/** Every spelling the emulator accepts, in teaching order (used for "did you mean"). */
const SUPPORTED_SPELLINGS: readonly string[] = [...MNEMONICS, ...ALIASES.keys()]

/** The canonical mnemonic for a spelling in any letter case, or undefined. */
export function canonicalMnemonic(written: string): Mnemonic | undefined {
  const lower = written.toLowerCase()
  return CANONICAL.get(lower) ?? ALIASES.get(lower)
}

const CONDITIONS = [
  'e',
  'ne',
  'z',
  'nz',
  'g',
  'ge',
  'l',
  'le',
  'a',
  'ae',
  'b',
  'be',
  's',
  'ns',
  'o',
  'no',
  'c',
  'nc',
  'p',
  'np',
  'pe',
  'po',
  'nle',
  'nl',
  'nge',
  'ng',
  'nbe',
  'nb',
  'nae',
  'na',
]

/** Real x86-64 instructions that are outside the teaching subset. */
const UNSUPPORTED: ReadonlySet<string> = new Set([
  // arithmetic and bits
  ...['mul', 'div', 'idiv', 'neg', 'not', 'shl', 'shr', 'sal', 'sar', 'rol', 'ror', 'rcl', 'rcr'],
  ...['adc', 'sbb', 'xchg', 'xadd', 'cmpxchg', 'bswap', 'bt', 'bts', 'btr', 'btc', 'bsf', 'bsr'],
  ...['popcnt', 'lzcnt', 'tzcnt', 'shld', 'shrd', 'andn'],
  // widening
  ...['cdq', 'cqo', 'cdqe', 'cwde', 'cbw', 'cwd', 'cltq', 'cqto', 'cltd', 'cwtl', 'cwtd', 'cbtw'],
  // control
  ...['movabs', 'syscall', 'sysenter', 'sysret', 'int', 'int3', 'into', 'iret', 'iretq', 'enter'],
  ...['loop', 'loope', 'loopne', 'loopz', 'loopnz', 'jcxz', 'jecxz', 'jrcxz', 'hlt', 'ud2'],
  ...['pause', 'cpuid', 'rdtsc', 'rdrand', 'lock', 'wait', 'fwait', 'jp', 'jnp', 'jpe', 'jpo'],
  ...CONDITIONS.map((cc) => `cmov${cc}`),
  ...CONDITIONS.map((cc) => `set${cc}`),
  // strings
  ...['movs', 'movsb', 'movsw', 'movsq', 'stos', 'stosb', 'stosw', 'stosd', 'stosq'],
  ...['lods', 'lodsb', 'lodsw', 'lodsd', 'lodsq', 'scas', 'scasb', 'scasw', 'scasd', 'scasq'],
  ...['cmps', 'cmpsb', 'cmpsw', 'cmpsq', 'rep', 'repe', 'repz', 'repne', 'repnz', 'xlat', 'xlatb'],
  // flags and ports
  ...['cld', 'std', 'clc', 'stc', 'cmc', 'cli', 'sti', 'lahf', 'sahf', 'pushf', 'pushfq', 'popf'],
  ...['popfq', 'pusha', 'popa', 'in', 'out', 'ins', 'outs'],
  // floating point
  ...['movss', 'movsd', 'movaps', 'movups', 'movapd', 'movupd', 'movdqa', 'movdqu', 'movd'],
  ...['addss', 'addsd', 'subss', 'subsd', 'mulss', 'mulsd', 'divss', 'divsd', 'sqrtss', 'sqrtsd'],
  ...['cvtsi2sd', 'cvtsi2ss', 'cvttsd2si', 'cvttss2si', 'cvtss2sd', 'cvtsd2ss', 'pxor', 'xorps'],
  ...['xorpd', 'ucomiss', 'ucomisd', 'comiss', 'comisd', 'cmpsd', 'fld', 'fstp', 'fild', 'fistp'],
  ...['fadd', 'fsub', 'fmul', 'fdiv'],
])

const ATT_SUFFIXES = ['b', 'w', 'l', 'q']

/** AT&T spellings with a size letter (`movq`) → the Intel spelling to use instead. */
const ATT_MNEMONICS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  const bases = ['mov', 'add', 'sub', 'cmp', 'and', 'or', 'xor', 'test', 'inc', 'dec', 'imul']
  bases.push('lea', 'push', 'pop', 'call', 'ret', 'jmp', 'leave', 'nop')
  for (const base of bases) {
    for (const suffix of ATT_SUFFIXES) {
      const name = base + suffix
      if (canonicalMnemonic(name) === undefined && !UNSUPPORTED.has(name)) map.set(name, base)
    }
  }
  for (const name of ['movzbl', 'movzbw', 'movzbq', 'movzwl', 'movzwq']) map.set(name, 'movzx')
  for (const name of ['movsbl', 'movsbw', 'movsbq', 'movswl', 'movswq']) map.set(name, 'movsx')
  // From 32 bits, `movsxd` is the spelling that both gcc and clang accept.
  map.set('movslq', 'movsxd')
  map.set('movabsq', 'mov')
  return map
})()

/** AT&T spellings of unsupported instructions (`shlq`) → the Intel name (`shl`). */
const ATT_UNSUPPORTED: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  const bases = ['mul', 'div', 'idiv', 'neg', 'not', 'shl', 'shr', 'sal', 'sar', 'rol', 'ror']
  bases.push('adc', 'sbb', 'xchg')
  for (const base of bases) {
    for (const suffix of ATT_SUFFIXES) {
      const name = base + suffix
      if (!UNSUPPORTED.has(name) && !ATT_MNEMONICS.has(name)) map.set(name, base)
    }
  }
  return map
})()

/** NASM words at the start of a line → what gcc assembly wants instead. */
const NASM_WORDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['section', ['.text', '.data']],
  ['segment', ['.text', '.data']],
  ['global', ['.globl main']],
  ['extern', []],
  ['db', ['.byte', '.string']],
  ['dw', ['.word']],
  ['dd', ['.long']],
  ['dq', ['.quad']],
  ['resb', ['.zero']],
  ['resw', ['.zero']],
  ['resd', ['.zero']],
  ['resq', ['.zero']],
  ['equ', ['.equ name, value']],
])

/** NASM words that come second on a line: `msg db "hi"`, `count equ 5`, `buf resb 8`. */
const NASM_SECOND_WORDS: ReadonlySet<string> = new Set([
  ...['db', 'dw', 'dd', 'dq', 'equ'],
  ...['resb', 'resw', 'resd', 'resq'],
])

/** NASM's words that reserve room (`buf resq 4`), and how many bytes each unit has. */
const NASM_RESERVE: ReadonlyMap<string, number> = new Map([
  ['resb', 1],
  ['resw', 2],
  ['resd', 4],
  ['resq', 8],
])

const SIZE_WORDS: ReadonlyMap<string, OperandSize> = new Map<string, OperandSize>([
  ['byte', 8],
  ['word', 16],
  ['dword', 32],
  ['qword', 64],
])

/**
 * Words with a meaning inside an operand. Of these, only the size words can't be the
 * name of a label or a constant. `ptr`, `offset` and `flat` are keywords only where
 * they are used as keywords (`dword ptr`, `offset msg`, `flat:`), so a student may call
 * a variable `ptr` or `offset`.
 */
const KEYWORDS: ReadonlySet<string> = new Set([...SIZE_WORDS.keys(), 'ptr', 'offset', 'flat'])

const SEGMENT_REGISTERS: ReadonlySet<string> = new Set(['cs', 'ds', 'es', 'fs', 'gs', 'ss'])

/** Directives that gcc writes and the emulator does not need. */
const IGNORED_DIRECTIVES: ReadonlySet<string> = new Set([
  '.file',
  '.ident',
  '.size',
  '.align',
  '.p2align',
  '.balign',
  '.loc',
  '.weak',
  '.local',
  '.addrsig',
  '.addrsig_sym',
])

/**
 * `.comm name, size` and `.lcomm name, size` make a variable that starts at 0. This
 * emulator does not support them. They are not skipped quietly: the variable they make
 * matters, so the student gets a warning that says what to write instead.
 */
const COMMON_SYMBOL_DIRECTIVES: ReadonlySet<string> = new Set(['.comm', '.lcomm'])

const VALUE_DIRECTIVES: ReadonlyMap<string, 1 | 2 | 4 | 8> = new Map<string, 1 | 2 | 4 | 8>([
  ['.quad', 8],
  ['.long', 4],
  ['.int', 4],
  ['.word', 2],
  ['.short', 2],
  ['.byte', 1],
])

/** Every directive with a meaning here, without its dot (for the "missing dot" hint). */
const DIRECTIVE_WORDS: ReadonlySet<string> = new Set([
  ...['intel_syntax', 'text', 'data', 'rodata', 'bss', 'section', 'globl', 'global', 'type'],
  ...['string', 'asciz', 'ascii', 'zero', 'space', 'skip', 'equ', 'set'],
  ...[...VALUE_DIRECTIVES.keys(), ...IGNORED_DIRECTIVES].map((name) => name.slice(1)),
])

/** Library functions under another name. */
const LIBRARY_ALIASES: ReadonlyMap<string, LibraryFunctionName> = new Map<
  string,
  LibraryFunctionName
>([['__isoc99_scanf', 'scanf']])

function isLibraryName(name: string): name is LibraryFunctionName {
  return Object.hasOwn(LIBRARY_FUNCTIONS, name)
}

/** The library function a name stands for (`printf`, `__isoc99_scanf` → `scanf`), if any. */
export function libraryFunction(name: string): LibraryFunctionName | undefined {
  return isLibraryName(name) ? name : LIBRARY_ALIASES.get(name)
}

/* ───────────────────────────── "Did you mean" ───────────────────────────── */

/**
 * The cost of turning `a` into `b` one edit at a time. An edit is: add a character,
 * drop one, swap two neighbours (each costs `step`), or change one (costs `change`).
 */
function editCost(a: string, b: string, step: number, change: number): number {
  if (a === b) return 0
  const columns = b.length + 1
  let twoBack: number[] = []
  let previous: number[] = Array.from({ length: columns }, (_, j) => j * step)
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i * step]
    for (let j = 1; j < columns; j++) {
      const same = a[i - 1] === b[j - 1]
      let best = Math.min(
        previous[j] + step,
        current[j - 1] + step,
        previous[j - 1] + (same ? 0 : change),
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, twoBack[j - 2] + step)
      }
      current.push(best)
    }
    twoBack = previous
    previous = current
  }
  return previous[columns - 1]
}

/**
 * How many single edits turn `a` into `b`: add, drop or change one character, or swap
 * two neighbours (so `mvo` is one edit from `mov`).
 */
export function editDistance(a: string, b: string): number {
  return editCost(a, b, 1, 1)
}

/** Longest misspelled word worth comparing against the known names. */
const SUGGESTION_LIMIT = 24

/**
 * The known word closest to a misspelled one, at most `reach` edits away.
 * Among those, a missing, extra or swapped letter counts as a smaller slip than a
 * wrong letter (`jm` is more likely `jmp` than `je`). Returns two words when they are
 * equally good (`ad` → `add`, `and`).
 */
function closestSpellings(written: string, known: readonly string[], reach: number): string[] {
  if (written.length > SUGGESTION_LIMIT) return []
  const candidates = known
    .filter((name) => editDistance(written, name) <= reach)
    .map((name) => ({
      name,
      slip: editCost(written, name, 2, 3),
      otherStart: name[0] === written[0] ? 0 : 1,
      lengthGap: Math.abs(name.length - written.length),
    }))
  // The sort is stable, so equally good words stay in the order of `known`.
  candidates.sort(
    (x, y) => x.slip - y.slip || x.otherStart - y.otherStart || x.lengthGap - y.lengthGap,
  )
  const [best, second] = candidates
  if (best === undefined) return []
  const tie =
    second !== undefined &&
    second.slip === best.slip &&
    second.otherStart === best.otherStart &&
    second.lengthGap === best.lengthGap
  return tie ? [best.name, second.name] : [best.name]
}

/** The supported instruction closest to a misspelled one: at most two edits away. */
export function suggestMnemonics(written: string): string[] {
  return closestSpellings(written, SUPPORTED_SPELLINGS, 2)
}

/** The directives a student is likely to type, most common first. */
const COMMON_DIRECTIVES: readonly string[] = [
  ...['.string', '.text', '.data', '.globl', '.equ', '.quad', '.long', '.byte', '.zero'],
  ...['.intel_syntax', '.section', '.rodata', '.bss', '.global', '.type', '.asciz', '.ascii'],
  ...['.int', '.word', '.short', '.space', '.skip', '.set'],
]

/** Real gas directives the emulator does not know. They are not misspellings. */
const OTHER_REAL_DIRECTIVES: ReadonlySet<string> = new Set([
  ...['.sect', '.end', '.org', '.fill', '.float', '.double', '.single', '.octa'],
  ...['.hword', '.2byte', '.4byte', '.8byte', '.macro', '.endm', '.if', '.else', '.endif'],
  ...['.include', '.rept', '.endr', '.previous', '.pushsection', '.popsection', '.hidden'],
  ...['.code64', '.arch', '.att_syntax'],
])

/** Names from other assemblers for directives that gcc assembly spells another way. */
const DIRECTIVE_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ['.asciiz', '.asciz'],
  ['.str', '.string'],
  ['.db', '.byte'],
  ['.dw', '.word'],
  ['.dd', '.long'],
  ['.dq', '.quad'],
  ['.dword', '.long'],
  ['.qword', '.quad'],
  ['.resb', '.zero'],
])

/**
 * The directive closest to an unknown one: one edit away (`.sting` → `.string`).
 * A skipped data directive changes what a program does, so the hint matters.
 */
function suggestDirectives(written: string): string[] {
  const lower = written.toLowerCase()
  if (OTHER_REAL_DIRECTIVES.has(lower)) return []
  const synonym = DIRECTIVE_SYNONYMS.get(lower)
  return synonym !== undefined ? [synonym] : closestSpellings(lower, COMMON_DIRECTIVES, 1)
}

/** Most register names to list in one "did you mean" (`r1` → `r8`, `r9`, `r10` … `r15`). */
const REGISTER_SUGGESTION_LIMIT = 8

/**
 * The real register names one edit away from a wrong one, in table order.
 * A few words are close to more names than a sentence can hold (`r1d`: fourteen);
 * they get no list.
 */
export function suggestRegisters(name: string): string[] {
  const lower = name.toLowerCase()
  if (lower.length > SUGGESTION_LIMIT) return []
  const close = ALL_REGISTER_NAMES.filter((real) => editDistance(lower, real) <= 1)
  return close.length <= REGISTER_SUGGESTION_LIMIT ? close : []
}

/** Does an undefined word look like someone meant a register? */
export function looksLikeRegister(name: string): boolean {
  const lower = name.toLowerCase()
  if (/^r\d+[a-z]{0,2}$/.test(lower)) return true // r16, r8l, r0
  if (!/^[re][a-z]{1,3}$/.test(lower) && !/^[a-z][xlh]$/.test(lower)) return false
  return ALL_REGISTER_NAMES.some((real) => editDistance(lower, real) <= 1) // rex, eex, fx
}

/** Real registers the emulator does not have. */
function isOtherRealRegister(lower: string): boolean {
  return (
    /^[xyz]mm\d{1,2}$/.test(lower) ||
    /^(mm|st|cr|dr)\d$/.test(lower) ||
    SEGMENT_REGISTERS.has(lower) ||
    lower === 'eflags' ||
    lower === 'rflags'
  )
}

/* ─────────────────────────── Names and symbols ─────────────────────────── */

export interface LabelInfo {
  /** 'code' for a label in front of an instruction, 'data' for one in front of data. */
  kind: 'code' | 'data'
  address: bigint
}

/** What the assembler knows about names when operands are resolved. */
export interface SymbolEnv {
  /** The value of an `.equ` constant, or undefined when the name is not one. */
  constant(name: string): bigint | undefined
  /** The label with this name, or undefined. */
  label(name: string): LabelInfo | undefined
  /** Every defined label and constant name (for "did you mean"). */
  names(): readonly string[]
}

/** A defined name that the student probably meant: same letters in another case, or one edit away. */
function suggestName(name: string, env: SymbolEnv): string | null {
  if (name.length > SUGGESTION_LIMIT) return null
  const lower = name.toLowerCase()
  const names = env.names()
  const otherCase = names.filter((known) => known.toLowerCase() === lower)
  if (otherCase.length === 1) return otherCase[0]
  if (name.length < 3) return null
  const close = names.filter(
    (known) => Math.abs(known.length - name.length) <= 1 && editDistance(known, name) === 1,
  )
  return close.length === 1 ? close[0] : null
}

/** The message for a name that is neither a register, a constant nor a label. */
export function unknownName(name: string, env: SymbolEnv, line: number): Diagnostic {
  const lower = name.toLowerCase()
  if (name === '.') return say.undefinedSymbol(line, { use: 'here' })
  if (name.length > 1 && name.startsWith('$')) {
    return say.attSyntax(line, { reason: 'immediate', text: name })
  }
  if (lower === 'eip') return say.unknownRegister(line, { reason: 'eip', name })
  if (isOtherRealRegister(lower)) return say.unknownRegister(line, { reason: 'not-general', name })
  if (looksLikeRegister(lower)) {
    return say.unknownRegister(line, { reason: 'typo', name, suggestions: suggestRegisters(lower) })
  }
  if (libraryFunction(name) !== undefined)
    return say.undefinedSymbol(line, { use: 'library', name })
  return say.undefinedSymbol(line, { use: 'operand', name, suggestion: suggestName(name, env) })
}

/**
 * Why a word cannot be the name of a label or a constant, or null when it can.
 * Only register names (and `rip`) and the size words are refused: they would be
 * ambiguous in an operand. An instruction name is fine (`loop:`, `add:`, `test:`):
 * a label never stands where an instruction name does.
 */
export function reservedNameReason(name: string): 'register' | 'size' | null {
  const lower = name.toLowerCase()
  if (lookupRegister(lower) !== undefined || lower === 'rip') return 'register'
  if (SIZE_WORDS.has(lower)) return 'size'
  return null
}

/* ───────────────────────────── Token helpers ───────────────────────────── */

function isPunct(token: Token | undefined, text: Punctuation): boolean {
  return token !== undefined && token.kind === 'punct' && token.text === text
}

function isProblem(token: Token): token is ProblemToken {
  return token.kind === 'problem'
}

/** The lower-case text of a word token, or '' for anything else. */
function wordOf(token: Token | undefined): string {
  return token !== undefined && token.kind === 'ident' ? token.text.toLowerCase() : ''
}

function isWordLike(token: Token): boolean {
  return token.kind === 'ident' || token.kind === 'number' || token.kind === 'string'
}

/** A number, or a word that starts with a digit (`1loop`). */
function isNumberLike(token: Token): boolean {
  return token.kind === 'number' || (token.kind === 'problem' && token.problem.type === 'number')
}

/**
 * Is the word at `i` a keyword here? A size word always is. `ptr` is one right after a
 * size word, and `offset` when an operand follows it; elsewhere they are names.
 */
function isKeywordAt(tokens: readonly Token[], i: number): boolean {
  const lower = wordOf(tokens[i])
  if (SIZE_WORDS.has(lower)) return true
  if (lower === 'ptr') return SIZE_WORDS.has(wordOf(tokens[i - 1]))
  if (lower !== 'offset') return false
  const next: Token | undefined = tokens[i + 1]
  return (
    next !== undefined && (next.kind === 'ident' || next.kind === 'number' || isPunct(next, '('))
  )
}

/** Is the name a label or a constant of the program? */
function isDefinedName(name: string, env: SymbolEnv): boolean {
  return env.label(name) !== undefined || env.constant(name) !== undefined
}

/**
 * Tokens as tidy text: no extra spaces, registers and keywords in lower case.
 * `DWORD  PTR [ RBP - 4 ]` → `dword ptr [rbp-4]`. Label names keep their letter case.
 */
export function tidyText(tokens: readonly Token[]): string {
  let out = ''
  let spaceNext = false
  let previousWord = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    let piece: string = token.text
    let keyword = false
    if (token.kind === 'ident') {
      const lower = piece.toLowerCase()
      if (isKeywordAt(tokens, i)) {
        piece = lower
        keyword = true
      } else if (lookupRegister(lower) !== undefined || lower === 'rip') {
        piece = lower
      } else if (lower === 'flat' && isPunct(tokens[i + 1], ':')) {
        piece = lower
      }
    }
    const word = isWordLike(token)
    if (out !== '' && (spaceNext || (previousWord && word))) out += ' '
    out += piece
    spaceNext = keyword
    previousWord = word
  }
  return out
}

/** The positions of the `[` and `(` that have a matching `]` or `)` later on. */
function closedOpenings(tokens: readonly Token[]): Set<number> {
  const open: number[] = []
  const closed = new Set<number>()
  tokens.forEach((token, i) => {
    if (token.kind !== 'punct') return
    if (token.text === '[' || token.text === '(') open.push(i)
    else if (token.text === ']' || token.text === ')') {
      const at = open.pop()
      if (at !== undefined) closed.add(at)
    }
  })
  return closed
}

/**
 * Split tokens at the commas that are not inside brackets. No tokens → no groups.
 * Only a bracket that is closed later hides the commas after it: `mov [rbp-8, rax` is
 * two operands with a missing `]`, not one operand.
 */
function splitAtCommas(tokens: readonly Token[]): Token[][] {
  if (tokens.length === 0) return []
  const closed = closedOpenings(tokens)
  const groups: Token[][] = [[]]
  let depth = 0
  tokens.forEach((token, i) => {
    if (token.kind === 'punct') {
      if ((token.text === '[' || token.text === '(') && closed.has(i)) depth++
      else if ((token.text === ']' || token.text === ')') && depth > 0) depth--
      else if (token.text === ',' && depth === 0) {
        groups.push([])
        return
      }
    }
    groups[groups.length - 1].push(token)
  })
  return groups
}

export { utf8Bytes } from './lexer'

/* ───────────────────────── Constant expressions ───────────────────────── */

/** Numbers and names joined by `+`, `-`, `*` (with optional parentheses). */
export type Expr =
  | { kind: 'number'; value: bigint }
  | { kind: 'name'; name: string }
  | { kind: 'sum'; terms: { negative: boolean; value: Expr }[] }
  | { kind: 'product'; factors: Expr[] }

/** Why an expression could not be read. The caller picks the message. */
export type ExpressionProblem =
  | { reason: 'empty' }
  /** `5 +`: a sign with nothing after it */
  | { reason: 'missing-value'; after: string }
  | { reason: 'parenthesis' }
  | { reason: 'string' }
  | { reason: 'unreadable' }

/** Parentheses deeper than this are refused (keeps the parser's own stack small). */
const MAX_DEPTH = 32

/**
 * Read an expression. Sums and products are stored as lists, not as nested pairs, so
 * a very long line cannot make the parser recurse deeply.
 */
export function parseExpression(
  tokens: readonly Token[],
  line: number,
  onProblem: (problem: ExpressionProblem) => Diagnostic,
): Expr {
  let position = 0
  let depth = 0
  const fail: (problem: ExpressionProblem) => never = (problem) => {
    throw new AsmError(onProblem(problem))
  }
  const peek = (): Token | undefined => tokens[position]

  const primary = (): Expr => {
    const token = peek()
    const before: Token | undefined = tokens[position - 1]
    if (token === undefined) {
      return fail(
        before === undefined
          ? { reason: 'empty' }
          : { reason: 'missing-value', after: before.text },
      )
    }
    if (token.kind === 'problem') throw new AsmError(problemDiagnostic(line, token))
    if (token.kind === 'number') {
      position++
      return { kind: 'number', value: token.value }
    }
    if (token.kind === 'ident') {
      position++
      return { kind: 'name', name: token.text }
    }
    if (token.kind === 'string') return fail({ reason: 'string' })
    if (token.text === '(') {
      if (depth >= MAX_DEPTH) return fail({ reason: 'unreadable' })
      position++
      depth++
      const inner = sum()
      if (!isPunct(peek(), ')')) return fail({ reason: 'parenthesis' })
      position++
      depth--
      return inner
    }
    if (token.text === ')' && depth === 0) return fail({ reason: 'parenthesis' })
    const afterSign =
      before !== undefined && before.kind === 'punct' && '+-*('.includes(before.text)
    return fail(
      afterSign ? { reason: 'missing-value', after: before.text } : { reason: 'unreadable' },
    )
  }

  const unary = (): Expr => {
    let negative = false
    for (;;) {
      const token = peek()
      if (isPunct(token, '-')) negative = !negative
      else if (!isPunct(token, '+')) break
      position++
    }
    const value = primary()
    if (!negative) return value
    if (value.kind === 'number') return { kind: 'number', value: -value.value }
    return { kind: 'sum', terms: [{ negative: true, value }] }
  }

  const product = (): Expr => {
    const factors = [unary()]
    while (isPunct(peek(), '*')) {
      position++
      factors.push(unary())
    }
    return factors.length === 1 ? factors[0] : { kind: 'product', factors }
  }

  function sum(): Expr {
    const terms = [{ negative: false, value: product() }]
    for (;;) {
      const token = peek()
      if (isPunct(token, '+')) {
        position++
        terms.push({ negative: false, value: product() })
      } else if (isPunct(token, '-')) {
        position++
        terms.push({ negative: true, value: product() })
      } else {
        break
      }
    }
    return terms.length === 1 ? terms[0].value : { kind: 'sum', terms }
  }

  const result = sum()
  const extra = peek()
  if (extra !== undefined) {
    if (extra.kind === 'problem') throw new AsmError(problemDiagnostic(line, extra))
    if (extra.kind === 'string') return fail({ reason: 'string' })
    return fail(isPunct(extra, ')') ? { reason: 'parenthesis' } : { reason: 'unreadable' })
  }
  return result
}

/**
 * Work out an expression made only of numbers and constants. `lookup` gives the value
 * of a name (and throws an `AsmError` when the name cannot be used).
 */
export function evaluateConstant(expr: Expr, lookup: (name: string) => bigint): bigint {
  switch (expr.kind) {
    case 'number':
      return expr.value
    case 'name':
      return lookup(expr.name)
    case 'sum': {
      let total = 0n
      for (const term of expr.terms) {
        const value = evaluateConstant(term.value, lookup)
        total += term.negative ? -value : value
      }
      return total
    }
    case 'product': {
      let total = 1n
      for (const factor of expr.factors) total *= evaluateConstant(factor, lookup)
      return total
    }
  }
}

/** Every name an expression uses, each once, in order. */
export function exprNames(expr: Expr): string[] {
  const names = new Set<string>()
  const visit = (part: Expr): void => {
    switch (part.kind) {
      case 'number':
        return
      case 'name':
        names.add(part.name)
        return
      case 'sum':
        for (const term of part.terms) visit(term.value)
        return
      case 'product':
        for (const factor of part.factors) visit(factor)
        return
    }
  }
  visit(expr)
  return [...names]
}

/* ────────────────────────────── Statements ────────────────────────────── */

/** One operand of an instruction, not yet understood. */
export interface RawOperand {
  tokens: Token[]
  /** Tidy text (see `tidyText`). */
  text: string
}

export interface InstructionStatement {
  kind: 'instruction'
  mnemonic: Mnemonic
  /** The mnemonic as typed, lower-cased. */
  written: string
  operands: RawOperand[]
}

/** `.equ name, value`, `.set name, value` or `name = value`. */
export interface EquStatement {
  kind: 'equ'
  /** How it was written: `.equ`, `.set` or `=`. */
  written: string
  name: string
  value: Expr
}

/** `.text`, `.data`, `.rodata`, `.bss` or `.section NAME`. */
export interface SectionStatement {
  kind: 'section'
  /** 'note' for `.section .note…`: gcc bookkeeping, skipped. */
  section: SectionName | 'note'
  /** The section name as written, e.g. `.data` or `.rodata.str1.1`. */
  name: string
  /** False for a section name the emulator does not know (it is then read-only data). */
  known: boolean
}

/** `.string`, `.asciz`, `.ascii` */
export interface StringsStatement {
  kind: 'strings'
  /** The directive as written, lower-cased. */
  directive: string
  /** True when each text gets a 0 byte after it (`.string`, `.asciz`). */
  terminated: boolean
  /** Each text as the student meant it (for display). */
  strings: string[]
  /** The bytes of each text (escapes such as `\303` are single bytes), without the 0. */
  bytes: number[][]
}

export interface DataValue {
  expr: Expr
  text: string
}

/** `.quad`, `.long`, `.int`, `.word`, `.short`, `.byte` */
export interface ValuesStatement {
  kind: 'values'
  directive: string
  /** Bytes per value. */
  elementSize: 1 | 2 | 4 | 8
  values: DataValue[]
}

/** `.zero n`, `.space n`, `.skip n` */
export interface FillStatement {
  kind: 'fill'
  directive: string
  count: Expr
  text: string
}

export type Statement =
  | InstructionStatement
  | EquStatement
  | SectionStatement
  | StringsStatement
  | ValuesStatement
  | FillStatement
  | { kind: 'intel-syntax' }
  /** A directive with no effect here (`.globl`, `.type`, `.cfi_…`). */
  | { kind: 'ignored' }
  /** A directive the emulator does not know: a warning. `suggestions`: what was meant, maybe. */
  | { kind: 'unknown-directive'; name: string; suggestions: string[] }
  /**
   * `.comm buf, 16` or `.lcomm buf, 16`, which this emulator does not support: a warning.
   * `fix` is the line to write after `.data` instead (`buf: .zero 16`).
   */
  | { kind: 'common-symbol'; written: string; fix: string }

export interface ParsedLine {
  /** 1-based line number. */
  line: number
  /** The valid labels defined on this line, in order. */
  labels: string[]
  /** The statement, when it could be read. A line can have a statement AND an error. */
  statement: Statement | null
  /** The first mistake on this line, if any. */
  error: Diagnostic | null
  /** A problem that does not stop the program: a special space or an invisible character. */
  warning: Diagnostic | null
  /** The name of an `.equ` whose value could not be read (so its uses stay quiet). */
  brokenEqu: string | null
}

function sectionStatement(name: string): SectionStatement {
  const lower = name.toLowerCase()
  let section: SectionStatement['section'] = 'rodata'
  let known = true
  if (lower === '.text' || lower.startsWith('.text.')) section = 'text'
  else if (lower.startsWith('.rodata')) section = 'rodata'
  else if (lower.startsWith('.data') || lower.startsWith('.bss')) section = 'data'
  else if (lower.startsWith('.note')) section = 'note'
  else known = false
  return { kind: 'section', section, name, known }
}

function directiveValueProblem(
  line: number,
  written: string,
  text: string,
): (problem: ExpressionProblem) => Diagnostic {
  return () => say.badDirective(line, { reason: 'value-syntax', written, text })
}

function checkConstantName(line: number, name: string): void {
  const why = reservedNameReason(name)
  if (why !== null) throw new AsmError(say.badDirective(line, { reason: 'equ-name', name, why }))
}

function parseEqu(written: string, args: Token[], line: number): EquStatement {
  const [nameToken, comma] = args
  const valueTokens = args.slice(2)
  if (
    nameToken === undefined ||
    nameToken.kind !== 'ident' ||
    !isPunct(comma, ',') ||
    valueTokens.length === 0
  ) {
    throw new AsmError(say.badDirective(line, { reason: 'equ-shape', written }))
  }
  checkConstantName(line, nameToken.text)
  const text = tidyText(valueTokens)
  const value = parseExpression(valueTokens, line, directiveValueProblem(line, written, text))
  return { kind: 'equ', written, name: nameToken.text, value }
}

/** `name = value` */
function parseAssignment(tokens: Token[], line: number): EquStatement {
  const name = tokens[0].text
  const valueTokens = tokens.slice(2)
  const text = tidyText(valueTokens)
  if (valueTokens.length === 0) {
    throw new AsmError(say.badDirective(line, { reason: 'equ-shape', written: '=' }))
  }
  if (reservedNameReason(name) === 'register') {
    throw new AsmError(say.badDirective(line, { reason: 'assign-register', name, value: text }))
  }
  checkConstantName(line, name)
  const value = parseExpression(valueTokens, line, directiveValueProblem(line, '=', text))
  return { kind: 'equ', written: '=', name, value }
}

/** Quoted text the lexer could not read: not closed, a bad escape, or curly quotes. */
function isBrokenText(token: Token): token is ProblemToken {
  return (
    token.kind === 'problem' &&
    (token.problem.type === 'string' || token.problem.type === 'look-alike')
  )
}

function parseStrings(written: string, args: Token[], line: number): StringsStatement {
  const broken = args.find(isBrokenText)
  if (broken !== undefined) throw new AsmError(problemDiagnostic(line, broken))

  // One piece of quoted text, or several with commas between them.
  const strings: string[] = []
  const bytes: number[][] = []
  for (const group of splitAtCommas(args)) {
    const [text, extra] = group
    if (text === undefined || text.kind !== 'string' || extra !== undefined) {
      throw new AsmError(say.badDirective(line, { reason: 'string', written }))
    }
    strings.push(text.value)
    bytes.push(text.bytes)
  }
  if (strings.length === 0) {
    throw new AsmError(say.badDirective(line, { reason: 'string', written }))
  }
  return { kind: 'strings', directive: written, terminated: written !== '.ascii', strings, bytes }
}

function parseValues(
  written: string,
  elementSize: 1 | 2 | 4 | 8,
  args: Token[],
  line: number,
): ValuesStatement {
  const groups = splitAtCommas(args)
  if (groups.length === 0 || groups.some((group) => group.length === 0)) {
    throw new AsmError(say.badDirective(line, { reason: 'values', written }))
  }
  const values = groups.map((group) => {
    if (group.some((token) => token.kind === 'string')) {
      throw new AsmError(say.badDirective(line, { reason: 'values', written }))
    }
    const text = tidyText(group)
    return { expr: parseExpression(group, line, directiveValueProblem(line, written, text)), text }
  })
  return { kind: 'values', directive: written, elementSize, values }
}

function parseFill(written: string, args: Token[], line: number): FillStatement {
  const groups = splitAtCommas(args)
  if (groups.length !== 1 || groups[0].length === 0) {
    throw new AsmError(say.badDirective(line, { reason: 'count', written }))
  }
  const text = tidyText(groups[0])
  const count = parseExpression(groups[0], line, () =>
    say.badDirective(line, { reason: 'count', written }),
  )
  return { kind: 'fill', directive: written, count, text }
}

/** The `.data` line that does the job of `.comm buf, 16, 16`: `buf: .zero 16`. */
function commonSymbolFix(args: readonly Token[]): string {
  const [nameGroup, sizeGroup] = splitAtCommas(args)
  const name = nameGroup?.length === 1 && nameGroup[0].kind === 'ident' ? nameGroup[0].text : null
  const size = sizeGroup !== undefined && sizeGroup.length > 0 ? tidyText(sizeGroup) : null
  return name !== null && size !== null ? `${name}: .zero ${size}` : 'buf: .zero 16'
}

function parseDirective(tokens: Token[], line: number): Statement {
  const written = tokens[0].text.toLowerCase()
  const args = tokens.slice(1)
  const valueSize = VALUE_DIRECTIVES.get(written)
  if (valueSize !== undefined) return parseValues(written, valueSize, args, line)

  switch (written) {
    case '.intel_syntax':
      if (args.length !== 1 || wordOf(args[0]) !== 'noprefix') {
        throw new AsmError(say.badDirective(line, { reason: 'intel-syntax' }))
      }
      return { kind: 'intel-syntax' }
    case '.text':
    case '.data':
    case '.rodata':
    case '.bss':
      return sectionStatement(written)
    case '.section': {
      const first: Token | undefined = args[0]
      if (first !== undefined && first.kind === 'ident') return sectionStatement(first.text)
      if (first !== undefined && first.kind === 'string' && first.value !== '') {
        return sectionStatement(first.value)
      }
      throw new AsmError(say.badDirective(line, { reason: 'section' }))
    }
    case '.globl':
    case '.global':
      if (args.length === 0 || args[0].kind !== 'ident') {
        throw new AsmError(say.badDirective(line, { reason: 'name', written }))
      }
      return { kind: 'ignored' }
    case '.type':
      return { kind: 'ignored' }
    case '.string':
    case '.asciz':
    case '.ascii':
      return parseStrings(written, args, line)
    case '.zero':
    case '.space':
    case '.skip':
      return parseFill(written, args, line)
    case '.equ':
    case '.set':
      return parseEqu(written, args, line)
    default:
      if (IGNORED_DIRECTIVES.has(written) || written.startsWith('.cfi_')) return { kind: 'ignored' }
      if (COMMON_SYMBOL_DIRECTIVES.has(written)) {
        return { kind: 'common-symbol', written, fix: commonSymbolFix(args) }
      }
      return {
        kind: 'unknown-directive',
        name: tokens[0].text,
        suggestions: suggestDirectives(written),
      }
  }
}

/* ───────────────────────────── A whole AT&T line ───────────────────────────── */

/** The width of each AT&T size letter. */
const ATT_SIZE_BITS: ReadonlyMap<string, OperandSize> = new Map<string, OperandSize>([
  ['b', 8],
  ['w', 16],
  ['l', 32],
  ['q', 64],
])

const SIZE_PTR: Readonly<Record<OperandSize, string>> = {
  8: 'byte ptr',
  16: 'word ptr',
  32: 'dword ptr',
  64: 'qword ptr',
}

/** One operand of an AT&T line, written the Intel way. */
interface IntelOperand {
  kind: 'reg' | 'imm' | 'mem' | 'target'
  text: string
}

/** `%rax`, `$5` or `$name`: the marks of AT&T syntax. */
function isAttMark(token: Token): boolean {
  if (token.kind === 'problem') {
    return token.problem.type === 'att-register' || token.problem.type === 'att-immediate'
  }
  return token.kind === 'ident' && token.text.length > 1 && token.text.startsWith('$')
}

/** The register of an AT&T register token (`%rbp` → `rbp`; `%rip` → `rip`), else null. */
function attRegister(token: Token | undefined): string | null {
  if (token === undefined || token.kind !== 'problem' || token.problem.type !== 'att-register') {
    return null
  }
  const name = token.text.slice(1).toLowerCase()
  return name === 'rip' || lookupRegister(name) !== undefined ? name : null
}

/** A number, a name or `+ - *`: what an AT&T displacement (`-8`, `msg+8`) is made of. */
function isPlainTerm(token: Token): boolean {
  if (token.kind === 'number') return true
  if (token.kind === 'punct') return token.text === '+' || token.text === '-' || token.text === '*'
  if (token.kind !== 'ident' || token.text.startsWith('$')) return false
  const lower = token.text.toLowerCase()
  return lookupRegister(lower) === undefined && lower !== 'rip' && !KEYWORDS.has(lower)
}

/**
 * An AT&T memory operand the Intel way: `-8(%rbp)` → `[rbp-8]`, `msg(%rip)` → `msg[rip]`,
 * `arr(,%rcx,8)` → `arr[rcx*8]`, a bare `counter` stays `counter`. Null when it is not one.
 */
function attMemory(group: readonly Token[]): string | null {
  const open = group.findIndex((token) => isPunct(token, '('))
  if (open === -1) {
    // A bare label is memory in both syntaxes. A bare number is memory in AT&T but a
    // number in Intel, so that one is not turned around.
    const plain = group.every(isPlainTerm) && group.some((token) => token.kind === 'ident')
    return plain ? tidyText(group) : null
  }
  const close = group.length - 1
  if (!isPunct(group[close], ')')) return null
  const prefix = group.slice(0, open)
  const inside = group.slice(open + 1, close)
  if (!prefix.every(isPlainTerm) || inside.some((token) => isPunct(token, '('))) return null

  const parts: Token[][] = [[]]
  for (const token of inside) {
    if (isPunct(token, ',')) parts.push([])
    else parts[parts.length - 1].push(token)
  }
  const [baseTokens = [], indexTokens = [], scaleTokens = [], ...extra] = parts
  if (extra.length > 0 || baseTokens.length > 1 || indexTokens.length > 1) return null
  const base = baseTokens.length === 0 ? null : attRegister(baseTokens[0])
  const index = indexTokens.length === 0 ? null : attRegister(indexTokens[0])
  if ((baseTokens.length > 0 && base === null) || (indexTokens.length > 0 && index === null)) {
    return null
  }
  let scale = ''
  if (scaleTokens.length > 0) {
    const [number] = scaleTokens
    if (scaleTokens.length !== 1 || number.kind !== 'number') return null
    scale = number.value === 1n ? '' : `*${number.value}`
  }
  const terms: string[] = []
  if (base !== null) terms.push(base)
  if (index !== null) terms.push(`${index}${scale}`)
  if (terms.length === 0) return null

  // A plain number goes inside the brackets (`[rbp-8]`); a name goes in front (`msg[rip]`).
  const prefixText = tidyText(prefix)
  if (prefix.length === 0) return `[${terms.join('+')}]`
  if (prefix.some((token) => token.kind === 'ident')) return `${prefixText}[${terms.join('+')}]`
  const sign = prefixText.startsWith('-') ? '' : '+'
  return `[${terms.join('+')}${sign}${prefixText}]`
}

/** One operand of an AT&T line, the Intel way, or null when it is not plainly AT&T. */
function attOperand(group: readonly Token[], branch: boolean): IntelOperand | null {
  if (branch) {
    // `jmp .L3`, `call printf@PLT` are the same in both syntaxes; `*%rax` is not supported.
    const plain =
      group.length > 0 &&
      group.every((token) => (token.kind === 'ident' && !isAttMark(token)) || isPunct(token, '@'))
    return plain ? { kind: 'target', text: tidyText(group) } : null
  }
  const only: Token | undefined = group[0]
  if (only === undefined) return null
  if (group.length === 1 && only.kind === 'problem') {
    if (only.problem.type === 'att-immediate') return { kind: 'imm', text: only.text.slice(1) }
    const register = attRegister(only)
    return register === null || register === 'rip' ? null : { kind: 'reg', text: register }
  }
  if (group.length === 1 && isAttMark(only)) {
    // `$msg` is the address of `msg`.
    return { kind: 'imm', text: `offset ${only.text.slice(1)}` }
  }
  const memory = attMemory(group)
  return memory === null ? null : { kind: 'mem', text: memory }
}

/**
 * A line written in AT&T syntax (`movq %rbx, %rax`), as the Intel line that does the
 * same (`mov rax, rbx`): no `%` and `$`, sizes as `dword ptr` where Intel needs them,
 * and the operands in the other order. Null when the line is not plainly AT&T (it also
 * has Intel parts, like `mov rax, $5`), or has a part this cannot turn around
 * (`%fs:40`, `*%rax`, `%xmm0`). The caller then names the first AT&T piece instead.
 */
function attToIntel(
  tokens: readonly Token[],
): { intel: string; order: 'destination' | 'swapped' | 'same' } | null {
  const [head] = tokens
  if (head === undefined || head.kind !== 'ident') return null
  const written = head.text.toLowerCase()
  const rest = tokens.slice(1)
  if (!rest.some(isAttMark)) return null

  // The Intel name, the width the size letter gives, and for movzx/movsx the source width.
  let name = written
  let size: OperandSize | null = null
  let sourceSize: OperandSize | null = null
  if (canonicalMnemonic(written) === undefined) {
    const intel = ATT_MNEMONICS.get(written)
    if (intel === undefined) return null
    name = intel
    const extend = /^mov[sz]([bwl])([wlq])$/.exec(written)
    if (extend !== null) {
      sourceSize = ATT_SIZE_BITS.get(extend[1]) ?? null
      size = ATT_SIZE_BITS.get(extend[2]) ?? null
    } else {
      size = written === 'movabsq' ? 64 : (ATT_SIZE_BITS.get(written.slice(-1)) ?? null)
    }
  }
  const mnemonic = canonicalMnemonic(name)
  if (mnemonic === undefined || expectedOperandCount(mnemonic) === 0) return null

  const branch = isBranch(mnemonic)
  const groups = splitAtCommas(rest)
  // A line with the wrong number of operands gets that message once it is Intel syntax.
  if (groups.length !== expectedOperandCount(mnemonic)) return null
  const operands: IntelOperand[] = []
  for (const group of groups) {
    const operand = attOperand(group, branch)
    if (operand === null) return null
    operands.push(operand)
  }
  operands.reverse()

  // A size word where Intel needs one: the source of movzx/movsx, and memory when no
  // register shows the size (`movl $0, -4(%rbp)` → `mov dword ptr [rbp-4], 0`).
  const hasRegister = operands.some((operand) => operand.kind === 'reg')
  const texts = operands.map((operand, position) => {
    if (operand.kind !== 'mem') return operand.text
    const width = sourceSize !== null ? (position > 0 ? sourceSize : null) : size
    const needed = sourceSize !== null || !hasRegister
    return width !== null && needed ? `${SIZE_PTR[width]} ${operand.text}` : operand.text
  })
  const intel = `${name} ${texts.join(', ')}`
  if (intel.length > say.LINE_LIMIT) return null
  const unchanged = texts.every((text) => text === texts[0])
  let order: 'destination' | 'swapped' | 'same' = 'same'
  if (texts.length >= 2 && !unchanged) {
    order = mnemonic === 'cmp' || mnemonic === 'test' ? 'swapped' : 'destination'
  }
  return { intel, order }
}

/** The message for a whole AT&T line, or null when the line cannot be turned around. */
function attLine(tokens: readonly Token[], line: number): Diagnostic | null {
  const converted = attToIntel(tokens)
  return converted === null ? null : say.attSyntax(line, { reason: 'line', ...converted })
}

/**
 * The gcc line for NASM's `resb 8` (`name` is the word in front of it, if any): the same
 * number of zero bytes, so `buf resq 4` becomes `buf: .zero 32`. Null when the count is
 * missing.
 */
function nasmReserveFix(name: string | null, unit: number, count: readonly Token[]): string | null {
  if (count.length === 0) return null
  const [first] = count
  let bytes: string
  if (count.length === 1 && first.kind === 'number') bytes = String(first.value * BigInt(unit))
  else {
    const text = tidyText(count)
    bytes = unit === 1 ? text : /[+-]/.test(text) ? `(${text})*${unit}` : `${text}*${unit}`
  }
  return name === null ? `.zero ${bytes}` : `${name}: .zero ${bytes}`
}

/**
 * A NASM line that gcc writes another way, said with the whole gcc line: `buf resb 8`
 * (`buf: .zero 8`), `resq 2` after a label (`.zero 16`), `SIZE equ 8` (`.equ SIZE, 8`).
 * Null for the other NASM words.
 */
function nasmLine(tokens: readonly Token[], line: number): Diagnostic | null {
  const [head, second] = tokens
  const first = wordOf(head)
  const firstUnit = NASM_RESERVE.get(first)
  if (firstUnit !== undefined) {
    const fixed = nasmReserveFix(null, firstUnit, tokens.slice(1))
    if (fixed === null) return null
    return say.unknownInstruction(line, { reason: 'nasm-line', written: head.text, fix: fixed })
  }
  if (head.kind !== 'ident' || second === undefined) return null
  const word = wordOf(second)
  const unit = NASM_RESERVE.get(word)
  const after = tokens.slice(2)
  let fixed: string | null = null
  if (unit !== undefined) fixed = nasmReserveFix(head.text, unit, after)
  else if (word === 'equ' && after.length > 0) fixed = `.equ ${head.text}, ${tidyText(after)}`
  if (fixed === null) return null
  return say.unknownInstruction(line, { reason: 'nasm-line', written: second.text, fix: fixed })
}

/** A word that is not a supported instruction: say what it is instead. */
function unknownMnemonic(tokens: Token[], line: number, lineText: string): Diagnostic {
  const head = tokens[0]
  const written = head.text.toLowerCase()
  const rest = tokens.slice(1)

  const intel = ATT_MNEMONICS.get(written)
  if (intel !== undefined) {
    return (
      attLine(tokens, line) ?? say.attSyntax(line, { reason: 'mnemonic', written, instead: intel })
    )
  }
  if (UNSUPPORTED.has(written)) return say.unsupportedInstruction(line, { written })
  const attBase = ATT_UNSUPPORTED.get(written)
  if (attBase !== undefined) return say.unsupportedInstruction(line, { written, base: attBase })

  if (lookupRegister(written) !== undefined) {
    return say.unknownInstruction(line, { reason: 'register', written: head.text })
  }
  const nasmFix = nasmLine(tokens, line)
  if (nasmFix !== null) return nasmFix
  const nasm = NASM_WORDS.get(written)
  if (nasm !== undefined) {
    return say.unknownInstruction(line, { reason: 'nasm', written: head.text, instead: nasm })
  }
  // The second word first: `size equ 8` is NASM, not the directive `.size` without its dot.
  const second = wordOf(rest[0])
  if (NASM_SECOND_WORDS.has(second)) {
    const instead = NASM_WORDS.get(second) ?? []
    return say.unknownInstruction(line, { reason: 'nasm', written: rest[0].text, instead })
  }
  if (DIRECTIVE_WORDS.has(written)) {
    return say.unknownInstruction(line, { reason: 'missing-dot', written: head.text })
  }

  // The whole line is AT&T syntax: say that, not "unknown instruction".
  const att = rest.find(
    (token): token is ProblemToken =>
      isProblem(token) &&
      (token.problem.type === 'att-register' || token.problem.type === 'att-immediate'),
  )
  if (att !== undefined) return problemDiagnostic(line, att)

  // `my-label:` is a label with characters a label cannot have.
  const colon = tokens.findIndex((token) => isPunct(token, ':'))
  const beforeColon = tokens.slice(0, Math.max(colon, 0))
  const labelLike =
    colon > 1 &&
    isWordLike(tokens[colon - 1]) &&
    !beforeColon.some((token) => isPunct(token, ',') || token.kind === 'string') &&
    !SEGMENT_REGISTERS.has(wordOf(tokens[colon - 1])) &&
    wordOf(tokens[colon - 1]) !== 'flat'
  if (labelLike) {
    const text = lineText.slice(head.start, tokens[colon].start).trim()
    const fixed = text.replace(/[^A-Za-z0-9_.$]+/g, '_').replace(/^(?=\d)/, '_')
    return say.badLabel(line, { reason: 'characters', text, fixed })
  }

  const suggestions = suggestMnemonics(written)
  if (suggestions.length === 0 && rest.length === 0) {
    return say.unknownInstruction(line, { reason: 'label-without-colon', written: head.text })
  }
  return say.unknownInstruction(line, { reason: 'typo', written: head.text, suggestions })
}

/** Were two operands written with no comma between them (`mov rax rbx`)? */
function hasMissingComma(groups: readonly Token[][]): boolean {
  const isAtom = (token: Token): boolean =>
    token.kind === 'number' || (token.kind === 'ident' && !KEYWORDS.has(token.text.toLowerCase()))
  for (const group of groups) {
    for (let i = 0; i + 1 < group.length; i++) {
      const here = group[i]
      const next = group[i + 1]
      if (isAtom(here) && isAtom(next)) return true
      if (lookupRegister(wordOf(here)) !== undefined && isPunct(next, '[')) return true
    }
  }
  return false
}

function parseInstruction(tokens: Token[], line: number, lineText: string): InstructionStatement {
  const written = tokens[0].text.toLowerCase()
  const mnemonic = canonicalMnemonic(written)
  if (mnemonic === undefined) throw new AsmError(unknownMnemonic(tokens, line, lineText))

  const rest = tokens.slice(1)
  const problem = rest.find(isProblem)
  if (problem !== undefined) {
    // A whole line in AT&T syntax is shown turned around; a single `%` or `$` is named.
    const att = isAttMark(problem) ? attLine(tokens, line) : null
    throw new AsmError(att ?? problemDiagnostic(line, problem))
  }

  const groups = splitAtCommas(rest)
  const filled = groups.filter((group) => group.length > 0)
  const missingComma = filled.length < expectedOperandCount(mnemonic) && hasMissingComma(filled)
  const countProblem = operandCountProblem(line, mnemonic, written, filled.length, missingComma)
  if (countProblem !== null) throw new AsmError(countProblem)
  if (filled.length !== groups.length) throw new AsmError(say.badOperand(line, { reason: 'empty' }))

  return {
    kind: 'instruction',
    mnemonic,
    written,
    operands: groups.map((group) => ({ tokens: group, text: tidyText(group) })),
  }
}

function parseStatement(tokens: Token[], line: number, lineText: string): Statement {
  const first = tokens[0]
  if (first.kind === 'problem') throw new AsmError(problemDiagnostic(line, first))
  if (first.kind !== 'ident') {
    throw new AsmError(say.unknownInstruction(line, { reason: 'not-a-word', written: first.text }))
  }
  if (isPunct(tokens[1], '=')) return parseAssignment(tokens, line)
  if (first.text.length > 1 && first.text.startsWith('.')) return parseDirective(tokens, line)
  return parseInstruction(tokens, line, lineText)
}

/** The constant name on a line that tries to define one (`.equ n, …`, `n = …`), else null. */
function equNameOf(tokens: readonly Token[]): string | null {
  const [first, second] = tokens
  if (first === undefined || second === undefined || first.kind !== 'ident') return null
  if (isPunct(second, '=')) return first.text
  const directive = first.text.toLowerCase()
  if ((directive === '.equ' || directive === '.set') && second.kind === 'ident') return second.text
  return null
}

function isLookAlike(token: Token): token is ProblemToken {
  return token.kind === 'problem' && token.problem.type === 'look-alike'
}

/**
 * The line as the student should have typed it: every look-alike character replaced,
 * spaces tidied, the comment left out. Shown in the look-alike message.
 */
function fixedLine(text: string, tokens: readonly Token[]): string {
  let out = ''
  let previous: Token | null = null
  for (const token of tokens) {
    if (previous !== null) {
      const gap = [...text.slice(previous.end, token.start)]
      if (gap.some((ch) => !isInvisible(ch))) out += ' '
    }
    out +=
      token.kind === 'problem' && token.problem.type === 'look-alike'
        ? token.problem.fixed
        : token.text
    previous = token
  }
  return out
}

/**
 * Read one line: its labels and its statement. Never throws. A mistake is returned in
 * `error` (at most one per line); the labels before it still count, so one bad line
 * does not make every later use of its label an error too.
 */
export function parseLine(text: string, line: number): ParsedLine {
  const { tokens, badComment, odd } = lexLine(text)
  const result: ParsedLine = {
    line,
    labels: [],
    statement: null,
    error: null,
    warning: odd === null ? null : say.oddCharacter(line, odd),
    brokenEqu: null,
  }

  // Labels: `name:` any number of times.
  let position = 0
  for (;;) {
    const token: Token | undefined = tokens[position]
    if (token === undefined) break
    const colonNext = isPunct(tokens[position + 1], ':')
    if (token.kind === 'ident' && colonNext) {
      const why = reservedNameReason(token.text)
      if (why !== null) result.error ??= say.badLabel(line, { reason: why, name: token.text })
      else if (token.text === '.') result.error ??= say.badLabel(line, { reason: 'empty' })
      else result.labels.push(token.text)
      position += 2
    } else if (colonNext && isNumberLike(token)) {
      result.error ??= say.badLabel(line, { reason: 'digit', text: token.text })
      position += 2
    } else if (isPunct(token, ':')) {
      result.error ??= say.badLabel(line, { reason: 'empty' })
      position += 1
    } else {
      break
    }
  }

  const rest = tokens.slice(position)
  if (rest.length > 0) {
    try {
      result.statement = parseStatement(rest, line, text)
    } catch (thrown) {
      if (!(thrown instanceof AsmError)) throw thrown
      result.error ??= thrown.diagnostic
      result.brokenEqu = equNameOf(rest)
    }
  }

  // A wrong comment marker is the first thing to fix on the line, then a character
  // that only looks right (a curly quote, a dash, a wide comma).
  const lookAlike = tokens.find(isLookAlike)
  if (badComment !== null) {
    result.error = say.commentStyle(line, { marker: badComment.marker })
  } else if (lookAlike !== undefined) {
    result.error = problemDiagnostic(line, lookAlike, fixedLine(text, tokens))
  }
  return result
}

/* ─────────────────────────────── Operands ─────────────────────────────── */

interface RegisterTerm {
  reg: RegisterInfo
  /** What the register is multiplied by (negative after a `-`). */
  scale: bigint
  /** True when a `*` was written, even `*1`. */
  scaled: boolean
}

interface LabelTerm {
  name: string
  info: LabelInfo
  factor: bigint
}

/** An address expression sorted into its parts: constant + registers + labels + rip. */
interface Linear {
  constant: bigint
  /** The `.equ` names in the constant part (a name may be listed twice until the end). */
  equNames: string[]
  /** The `.equ` names that multiply a register (`rbx*size`). */
  scaleNames: string[]
  registers: RegisterTerm[]
  labels: LabelTerm[]
  /** One entry per `rip` written, holding what it is multiplied by. */
  rip: bigint[]
}

/**
 * How an operand uses a `.equ` constant. The assembler needs this because gcc reads
 * the file from top to bottom: a constant it does not know yet is read differently.
 * - 'number': the operand is the value (`mov eax, count`)
 * - 'displacement': the value is added to an address (`count[rbp]`)
 * - 'scale': the value multiplies a register (`[rax+rbx*size]`)
 * - 'offset': after `offset`
 */
export interface ConstantUse {
  name: string
  role: 'number' | 'displacement' | 'scale' | 'offset'
}

interface OperandContext {
  env: SymbolEnv
  line: number
  /** The whole operand as tidy text, for messages. */
  text: string
  /** True while reading what is inside `[` … `]`. */
  inside: boolean
}

function emptyLinear(): Linear {
  return { constant: 0n, equNames: [], scaleNames: [], registers: [], labels: [], rip: [] }
}

function isConstantOnly(linear: Linear): boolean {
  return linear.registers.length === 0 && linear.labels.length === 0 && linear.rip.length === 0
}

/** The names of both lists, each one once. */
function union(a: readonly string[], b: readonly string[] = []): string[] {
  return [...new Set([...a, ...b])]
}

/** Add `part` to `total`. (It changes `total`, so a long sum takes time in line with its length.) */
function addInto(total: Linear, part: Linear): void {
  total.constant += part.constant
  for (const name of part.equNames) total.equNames.push(name)
  for (const name of part.scaleNames) total.scaleNames.push(name)
  for (const term of part.registers) total.registers.push(term)
  for (const term of part.labels) total.labels.push(term)
  for (const factor of part.rip) total.rip.push(factor)
}

function scaleLinear(
  linear: Linear,
  by: bigint,
  byNames: readonly string[],
  written: boolean,
): Linear {
  // The names in a scale (`rbx*size`) are not part of the displacement.
  const hasConstant = linear.constant !== 0n || linear.equNames.length > 0
  const scalesRegisters = linear.registers.length > 0
  return {
    constant: linear.constant * by,
    equNames: hasConstant ? union(linear.equNames, byNames) : [...linear.equNames],
    scaleNames: scalesRegisters ? union(linear.scaleNames, byNames) : [...linear.scaleNames],
    registers: linear.registers.map((term) => ({
      reg: term.reg,
      scale: term.scale * by,
      scaled: term.scaled || written,
    })),
    labels: linear.labels.map((term) => ({ ...term, factor: term.factor * by })),
    rip: linear.rip.map((factor) => factor * by),
  }
}

function linearName(name: string, context: OperandContext): Linear {
  const lower = name.toLowerCase()
  const linear = emptyLinear()
  const reg = lookupRegister(lower)
  if (reg !== undefined) {
    linear.registers.push({ reg, scale: 1n, scaled: false })
    return linear
  }
  if (lower === 'rip') {
    linear.rip.push(1n)
    return linear
  }
  const constant = context.env.constant(name)
  if (constant !== undefined) {
    linear.constant = constant
    linear.equNames.push(name)
    return linear
  }
  const info = context.env.label(name)
  if (info !== undefined) {
    linear.labels.push({ name, info, factor: 1n })
    return linear
  }
  if (SIZE_WORDS.has(lower) || lower === 'ptr') {
    throw new AsmError(
      say.badMemoryOperand(context.line, { reason: 'size-without-memory', text: context.text }),
    )
  }
  if (lower === 'offset') {
    throw new AsmError(say.badOperand(context.line, { reason: 'offset', text: context.text }))
  }
  throw new AsmError(unknownName(name, context.env, context.line))
}

function linearize(expr: Expr, context: OperandContext): Linear {
  switch (expr.kind) {
    case 'number':
      return { ...emptyLinear(), constant: expr.value }
    case 'name':
      return linearName(expr.name, context)
    case 'sum': {
      const total = emptyLinear()
      for (const term of expr.terms) {
        const value = linearize(term.value, context)
        addInto(total, term.negative ? scaleLinear(value, -1n, [], false) : value)
      }
      return total
    }
    case 'product': {
      let total: Linear = { ...emptyLinear(), constant: 1n }
      for (const factor of expr.factors) {
        const value = linearize(factor, context)
        if (isConstantOnly(total)) {
          total = scaleLinear(value, total.constant, total.equNames, true)
        } else if (isConstantOnly(value)) {
          total = scaleLinear(total, value.constant, value.equNames, true)
        } else {
          throw new AsmError(productProblem(total, value, context))
        }
      }
      return total
    }
  }
}

/** Two things that are not numbers were multiplied: `rax*rbx`, `message*rax`. */
function productProblem(a: Linear, b: Linear, context: OperandContext): Diagnostic {
  const { line, text } = context
  const registers = a.registers.length + b.registers.length + a.rip.length + b.rip.length
  if (context.inside) {
    return registers >= 2 && a.labels.length + b.labels.length === 0
      ? say.badMemoryOperand(line, { reason: 'register-product', text })
      : say.badMemoryOperand(line, { reason: 'label-arithmetic', text })
  }
  return registers > 0
    ? say.badOperand(line, { reason: 'register-arithmetic', text })
    : say.badOperand(line, { reason: 'label-arithmetic', text })
}

function operandProblem(context: OperandContext): (problem: ExpressionProblem) => Diagnostic {
  const { line, text } = context
  return (problem) => {
    switch (problem.reason) {
      case 'empty':
        return say.badOperand(line, { reason: 'empty' })
      case 'missing-value':
        return say.badOperand(line, { reason: 'missing-value', text, after: problem.after })
      case 'parenthesis':
        return say.badOperand(line, { reason: 'parenthesis', text })
      case 'string':
        return say.badOperand(line, { reason: 'string' })
      case 'unreadable':
        return say.badOperand(line, { reason: 'unreadable', text })
    }
  }
}

/** The one label of an address (null when there is none). More than one is a mistake. */
function singleLabel(labels: readonly LabelTerm[], context: OperandContext): LabelTerm | null {
  const { line, text } = context
  const [label, extra] = labels
  if (label === undefined) return null
  if (extra !== undefined) {
    throw new AsmError(say.badMemoryOperand(line, { reason: 'two-labels', text }))
  }
  if (label.factor === 1n) return label
  if (context.inside || label.factor < 0n) {
    throw new AsmError(
      say.badMemoryOperand(line, {
        reason: label.factor < 0n ? 'minus-label' : 'label-arithmetic',
        text,
      }),
    )
  }
  throw new AsmError(say.badOperand(line, { reason: 'label-arithmetic', text }))
}

/** A displacement must fit the 32 bits the machine code has for it. */
function checkDisplacement(disp: bigint, context: OperandContext): void {
  if (disp < -(2n ** 31n) || disp > 2n ** 31n - 1n) {
    throw new AsmError(
      say.badMemoryOperand(context.line, { reason: 'displacement', text: context.text }),
    )
  }
}

const REG64_OF_RSP: Reg64 = 'rsp'

/** Pick the base and the index from the registers written inside the brackets. */
function pickBaseAndIndex(
  terms: readonly RegisterTerm[],
  context: OperandContext,
): { base: Reg64 | null; index: Reg64 | null; scale: 1 | 2 | 4 | 8 } {
  const { line, text } = context
  for (const term of terms) {
    if (term.scale < 0n) {
      throw new AsmError(say.badMemoryOperand(line, { reason: 'minus-register', text }))
    }
    if (term.reg.size !== 64) {
      throw new AsmError(
        say.addressRegister(line, {
          reason: 'not-64',
          name: term.reg.name,
          size: term.reg.size,
          wide: term.reg.base,
        }),
      )
    }
  }
  if (terms.length > 2) {
    throw new AsmError(say.addressRegister(line, { reason: 'three-registers', text }))
  }
  const multiplied = terms.filter((term) => term.scale !== 1n)
  if (multiplied.length > 1) {
    throw new AsmError(say.addressRegister(line, { reason: 'two-scaled', text }))
  }
  for (const term of terms) {
    if (term.scale !== 1n && term.scale !== 2n && term.scale !== 4n && term.scale !== 8n) {
      throw new AsmError(
        say.badMemoryOperand(line, { reason: 'scale', scale: term.scale.toString() }),
      )
    }
  }

  const [first, second] = terms
  if (first === undefined) return { base: null, index: null, scale: 1 }

  let base: RegisterTerm | null
  let index: RegisterTerm | null
  if (second === undefined) {
    // One register: `[rax]` is a base, `[rax*8]` (even `[rax*1]`) is an index.
    base = first.scaled ? null : first
    index = first.scaled ? first : null
  } else if (multiplied.length === 1) {
    index = multiplied[0]
    base = index === first ? second : first
  } else if (first.scaled && !second.scaled) {
    index = first
    base = second
  } else {
    base = first
    index = second
  }

  // rsp can never be an index. With scale 1 the two roles can simply be swapped.
  if (index !== null && index.reg.base === REG64_OF_RSP) {
    if (index.scale !== 1n || base?.reg.base === REG64_OF_RSP) {
      throw new AsmError(say.addressRegister(line, { reason: 'rsp-index', text }))
    }
    const swapped = base
    base = index
    index = swapped
  }

  const scale = index === null ? 1n : index.scale
  return {
    base: base === null ? null : base.reg.base,
    index: index === null ? null : index.reg.base,
    scale: scale === 8n ? 8 : scale === 4n ? 4 : scale === 2n ? 2 : 1,
  }
}

/** The `.equ` name when the expression is exactly one constant name, else null. */
function bareConstantName(expr: Expr, env: SymbolEnv): string | null {
  return expr.kind === 'name' && env.constant(expr.name) !== undefined ? expr.name : null
}

/**
 * Is the `offset` at `i` the keyword? It is not when a label or a constant is called
 * `offset` and no operand follows the word (`mov rax, offset`, `offset[rip]`).
 */
function isOffsetKeyword(tokens: readonly Token[], i: number, env: SymbolEnv): boolean {
  const token: Token | undefined = tokens[i]
  if (token === undefined || wordOf(token) !== 'offset') return false
  return isKeywordAt(tokens, i) || !isDefinedName(token.text, env)
}

/**
 * Understand one operand of a data instruction (everything except jumps and calls):
 * a register, a number, or memory. When `uses` is given, every `.equ` constant the
 * operand uses is added to it, with the way it is used.
 */
function parseOperand(
  raw: RawOperand,
  env: SymbolEnv,
  line: number,
  uses: ConstantUse[] = [],
): Operand {
  const tokens = raw.tokens
  const text = raw.text
  const outside: OperandContext = { env, line, text, inside: false }
  const inside: OperandContext = { env, line, text, inside: true }
  const note = (names: readonly string[], role: ConstantUse['role']): void => {
    for (const name of union(names)) uses.push({ name, role })
  }

  const problem = tokens.find(isProblem)
  if (problem !== undefined) throw new AsmError(problemDiagnostic(line, problem))
  if (tokens.length === 0) throw new AsmError(say.badOperand(line, { reason: 'empty' }))
  if (tokens.some((token) => token.kind === 'string')) {
    throw new AsmError(say.badOperand(line, { reason: 'string' }))
  }

  // A register by itself.
  if (tokens.length === 1) {
    const reg = lookupRegister(wordOf(tokens[0]))
    if (reg !== undefined) return { kind: 'reg', reg, text: reg.name }
    if (wordOf(tokens[0]) === 'rip') {
      throw new AsmError(say.unknownRegister(line, { reason: 'rip', name: tokens[0].text }))
    }
  }

  // `dword ptr`
  let position = 0
  let size: OperandSize | null = null
  const sizeWord = wordOf(tokens[0])
  const wordSize = SIZE_WORDS.get(sizeWord)
  if (wordSize !== undefined) {
    if (wordOf(tokens[1]) !== 'ptr') {
      const rest = tidyText(tokens.slice(1))
      const fixed = `${sizeWord} ptr ${rest === '' ? '[rbp-8]' : rest}`
      throw new AsmError(
        say.badMemoryOperand(line, { reason: 'missing-ptr', word: sizeWord, fixed }),
      )
    }
    size = wordSize
    position = 2
  } else if (sizeWord === 'ptr' && !isDefinedName(tokens[0].text, env)) {
    throw new AsmError(say.badMemoryOperand(line, { reason: 'size-without-memory', text }))
  }

  if (SEGMENT_REGISTERS.has(wordOf(tokens[position])) && isPunct(tokens[position + 1], ':')) {
    throw new AsmError(say.badOperand(line, { reason: 'segment', text }))
  }

  // `offset label`, `offset flat:label`
  if (isOffsetKeyword(tokens, position, env)) {
    if (size !== null) {
      throw new AsmError(say.badMemoryOperand(line, { reason: 'size-without-memory', text }))
    }
    position++
    if (wordOf(tokens[position]) === 'flat' && isPunct(tokens[position + 1], ':')) position += 2
    const rest = tokens.slice(position)
    if (rest.length === 0 || rest.some((token) => isPunct(token, '[') || isPunct(token, ']'))) {
      throw new AsmError(say.badOperand(line, { reason: 'offset', text }))
    }
    const expr = parseExpression(rest, line, operandProblem(outside))
    const linear = linearize(expr, outside)
    if (linear.registers.length > 0 || linear.rip.length > 0) {
      throw new AsmError(say.badOperand(line, { reason: 'offset', text }))
    }
    const label = singleLabel(linear.labels, outside)
    note(linear.equNames, 'offset')
    return immediate(
      linear.constant + (label === null ? 0n : label.info.address),
      label === null ? bareConstantName(expr, env) : label.name,
      text,
    )
  }

  const open = tokens.findIndex((token, i) => i >= position && isPunct(token, '['))

  // No brackets: a number, or a label standing for the memory at its address.
  if (open === -1) {
    if (tokens.some((token) => isPunct(token, ']'))) {
      throw new AsmError(say.badMemoryOperand(line, { reason: 'missing-open', text }))
    }
    const rest = tokens.slice(position)
    if (rest.length === 0) {
      throw new AsmError(say.badMemoryOperand(line, { reason: 'size-without-memory', text }))
    }
    const expr = parseExpression(rest, line, operandProblem(outside))
    const linear = linearize(expr, outside)
    if (linear.rip.length > 0) {
      throw new AsmError(say.unknownRegister(line, { reason: 'rip', name: 'rip' }))
    }
    if (linear.registers.length > 0) {
      throw new AsmError(
        size !== null
          ? say.badMemoryOperand(line, { reason: 'size-without-memory', text })
          : say.badOperand(line, { reason: 'register-arithmetic', text }),
      )
    }
    const label = singleLabel(linear.labels, outside)
    if (label === null) {
      if (size !== null) {
        throw new AsmError(say.badMemoryOperand(line, { reason: 'size-without-memory', text }))
      }
      note(linear.equNames, 'number')
      return immediate(linear.constant, bareConstantName(expr, env), text)
    }
    checkDisplacement(linear.constant, outside)
    note(linear.equNames, 'displacement')
    return memory(size, null, null, 1, linear.constant, label, union(linear.equNames), text)
  }

  // Brackets: PREFIX [ INSIDE ]
  const close = tokens.findIndex((token, i) => i > open && isPunct(token, ']'))
  if (close === -1) {
    throw new AsmError(say.badMemoryOperand(line, { reason: 'missing-close', text }))
  }
  if (tokens.some((token, i) => i > open && i < close && isPunct(token, '['))) {
    throw new AsmError(say.badMemoryOperand(line, { reason: 'nested', text }))
  }
  if (close === open + 1) throw new AsmError(say.badMemoryOperand(line, { reason: 'empty' }))
  const after = tokens.slice(close + 1)
  if (after.length > 0) {
    throw new AsmError(
      say.badMemoryOperand(line, { reason: 'after-bracket', text, after: tidyText(after) }),
    )
  }

  const prefixTokens = tokens.slice(position, open)
  const prefix =
    prefixTokens.length === 0
      ? emptyLinear()
      : linearize(parseExpression(prefixTokens, line, operandProblem(outside)), outside)
  if (prefix.registers.length > 0 || prefix.rip.length > 0) {
    throw new AsmError(say.badMemoryOperand(line, { reason: 'register-prefix', text }))
  }
  const insideTokens = tokens.slice(open + 1, close)
  const body = linearize(parseExpression(insideTokens, line, operandProblem(inside)), inside)

  const label = singleLabel([...prefix.labels, ...body.labels], inside)
  const disp = prefix.constant + body.constant
  const equNames = union(prefix.equNames, body.equNames)
  checkDisplacement(disp, inside)
  note(equNames, 'displacement')
  note(body.scaleNames, 'scale')

  if (body.rip.length > 0) {
    if (body.rip.length > 1 || body.rip[0] !== 1n) {
      throw new AsmError(say.badMemoryOperand(line, { reason: 'rip-scale', text }))
    }
    if (body.registers.length > 0) {
      throw new AsmError(say.badMemoryOperand(line, { reason: 'rip-register', text }))
    }
    if (label === null) {
      throw new AsmError(say.badMemoryOperand(line, { reason: 'rip-label', text }))
    }
    return memory(size, 'rip', null, 1, disp, label, equNames, text)
  }

  const { base, index, scale } = pickBaseAndIndex(body.registers, inside)
  return memory(size, base, index, scale, disp, label, equNames, text)
}

function immediate(value: bigint, symbol: string | null, text: string): ImmOperand {
  return { kind: 'imm', value, symbol, text }
}

function memory(
  size: OperandSize | null,
  base: Reg64 | 'rip' | null,
  index: Reg64 | null,
  scale: 1 | 2 | 4 | 8,
  disp: bigint,
  label: LabelTerm | null,
  equNames: string[],
  text: string,
): MemOperand {
  return {
    kind: 'mem',
    size,
    base,
    index,
    scale,
    disp,
    symbol: label === null ? null : label.name,
    symbolAddress: label === null ? 0n : label.info.address,
    equNames,
    text,
  }
}

/** Understand the operand of `jmp`, a conditional jump or `call`: one label. */
function parseTarget(
  raw: RawOperand,
  written: string,
  mnemonic: Mnemonic,
  env: SymbolEnv,
  line: number,
): TargetOperand {
  const tokens = raw.tokens
  const text = raw.text
  const isCall = mnemonic === 'call'
  const wrong = (reason: 'register' | 'memory' | 'number' | 'other'): AsmError =>
    new AsmError(say.jumpTarget(line, { reason, written }))

  const problem = tokens.find(isProblem)
  if (problem !== undefined) throw new AsmError(problemDiagnostic(line, problem))

  const first: Token | undefined = tokens[0]
  if (first === undefined) throw wrong('other')
  if (tokens.some((token) => isPunct(token, '[')) || SIZE_WORDS.has(wordOf(first))) {
    throw wrong('memory')
  }
  if (first.kind === 'number' || isPunct(first, '-') || isPunct(first, '+')) throw wrong('number')
  if (first.kind !== 'ident') throw wrong('other')
  if (lookupRegister(first.text) !== undefined || wordOf(first) === 'rip') throw wrong('register')

  // NAME or NAME@PLT
  let name = first.text
  if (tokens.length === 3 && isPunct(tokens[1], '@') && tokens[2].kind === 'ident') {
    if (tokens[2].text.toLowerCase() !== 'plt') {
      throw new AsmError(say.badOperand(line, { reason: 'suffix', text }))
    }
  } else if (tokens.length !== 1) {
    throw wrong(wordOf(first) === 'offset' ? 'number' : 'other')
  }

  const label = env.label(name)
  if (label !== undefined) {
    if (label.kind === 'data') {
      throw new AsmError(say.jumpTarget(line, { reason: 'data', written, name }))
    }
    return { kind: 'target', name, address: label.address, external: false, text }
  }
  if (env.constant(name) !== undefined) throw wrong('number')

  const library = libraryFunction(name)
  if (library !== undefined) {
    if (!isCall) {
      throw new AsmError(say.jumpTarget(line, { reason: 'library', written, name: library }))
    }
    name = library
    return { kind: 'target', name, address: LIBRARY_FUNCTIONS[library], external: true, text }
  }

  if (isCall && name === '__stack_chk_fail') {
    throw new AsmError(say.undefinedSymbol(line, { use: 'stack-protector', name }))
  }
  throw new AsmError(
    say.undefinedSymbol(line, {
      use: isCall ? 'call' : 'jump',
      name,
      suggestion: suggestName(name, env),
    }),
  )
}

export type ResolvedOperands =
  { ok: true; operands: Operand[]; uses: ConstantUse[] } | { ok: false; diagnostic: Diagnostic }

/**
 * Turn the raw operands of an instruction into `Operand` objects, and list the `.equ`
 * constants they use. Never throws.
 */
export function resolveOperands(
  statement: InstructionStatement,
  env: SymbolEnv,
  line: number,
): ResolvedOperands {
  try {
    const uses: ConstantUse[] = []
    const operands = statement.operands.map((raw) =>
      isBranch(statement.mnemonic)
        ? parseTarget(raw, statement.written, statement.mnemonic, env, line)
        : parseOperand(raw, env, line, uses),
    )
    return { ok: true, operands, uses }
  } catch (thrown) {
    if (thrown instanceof AsmError) return { ok: false, diagnostic: thrown.diagnostic }
    throw thrown
  }
}
