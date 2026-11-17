/**
 * The words of the cheat sheet, written once and shown three ways: as a page on screen, on
 * a 3×5 inch index card, and on a letter page (see Sheet.tsx and cheatsheet.css).
 *
 * The sheet uses the same words and the same facts as the lessons. The register names and
 * the hex ladder are computed here from the emulator's own tables, not typed. The jumps are
 * typed with the emulator's own names (`JumpCondition`). `content.test.ts` checks every
 * typed line against the assembler and the emulator, so the sheet cannot disagree with the
 * stepper.
 *
 * Writing rules for this file: this is an exam card, so fragments and symbols are fine,
 * but every fact must be exactly right. Code goes in backticks. A `~` stands for a space
 * that must not break (see `text` below).
 */
import {
  hex,
  REG64_DISPLAY_ORDER,
  registerFamily,
  type JumpCondition,
  type OperandSize,
  type Reg64,
} from '../../emulator'

/* ─────────────────────────────── The shapes ─────────────────────────────── */

export const SECTION_IDS = [
  'registers',
  'partial-writes',
  'mov',
  'sizes',
  'lea-vs-mov',
  'addressing',
  'equ',
  'flags-and-jumps',
  'stack',
  'calling-convention',
  'hex-ladder',
] as const

export type SectionId = (typeof SECTION_IDS)[number]

/** One register: its four names by size, and the name of bits 15–8 when it has one. */
export interface RegisterRow {
  base: Reg64
  /** The 64-, 32-, 16- and 8-bit name. The 8-bit name is the lowest byte. */
  names: readonly [string, string, string, string]
  /** `ah`, `bh`, `ch` or `dh`; null for the twelve registers without such a name. */
  highByte: string | null
}

/** The three things an operand of `mov` can be, in the words of the lessons. */
export const OPERAND_KINDS = ['register', 'memory', 'number'] as const
export type OperandKind = (typeof OPERAND_KINDS)[number]

/** One way to combine a destination and a source in `mov`. */
export interface MovForm {
  dest: OperandKind
  src: OperandKind
  legal: boolean
  /** Legal only when the line says how many bytes to write (`dword ptr`). */
  needsSize: boolean
  /** A line of this form. `content.test.ts` gives it to the assembler. */
  example: string
}

/** One comparison and the jump that tests it for each kind of number. */
export interface JumpRow {
  /** In the emulator's words (`describeCondition`): "greater than or equal". */
  words: string
  /** As a formula: "a ≥ b". */
  formula: string
  signed: JumpCondition
  unsigned: JumpCondition
}

/** A term on the left and what it means on the right. */
export type Pair = readonly [term: string, meaning: string]

export type Block =
  /** The table of register names. */
  | { kind: 'registers'; rows: readonly RegisterRow[] }
  /** Short lines, one fact each. */
  | { kind: 'lines'; lines: readonly string[] }
  /** Terms with their meaning. */
  | { kind: 'pairs'; rows: readonly Pair[] }
  /** Destination against source: which forms of `mov` are legal. */
  | { kind: 'mov-forms'; forms: readonly MovForm[] }
  /** The jumps to use after `cmp a, b`. */
  | { kind: 'jumps'; rows: readonly JumpRow[] }
  /** Counting down by 8 in hex: the last two digits of each step. */
  | { kind: 'ladder'; steps: readonly string[] }

export interface SheetSection {
  id: SectionId
  title: string
  /** A word shown at the far end of the heading line, where the page has no room for more. */
  note?: string
  blocks: readonly Block[]
}

/* ───────────────────────── Built from the emulator ───────────────────────── */

const NAME_SIZES = [64, 32, 16, 8] as const satisfies readonly OperandSize[]

function registerRow(base: Reg64): RegisterRow {
  const family = registerFamily(base)
  const nameOf = (size: OperandSize): string => {
    const part = family.find((name) => name.size === size && !name.highByte)
    if (part === undefined) throw new Error(`The emulator has no ${size}-bit name for ${base}.`)
    return part.name
  }
  const [wide, half, quarter, low] = NAME_SIZES.map(nameOf)
  return {
    base,
    names: [wide, half, quarter, low],
    highByte: family.find((name) => name.highByte)?.name ?? null,
  }
}

/** All sixteen registers, in the order the course teaches them. */
export const REGISTER_ROWS: readonly RegisterRow[] = REG64_DISPLAY_ORDER.map(registerRow)

/**
 * The jumps to use after `cmp a, b`: for each comparison, the jump for signed numbers and
 * the jump for unsigned numbers. "equal" and "not equal" are the same test for both kinds.
 *
 * The names have the emulator's own type, so a jump that the emulator does not know cannot
 * be typed here. `content.test.ts` checks each row against the emulator's words
 * (`describeCondition`) and runs every jump through `conditionHolds` for all pairs of
 * bytes. The rows are written out, not looked up by those words at run time, so new
 * wording in the emulator can make a test fail but can never stop this page from loading.
 */
export const JUMP_ROWS: readonly JumpRow[] = [
  { words: 'equal', formula: 'a = b', signed: 'je', unsigned: 'je' },
  { words: 'not equal', formula: 'a ≠ b', signed: 'jne', unsigned: 'jne' },
  { words: 'greater than', formula: 'a > b', signed: 'jg', unsigned: 'ja' },
  { words: 'greater than or equal', formula: 'a ≥ b', signed: 'jge', unsigned: 'jae' },
  { words: 'less than', formula: 'a < b', signed: 'jl', unsigned: 'jb' },
  { words: 'less than or equal', formula: 'a ≤ b', signed: 'jle', unsigned: 'jbe' },
]

/** Where the hex ladder starts, and how many times it goes down by 8. */
const LADDER_TOP = 0x200
const LADDER_STEPS = 17

/** The last two hex digits while counting down by 8: 00, f8, f0, e8, … 78. */
export const HEX_LADDER: readonly string[] = Array.from({ length: LADDER_STEPS + 1 }, (_, step) =>
  ((LADDER_TOP - 8 * step) & 0xff).toString(16).padStart(2, '0'),
)

/**
 * The classic trap. Both answers are computed: the right one in hex, and the wrong one
 * that a student gets by reading the hex digits as a decimal number.
 */
export const HEX_TRAP = {
  start: hex(BigInt(LADDER_TOP)),
  right: hex(BigInt(LADDER_TOP - 8)),
  wrong: `0x${Number(LADDER_TOP.toString(16)) - 8}`,
} as const

/* ──────────────────────────────── The text ──────────────────────────────── */

/** A space that does not break (U+00A0): the words on its two sides stay on one line. */
const NO_BREAK_SPACE = String.fromCharCode(0xa0)

/** Every `~` becomes a space that does not break. */
function text(words: string): string {
  return words.replaceAll('~', NO_BREAK_SPACE)
}

function pair(term: string, meaning: string): Pair {
  return [text(term), text(meaning)]
}

function lines(...items: string[]): Block {
  return { kind: 'lines', lines: items.map(text) }
}

function pairs(...rows: Pair[]): Block {
  return { kind: 'pairs', rows }
}

/** Every pair of a destination and a source. Five are legal; one of the five needs a size. */
export const MOV_FORMS: readonly MovForm[] = [
  { dest: 'register', src: 'register', legal: true, needsSize: false, example: 'mov rax, rbx' },
  { dest: 'register', src: 'memory', legal: true, needsSize: false, example: 'mov rax, [rbx]' },
  { dest: 'register', src: 'number', legal: true, needsSize: false, example: 'mov rax, 5' },
  { dest: 'memory', src: 'register', legal: true, needsSize: false, example: 'mov [rbx], rax' },
  { dest: 'memory', src: 'memory', legal: false, needsSize: false, example: 'mov [rax], [rbx]' },
  {
    dest: 'memory',
    src: 'number',
    legal: true,
    needsSize: true,
    example: 'mov dword ptr [rbx], 5',
  },
  { dest: 'number', src: 'register', legal: false, needsSize: false, example: 'mov 5, rax' },
  { dest: 'number', src: 'memory', legal: false, needsSize: false, example: 'mov 5, [rbx]' },
  { dest: 'number', src: 'number', legal: false, needsSize: false, example: 'mov 5, 7' },
]

export const SHEET: readonly SheetSection[] = [
  {
    id: 'registers',
    title: 'Register names',
    note: 'bits',
    blocks: [{ kind: 'registers', rows: REGISTER_ROWS }],
  },
  {
    id: 'partial-writes',
    title: 'Writing part of a register',
    blocks: [
      lines(
        '8-bit or 16-bit name: changes only its own bits.',
        '32-bit name: also sets the top 32~bits to~0.',
        '`ah` `bh` `ch` `dh` are bits 15–8.',
      ),
    ],
  },
  {
    id: 'mov',
    title: 'mov rules',
    // On the card the corner of the table has no room for this: the heading carries it.
    note: 'dest ← src',
    blocks: [
      lines('`mov dest, src` copies src into dest.'),
      { kind: 'mov-forms', forms: MOV_FORMS },
      lines('Also illegal: two sizes that do not match (`mov rax, ebx`).'),
    ],
  },
  {
    id: 'sizes',
    title: 'Sizes',
    blocks: [
      lines(
        // Two facts on one line, so the card needs no extra line for the first one.
        '1~bit: 0~or~1 · 1~hex digit = 4~bits',
        '1~byte = 8~bits = 2~hex digits',
        '64~bits = 8~bytes = 16~hex digits',
        'Bytes: `byte ptr`~1~· `word ptr`~2~· `dword ptr`~4~· `qword ptr`~8',
      ),
    ],
  },
  {
    id: 'lea-vs-mov',
    title: 'lea vs. mov',
    blocks: [
      // `8[rbx]`, not `[rbx]`: with no number, `lea rax, [rbx]` does the same as
      // `mov rax, rbx`, and that would hide what `lea` is for.
      pairs(
        pair('`mov rax, 8[rbx]`', 'copies what is stored at the address'),
        pair('`lea rax, 8[rbx]`', 'puts the address itself in rax'),
      ),
    ],
  },
  {
    id: 'addressing',
    title: 'Indirect addressing',
    blocks: [
      lines('`[x]`: the memory at address x'),
      pairs(
        pair('`[rax]`', 'at rax'),
        pair('`[rax+8]`', 'at rax~+~8'),
        pair('`8[rax]`', 'at rax~+~8'),
        pair('`-8[rbp]`', 'at rbp~−~8'),
        pair('`name[rbp]`', 'at rbp~+~name'),
        pair('`label[rip]`', 'at label'),
      ),
    ],
  },
  {
    id: 'equ',
    title: '.equ names',
    blocks: [lines('After `.equ count, -8`:', '`count[rbp]` = `-8[rbp]`')],
  },
  {
    id: 'flags-and-jumps',
    title: 'Flags and jumps',
    blocks: [
      // The four lines below are exact for these three instructions only: `inc` and `dec`
      // leave CF alone (the next block), and `imul` sets CF for a signed overflow.
      lines('After `add`, `sub`, `cmp`:'),
      pairs(
        pair('`ZF`~=~1:', 'the result is 0'),
        pair('`SF`~=~1:', 'it is negative (top bit~1)'),
        pair('`CF`~=~1:', 'it did not fit, unsigned'),
        pair('`OF`~=~1:', 'it did not fit, signed'),
      ),
      lines('`inc` and `dec` leave CF alone.'),
      { kind: 'jumps', rows: JUMP_ROWS },
    ],
  },
  {
    id: 'stack',
    title: 'Stack, rip, call, ret',
    blocks: [
      pairs(pair('`push`:', 'rsp~−~8, then store'), pair('`pop`:', 'load, then rsp~+~8')),
      lines('The stack grows down.'),
      pairs(
        pair('`rip`:', 'address of the NEXT instruction (address~+~size)'),
        pair('`call`:', 'push the return address, then jump'),
        pair('`ret`:', 'pop into rip'),
      ),
    ],
  },
  {
    id: 'calling-convention',
    title: 'Calling convention',
    blocks: [
      pairs(
        pair('Arguments:', '`rdi` `rsi` `rdx` `rcx` `r8` `r9`. Result: `rax`'),
        pair('Must be restored:', '`rbx` `rbp` `r12`–`r15` (and `rsp`)'),
        pair('May change in any call:', '`rax` `rcx` `rdx` `rsi` `rdi` `r8`–`r11`'),
        pair('Opening lines:', '`push rbp`~· `mov rbp, rsp`~· `sub rsp, 16·k`'),
        pair('Closing lines:', '`mov rsp, rbp`~· `pop rbp`~· `ret`'),
      ),
      // Each other `push` moves rsp by 8, so one more `push rbx` would leave it ending in 8.
      lines('k = 1, 2, 3~… so that rsp ends in 0 before a `call` (no other `push`).'),
    ],
  },
  {
    id: 'hex-ladder',
    title: 'Hex: count down by 8',
    blocks: [
      { kind: 'ladder', steps: HEX_LADDER },
      lines(
        'The last digit goes 0, 8, 0, 8. When it goes from 0 to 8, the digit before it goes down by one (after 0 comes f).',
        'a~=~10 · b~=~11 · c~=~12 · d~=~13 · e~=~14 · f~=~15',
        `Trap: \`${HEX_TRAP.start} − 8 = ${HEX_TRAP.right}\` (not \`${HEX_TRAP.wrong}\`)`,
      ),
    ],
  },
]

/** One section by its id. */
export function sectionById(id: SectionId): SheetSection {
  const found = SHEET.find((section) => section.id === id)
  if (found === undefined) throw new Error(`The cheat sheet has no section "${id}".`)
  return found
}
