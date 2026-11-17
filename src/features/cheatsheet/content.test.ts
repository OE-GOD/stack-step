/**
 * Every fact on the cheat sheet, checked against the emulator.
 *
 * A student carries this sheet into an exam, so a typing mistake here is not allowed to
 * survive. Where the sheet shows code, the code is given to the assembler. Where the
 * sheet says what an instruction does, a small program is run and the machine is
 * compared with the sentence. The tests read the sheet's own text (`SHEET`), not a copy
 * of it, so a changed line is checked again by itself.
 */
import { describe, expect, it } from 'vitest'
import {
  ALL_REGISTER_NAMES,
  assemble,
  conditionHolds,
  createEmulator,
  DEFAULT_OPTIONS,
  describeCondition,
  JUMP_CONDITIONS,
  lookupRegister,
  MASK,
  REG64_DISPLAY_ORDER,
  REG64_NAMES,
  toSigned,
  type AssembleCode,
  type Emulator,
  type EmulatorOptions,
  type Flags,
  type Reg64,
} from '../../emulator'
import {
  HEX_LADDER,
  HEX_TRAP,
  JUMP_ROWS,
  MOV_FORMS,
  OPERAND_KINDS,
  REGISTER_ROWS,
  SECTION_IDS,
  sectionById,
  SHEET,
  type Pair,
  type SectionId,
} from './content'
import { CARD_LAYOUT, LETTER_LAYOUT, type PrintLayout } from './layout'

/* ───────────────────────────── Reading the sheet ───────────────────────────── */

/** The text with ordinary spaces (the sheet uses spaces that do not break, U+00A0). */
function plain(text: string): string {
  return text.replaceAll(String.fromCharCode(0xa0), ' ')
}

/** Every line of the `lines` blocks of a section. */
function linesOf(id: SectionId): string[] {
  return sectionById(id).blocks.flatMap((block) =>
    block.kind === 'lines' ? block.lines.map(plain) : [],
  )
}

/** Every row of the `pairs` blocks of a section. */
function pairsOf(id: SectionId): Pair[] {
  return sectionById(id).blocks.flatMap((block) =>
    block.kind === 'pairs'
      ? block.rows.map(([term, meaning]): Pair => [plain(term), plain(meaning)])
      : [],
  )
}

/** The pieces of code in a line: the parts between backticks. */
function codeIn(text: string): string[] {
  return text.split('`').filter((_, index) => index % 2 === 1)
}

/** The one line of a section that starts with these words. */
function lineStarting(id: SectionId, start: string): string {
  const found = linesOf(id).filter((line) => line.startsWith(start))
  expect(found, `one line of "${id}" starts with "${start}"`).toHaveLength(1)
  return found[0]
}

/** The meaning of the one pair of a section whose term starts with these words. */
function meaningOf(id: SectionId, termStart: string): string {
  const found = pairsOf(id).filter(([term]) => term.startsWith(termStart))
  expect(found, `one term of "${id}" starts with "${termStart}"`).toHaveLength(1)
  return found[0][1]
}

/** Every string a student can read on the sheet. */
function allText(): string[] {
  const texts: string[] = []
  for (const section of SHEET) {
    texts.push(section.title)
    for (const block of section.blocks) {
      if (block.kind === 'lines') texts.push(...block.lines)
      if (block.kind === 'pairs') texts.push(...block.rows.flat())
    }
  }
  return texts
}

/* ───────────────────────────── Running programs ───────────────────────────── */

const ALL_ONES = MASK[64]

function emulatorOf(source: string, options?: EmulatorOptions): Emulator {
  const made = createEmulator(source, options)
  if (!made.ok) {
    throw new Error(`${source}\n${made.diagnostics.map((problem) => problem.message).join('\n')}`)
  }
  return made.emulator
}

/** Run the first `count` steps of a program and give back the emulator. */
function afterSteps(source: string, count: number, options?: EmulatorOptions): Emulator {
  const emulator = emulatorOf(source, options)
  for (let step = 0; step < count; step++) {
    const result = emulator.step()
    expect(result.error, `${source}\nstep ${step + 1}`).toBeNull()
    expect(result.executed).toBe(true)
  }
  return emulator
}

/** The 8 bytes at an address as one number (lowest byte first). */
function boxAt(emulator: Emulator, address: bigint): bigint {
  const bytes = emulator.readMemory(address, 8)
  let value = 0n
  for (const [index, byte] of bytes.entries()) {
    if (byte === null) throw new Error(`No byte was ever written at ${address + BigInt(index)}.`)
    value |= BigInt(byte) << BigInt(8 * index)
  }
  return value
}

/** The code of the first error the assembler finds, or null when the line is legal. */
function errorCodeOf(source: string): AssembleCode | null {
  const result = assemble(source)
  if (result.ok) return null
  const error = result.diagnostics.find((problem) => problem.severity === 'error')
  return error?.code ?? null
}

/** `r12`–`r15` written out: every register from the first to the last, in machine order. */
function registersIn(text: string): Reg64[] {
  const names: Reg64[] = []
  const pieces = text.split('`')
  for (let index = 1; index < pieces.length; index += 2) {
    const name = pieces[index] as Reg64
    expect(REG64_NAMES, `${name} is a 64-bit register`).toContain(name)
    const isRangeEnd = pieces[index - 1] === '–' && names.length > 0
    if (isRangeEnd) {
      const from = REG64_NAMES.indexOf(names[names.length - 1])
      names.push(...REG64_NAMES.slice(from + 1, REG64_NAMES.indexOf(name) + 1))
    } else {
      names.push(name)
    }
  }
  return names
}

/* ───────────────────────────────── The shape ───────────────────────────────── */

describe('the shape of the sheet', () => {
  it('has the eleven sections, each once, in the listed order', () => {
    expect(SHEET.map((section) => section.id)).toEqual([...SECTION_IDS])
    expect(new Set(SECTION_IDS).size).toBe(11)
  })

  it('gives every section a title and at least one block', () => {
    for (const section of SHEET) {
      expect(section.title.trim(), section.id).toBe(section.title)
      expect(section.title.length, section.id).toBeGreaterThan(0)
      expect(section.blocks.length, section.id).toBeGreaterThan(0)
    }
  })

  it('closes every piece of code, and has no stray spaces', () => {
    for (const text of allText()) {
      expect(text.split('`').length % 2, `backticks come in pairs: ${text}`).toBe(1)
      expect(text.trim(), text).toBe(text)
      expect(text, text).not.toMatch(/ {2}|~/)
    }
  })

  it('never shows the same line or the same term twice in one block', () => {
    for (const section of SHEET) {
      for (const block of section.blocks) {
        if (block.kind === 'lines') expect(new Set(block.lines).size).toBe(block.lines.length)
        if (block.kind === 'pairs') {
          expect(new Set(block.rows.map(([term]) => term)).size).toBe(block.rows.length)
        }
      }
    }
  })

  it.each([
    ['index card', CARD_LAYOUT],
    ['letter page', LETTER_LAYOUT],
  ] satisfies [string, PrintLayout][])('puts every section on the %s exactly once', (_, layout) => {
    const placed = [...layout.columns.flat(), ...layout.footer]
    expect([...placed].sort()).toEqual([...SECTION_IDS].sort())
  })
})

/* ──────────────────────────────── Register names ──────────────────────────────── */

describe('register names', () => {
  it('lists the sixteen registers in the order the course teaches them', () => {
    expect(REGISTER_ROWS.map((row) => row.base)).toEqual(REG64_DISPLAY_ORDER)
    expect(REGISTER_ROWS).toHaveLength(16)
  })

  it('shows every register name the emulator knows, exactly once', () => {
    const shown = REGISTER_ROWS.flatMap((row) =>
      row.highByte === null ? [...row.names] : [...row.names, row.highByte],
    )
    expect([...shown].sort()).toEqual([...ALL_REGISTER_NAMES].sort())
    expect(shown).toHaveLength(68)
  })

  it('puts each name in the column of its size, in the row of its register', () => {
    for (const row of REGISTER_ROWS) {
      for (const [column, size] of ([64, 32, 16, 8] as const).entries()) {
        const info = lookupRegister(row.names[column])
        expect(info, row.names[column]).toMatchObject({ base: row.base, size, shift: 0 })
      }
    }
  })

  it('has a name for bits 15–8 only for rax, rbx, rcx and rdx', () => {
    const withHighByte = REGISTER_ROWS.filter((row) => row.highByte !== null)
    expect(withHighByte.map((row) => [row.base, row.highByte])).toEqual([
      ['rax', 'ah'],
      ['rbx', 'bh'],
      ['rcx', 'ch'],
      ['rdx', 'dh'],
    ])
    for (const row of withHighByte) {
      expect(lookupRegister(row.highByte ?? '')).toMatchObject({
        base: row.base,
        size: 8,
        shift: 8,
      })
    }
  })
})

/* ──────────────────────────── Writing part of a register ──────────────────────────── */

describe('writing part of a register', () => {
  /** The whole register after `mov <name>, 0x5a`, when every bit was 1 before. */
  function writeTo(name: string): { base: Reg64; after: bigint } {
    const info = lookupRegister(name)
    if (info === undefined) throw new Error(`Unknown register ${name}`)
    const initialRegisters = { [info.base]: ALL_ONES }
    const emulator = afterSteps(`mov ${name}, 0x5a\nret\n`, 1, { initialRegisters })
    return { base: info.base, after: emulator.getSnapshot().registers[info.base] }
  }

  const namesOfSize = (size: number): string[] =>
    ALL_REGISTER_NAMES.filter((name) => lookupRegister(name)?.size === size)

  it('says the three rules', () => {
    expect(linesOf('partial-writes')).toEqual([
      '8-bit or 16-bit name: changes only its own bits.',
      '32-bit name: also sets the top 32 bits to 0.',
      '`ah` `bh` `ch` `dh` are bits 15–8.',
    ])
  })

  it('an 8-bit or 16-bit name changes only its own bits', () => {
    const small = [...namesOfSize(8), ...namesOfSize(16)]
    expect(small).toHaveLength(20 + 16)
    for (const name of small) {
      const info = lookupRegister(name)
      if (info === undefined) throw new Error(name)
      const ownBits = MASK[info.size] << BigInt(info.shift)
      const expected = (ALL_ONES & ~ownBits) | (0x5an << BigInt(info.shift))
      expect(writeTo(name).after, name).toBe(expected)
    }
  })

  it('a 32-bit name also sets the top 32 bits to 0', () => {
    const names = namesOfSize(32)
    expect(names).toHaveLength(16)
    for (const name of names) expect(writeTo(name).after, name).toBe(0x5an)
  })

  it('ah, bh, ch and dh are bits 15–8', () => {
    const names = codeIn(lineStarting('partial-writes', '`ah`'))
    expect(names).toEqual(['ah', 'bh', 'ch', 'dh'])
    for (const name of names) {
      expect(writeTo(name).after, name).toBe((ALL_ONES & ~0xff00n) | 0x5a00n)
    }
  })
})

/* ─────────────────────────────────── mov rules ─────────────────────────────────── */

describe('mov rules', () => {
  it('copies the source into the destination, and the source keeps its value', () => {
    expect(linesOf('mov')[0]).toBe('`mov dest, src` copies src into dest.')
    const initialRegisters = { rax: 0x1111n, rbx: 0x2222n }
    const { registers } = afterSteps('mov rax, rbx\nret\n', 1, { initialRegisters }).getSnapshot()
    expect(registers.rax).toBe(0x2222n)
    expect(registers.rbx).toBe(0x2222n)
  })

  it('has every pair of a destination and a source exactly once', () => {
    const pairs = MOV_FORMS.map((form) => `${form.dest} ← ${form.src}`)
    const expected = OPERAND_KINDS.flatMap((dest) => OPERAND_KINDS.map((src) => `${dest} ← ${src}`))
    expect(pairs).toEqual(expected)
  })

  it('has five legal forms and four illegal ones', () => {
    const legal = MOV_FORMS.filter((form) => form.legal)
    expect(legal.map((form) => `${form.dest} ← ${form.src}`)).toEqual([
      'register ← register',
      'register ← memory',
      'register ← number',
      'memory ← register',
      'memory ← number',
    ])
    expect(MOV_FORMS.filter((form) => !form.legal)).toHaveLength(4)
  })

  it.each(MOV_FORMS.map((form) => [form.example, form] as const))(
    'the assembler agrees about %s',
    (example, form) => {
      const code = errorCodeOf(`${example}\nret\n`)
      if (form.legal) {
        expect(code).toBeNull()
      } else if (form.dest === 'number') {
        expect(code).toBe('immediate-destination')
      } else {
        expect(code).toBe('memory-to-memory')
      }
    },
  )

  it('only memory ← number needs a size, and it is illegal without one', () => {
    const sized = MOV_FORMS.filter((form) => form.needsSize)
    expect(sized.map((form) => `${form.dest} ← ${form.src}`)).toEqual(['memory ← number'])
    const [form] = sized
    expect(form.example).toBe('mov dword ptr [rbx], 5')
    expect(errorCodeOf(`${form.example.replace('dword ptr ', '')}\nret\n`)).toBe('missing-size')
  })

  it('two sizes that do not match are illegal', () => {
    const line = lineStarting('mov', 'Also illegal')
    const [example] = codeIn(line)
    expect(example).toBe('mov rax, ebx')
    expect(errorCodeOf(`${example}\nret\n`)).toBe('size-mismatch')
  })
})

/* ───────────────────────────────────── Sizes ───────────────────────────────────── */

describe('sizes', () => {
  const BITS_IN: Record<string, number> = { bit: 1, 'hex digit': 4, byte: 8 }

  /** "16 hex digits" → 64 (bits). */
  function bitsOf(amount: string): number {
    const match = /^(\d+) (hex digit|byte|bit)s?$/.exec(amount)
    if (match === null) throw new Error(`Cannot read the amount "${amount}".`)
    return Number(match[1]) * BITS_IN[match[2]]
  }

  /** The facts of the section: a line may hold several, with " · " between them. */
  const facts = (): string[] => linesOf('sizes').flatMap((line) => line.split(' · '))

  it('says what a bit is', () => {
    expect(facts()).toContain('1 bit: 0 or 1')
  })

  it('every "=" fact is true', () => {
    const equalities = facts().filter((fact) => fact.includes('='))
    expect(equalities).toEqual([
      '1 hex digit = 4 bits',
      '1 byte = 8 bits = 2 hex digits',
      '64 bits = 8 bytes = 16 hex digits',
    ])
    for (const fact of equalities) {
      const amounts = fact.split(' = ').map(bitsOf)
      expect(new Set(amounts).size, fact).toBe(1)
    }
  })

  it('gives the size of each `ptr` word in bytes, as the assembler counts them', () => {
    const line = lineStarting('sizes', 'Bytes:')
    const sizes = [...line.matchAll(/`(\w+ ptr)` (\d+)/g)].map((match) => [
      match[1],
      Number(match[2]),
    ])
    expect(sizes).toEqual([
      ['byte ptr', 1],
      ['word ptr', 2],
      ['dword ptr', 4],
      ['qword ptr', 8],
    ])
    for (const [word, bytes] of sizes) {
      const result = assemble(`mov ${word} [rax], 1\nret\n`)
      if (!result.ok) throw new Error(`${word} did not assemble`)
      // `opSize` is in bits.
      expect(result.program.instructions[0].opSize, String(word)).toBe(Number(bytes) * 8)
    }
  })
})

/* ──────────────────────────────── lea vs. mov ──────────────────────────────── */

describe('lea vs. mov', () => {
  const PROGRAM = [
    '    .data',
    'numbers:',
    '    .quad 0x1234, 0x5678',
    '    .text',
    'main:',
    '    lea rbx, numbers[rip]',
  ]

  it('compares the two on the same operand, one with a number in it', () => {
    const [movLine, leaLine] = pairsOf('lea-vs-mov').map(([term]) => codeIn(term)[0])
    expect([movLine, leaLine]).toEqual(['mov rax, 8[rbx]', 'lea rax, 8[rbx]'])
    // With a number, `lea` gives what no `mov` between registers gives: rbx + 8.
    const leaOnly = afterSteps(`${leaLine}\nret\n`, 1, { initialRegisters: { rbx: 0x100n } })
    expect(leaOnly.getSnapshot().registers.rax).toBe(0x108n)
  })

  it('mov copies what is stored at the address', () => {
    expect(meaningOf('lea-vs-mov', '`mov rax, 8[rbx]`')).toBe(
      'copies what is stored at the address',
    )
    const emulator = afterSteps([...PROGRAM, '    mov rax, 8[rbx]', '    ret'].join('\n'), 2)
    const { registers } = emulator.getSnapshot()
    expect(registers.rbx).toBe(DEFAULT_OPTIONS.dataBase)
    // The second number of the table: the one stored at rbx + 8.
    expect(registers.rax).toBe(0x5678n)
  })

  it('lea puts the address itself in the register and reads no memory', () => {
    expect(meaningOf('lea-vs-mov', '`lea rax, 8[rbx]`')).toBe('puts the address itself in rax')
    const emulator = afterSteps([...PROGRAM, '    lea rax, 8[rbx]', '    ret'].join('\n'), 2)
    expect(emulator.getSnapshot().registers.rax).toBe(DEFAULT_OPTIONS.dataBase + 8n)

    // An address with no memory behind it: `lea` still works, `mov` cannot read it.
    const nowhere = { initialRegisters: { rbx: 0x10n } }
    expect(afterSteps('lea rax, 8[rbx]\nret\n', 1, nowhere).getSnapshot().registers.rax).toBe(0x18n)
    expect(emulatorOf('mov rax, 8[rbx]\nret\n', nowhere).step().error?.code).toBe('bad-memory-read')
  })
})

/* ──────────────────────────── Indirect addressing ──────────────────────────── */

describe('indirect addressing', () => {
  const TABLE = DEFAULT_OPTIONS.dataBase
  const SOURCE = [
    '    .equ name, -8',
    '    .data',
    'table:',
    '    .quad 0x1111, 0x2222, 0x3333',
    'label:',
    '    .quad 0x4444',
    '    .text',
    'main:',
  ]
  // rax points at the first number of the table, rbp just past the second one.
  const OPTIONS: EmulatorOptions = { initialRegisters: { rax: TABLE, rbp: TABLE + 16n } }

  /** "at rbp − 8" → the address it names in the program above. */
  function addressNamed(meaning: string, emulator: Emulator): bigint {
    const match = /^at (\w+)(?: ([+−]) (\w+))?$/.exec(meaning)
    if (match === null) throw new Error(`Cannot read the address "${meaning}".`)
    const [, start, sign, amount] = match
    const { registers } = emulator.getSnapshot()
    const valueOf = (word: string): bigint => {
      if (word in registers) return registers[word as Reg64]
      const symbol = emulator.program.symbols.get(word)
      if (symbol !== undefined) return symbol.address
      return emulator.program.constants.get(word) ?? BigInt(word)
    }
    if (sign === undefined) return valueOf(start)
    return sign === '+' ? valueOf(start) + valueOf(amount) : valueOf(start) - valueOf(amount)
  }

  it('says that brackets mean the memory at that address', () => {
    expect(linesOf('addressing')).toEqual(['`[x]`: the memory at address x'])
  })

  it('shows the six forms', () => {
    expect(pairsOf('addressing').map(([term]) => term)).toEqual([
      '`[rax]`',
      '`[rax+8]`',
      '`8[rax]`',
      '`-8[rbp]`',
      '`name[rbp]`',
      '`label[rip]`',
    ])
  })

  it.each(pairsOf('addressing'))('%s reads the memory %s', (term, meaning) => {
    const [form] = codeIn(term)
    const emulator = afterSteps(
      [...SOURCE, `    mov rcx, ${form}`, '    ret'].join('\n'),
      1,
      OPTIONS,
    )
    const address = addressNamed(meaning, emulator)
    expect(address >= TABLE && address < TABLE + 32n, `${meaning} is inside the data`).toBe(true)
    expect(emulator.getSnapshot().registers.rcx).toBe(boxAt(emulator, address))
  })

  it('reads a different number with each address', () => {
    // So the test above cannot pass by accident: the four boxes hold four values.
    const emulator = emulatorOf([...SOURCE, '    ret'].join('\n'), OPTIONS)
    const values = [0n, 8n, 16n, 24n].map((offset) => boxAt(emulator, TABLE + offset))
    expect(values).toEqual([0x1111n, 0x2222n, 0x3333n, 0x4444n])
  })
})

/* ────────────────────────────────── .equ names ────────────────────────────────── */

describe('.equ names', () => {
  it('count[rbp] is the same memory as -8[rbp] after .equ count, -8', () => {
    const [first, second] = linesOf('equ')
    expect(first).toBe('After `.equ count, -8`:')
    expect(second).toBe('`count[rbp]` = `-8[rbp]`')
    const [directive] = codeIn(first)
    const [named, numbered] = codeIn(second)

    const source = `    ${directive}\nmain:\n    mov rax, ${named}\n    mov rcx, ${numbered}\n    ret\n`
    const result = assemble(source)
    if (!result.ok) throw new Error(result.diagnostics.map((problem) => problem.message).join('\n'))
    const [withName, withNumber] = result.program.instructions.map((line) => line.operands[1])
    expect(withName).toMatchObject({ kind: 'mem', base: 'rbp', disp: -8n, equNames: ['count'] })
    expect(withNumber).toMatchObject({ kind: 'mem', base: 'rbp', disp: -8n, equNames: [] })
    expect(result.program.constants.get('count')).toBe(-8n)
  })
})

/* ──────────────────────────────── Flags and jumps ──────────────────────────────── */

describe('flags', () => {
  /** The instructions the four flag lines are said for: the code in the line before them. */
  const named = codeIn(lineStarting('flags-and-jumps', 'After'))

  /** The flags after `mov al, a` and then `<op> al, b`. */
  function flagsAfter(op: string, a: number, b: number): Flags {
    return afterSteps(`mov al, ${a}\n${op} al, ${b}\nret\n`, 2).getSnapshot().flags
  }

  /**
   * The flag lines for ZF, SF and OF, worked out by hand for a result. `unsigned` and
   * `signed` are the exact results, before they are cut down to one byte.
   */
  function expectZfSfOf(flags: Flags, unsigned: number, signed: bigint, label: string): void {
    const result = unsigned & 0xff
    // ZF = 1: the result is 0.
    expect(flags.ZF, label).toBe(result === 0 ? 1 : 0)
    // SF = 1: it is negative (top bit 1).
    expect(flags.SF, label).toBe(result >> 7)
    expect(flags.SF, label).toBe(toSigned(BigInt(result), 8) < 0n ? 1 : 0)
    // OF = 1: it did not fit, signed (a byte holds -128 to 127).
    expect(flags.OF, label).toBe(signed < -128n || signed > 127n ? 1 : 0)
  }

  /** All four flag lines: the three above, and CF. */
  function expectTheFourLines(flags: Flags, unsigned: number, signed: bigint, label: string) {
    expectZfSfOf(flags, unsigned, signed, label)
    // CF = 1: it did not fit, unsigned (a byte holds 0 to 255).
    expect(flags.CF, label).toBe(unsigned < 0 || unsigned > 255 ? 1 : 0)
  }

  it('says one thing about each of the four flags, for add, sub and cmp', () => {
    expect(lineStarting('flags-and-jumps', 'After')).toBe('After `add`, `sub`, `cmp`:')
    expect(named).toEqual(['add', 'sub', 'cmp'])
    expect(pairsOf('flags-and-jumps')).toEqual([
      ['`ZF` = 1:', 'the result is 0'],
      ['`SF` = 1:', 'it is negative (top bit 1)'],
      ['`CF` = 1:', 'it did not fit, unsigned'],
      ['`OF` = 1:', 'it did not fit, signed'],
    ])
  })

  it('agrees with the emulator for every instruction it names, on pairs of bytes', () => {
    // 16 values that include every edge: 0, the biggest signed, the smallest signed, 255.
    const samples = [
      0, 1, 2, 5, 0x3f, 0x40, 0x7e, 0x7f, 0x80, 0x81, 0xc0, 0xfd, 0xfe, 0xff, 100, 200,
    ]
    for (const op of named) {
      for (const a of samples) {
        for (const b of samples) {
          // `cmp` works out a − b like `sub`, and only keeps the flags.
          const unsigned = op === 'add' ? a + b : a - b
          const signed =
            op === 'add'
              ? toSigned(BigInt(a), 8) + toSigned(BigInt(b), 8)
              : toSigned(BigInt(a), 8) - toSigned(BigInt(b), 8)
          expectTheFourLines(flagsAfter(op, a, b), unsigned, signed, `${op} ${a}, ${b}`)
        }
      }
    }
  })

  it('inc and dec leave CF alone: the classic traps', () => {
    expect(lineStarting('flags-and-jumps', '`inc`')).toBe('`inc` and `dec` leave CF alone.')

    // 0xff + 1 = 0x100 does not fit in a byte: al becomes 0, yet CF stays 0.
    const wrapped = afterSteps('mov al, 0xff\ninc al\nret\n', 2).getSnapshot()
    expect(wrapped.registers.rax & 0xffn).toBe(0n)
    expect(wrapped.flags).toMatchObject({ CF: 0, ZF: 1 })

    // After a carry, 1 + 1 = 2 fits, yet CF stays 1.
    const carried = afterSteps('mov bl, 0xff\nadd bl, 2\ninc bl\nret\n', 3).getSnapshot()
    expect(carried.registers.rbx & 0xffn).toBe(2n)
    expect(carried.flags.CF).toBe(1)

    // 0 − 1 does not fit as an unsigned number: al becomes 0xff, yet CF stays 0.
    const borrowed = afterSteps('mov al, 0\ndec al\nret\n', 2).getSnapshot()
    expect(borrowed.registers.rax & 0xffn).toBe(0xffn)
    expect(borrowed.flags).toMatchObject({ CF: 0, SF: 1 })
  })

  it('inc and dec leave CF alone for every byte, and set ZF, SF and OF as the lines say', () => {
    for (const op of ['inc', 'dec'] as const) {
      const change = op === 'inc' ? 1 : -1
      for (const carry of [0, 1] as const) {
        for (let a = 0; a <= 0xff; a++) {
          const { flags } = afterSteps(`mov al, ${a}\n${op} al\nret\n`, 2, {
            initialFlags: { CF: carry },
          }).getSnapshot()
          const label = `${op} ${a} with CF = ${carry} before`
          expect(flags.CF, label).toBe(carry)
          expectZfSfOf(flags, a + change, toSigned(BigInt(a), 8) + BigInt(change), label)
        }
      }
    }
  })

  it('does not say the four lines for imul, because there CF means something else', () => {
    // 2^62 × 2 = 2^63 fits in 64 bits as an unsigned number, yet `imul` sets CF = 1:
    // for `imul`, CF = 1 means that the SIGNED result did not fit.
    expect(named).not.toContain('imul')
    const source = 'mov rax, 0x4000000000000000\nmov rbx, 2\nimul rax, rbx\nret\n'
    const { registers, flags } = afterSteps(source, 3).getSnapshot()
    expect(registers.rax).toBe(1n << 63n)
    expect(flags.CF).toBe(1)
  })
})

describe('jumps after cmp a, b', () => {
  const HOLDS: Record<string, (a: bigint, b: bigint) => boolean> = {
    'a = b': (a, b) => a === b,
    'a ≠ b': (a, b) => a !== b,
    'a > b': (a, b) => a > b,
    'a ≥ b': (a, b) => a >= b,
    'a < b': (a, b) => a < b,
    'a ≤ b': (a, b) => a <= b,
  }

  it('lists the ten jumps of the course', () => {
    expect(JUMP_ROWS.map((row) => [row.formula, row.signed, row.unsigned])).toEqual([
      ['a = b', 'je', 'je'],
      ['a ≠ b', 'jne', 'jne'],
      ['a > b', 'jg', 'ja'],
      ['a ≥ b', 'jge', 'jae'],
      ['a < b', 'jl', 'jb'],
      ['a ≤ b', 'jle', 'jbe'],
    ])
  })

  it('names each comparison in the words the emulator uses for its jumps', () => {
    const SIGNS: Record<string, string> = {
      equal: '=',
      'not equal': '≠',
      'greater than': '>',
      'greater than or equal': '≥',
      'less than': '<',
      'less than or equal': '≤',
    }
    for (const row of JUMP_ROWS) {
      expect(row.formula, row.words).toBe(`a ${SIGNS[row.words]} b`)
      for (const [jump, kind] of [
        [row.signed, 'signed'],
        [row.unsigned, 'unsigned'],
      ] as const) {
        expect(JUMP_CONDITIONS, jump).toContain(jump)
        const { meaning } = describeCondition(jump)
        // "equal" and "not equal" are one test for both kinds: "equal (or zero)".
        if (row.signed === row.unsigned) {
          expect(meaning.startsWith(`${row.words} (or `), `${jump}: "${meaning}"`).toBe(true)
        } else {
          expect(meaning, jump).toBe(`${row.words} (${kind})`)
        }
      }
    }
  })

  it('each jump jumps exactly when its comparison is true', () => {
    const samples = [0, 1, 2, 0x7e, 0x7f, 0x80, 0x81, 0xfe, 0xff]
    for (const a of samples) {
      for (const b of samples) {
        const source = `mov al, ${a}\nmov bl, ${b}\ncmp al, bl\nret\n`
        const { flags } = afterSteps(source, 3).getSnapshot()
        for (const row of JUMP_ROWS) {
          const compare = HOLDS[row.formula]
          const label = `${row.formula} with a = ${a}, b = ${b}`
          expect(conditionHolds(row.unsigned, flags), `${row.unsigned}: ${label}`).toBe(
            compare(BigInt(a), BigInt(b)),
          )
          expect(conditionHolds(row.signed, flags), `${row.signed}: ${label}`).toBe(
            compare(toSigned(BigInt(a), 8), toSigned(BigInt(b), 8)),
          )
        }
      }
    }
  })

  it('a jump in a real program goes the way the table says', () => {
    // -1 against 1: smaller as a signed number, bigger as an unsigned one.
    const program = (jump: string): string =>
      [
        'mov eax, -1',
        'cmp eax, 1',
        `${jump} taken`,
        'mov ecx, 0',
        'ret',
        'taken:',
        'mov ecx, 1',
        'ret',
      ]
        .join('\n')
        .concat('\n')
    const taken = (jump: string): bigint => afterSteps(program(jump), 4).getSnapshot().registers.rcx
    expect(taken('jl')).toBe(1n)
    expect(taken('jg')).toBe(0n)
    expect(taken('jb')).toBe(0n)
    expect(taken('ja')).toBe(1n)
    expect(taken('jne')).toBe(1n)
    expect(taken('je')).toBe(0n)
  })
})

/* ──────────────────────────── Stack, rip, call, ret ──────────────────────────── */

describe('stack, rip, call, ret', () => {
  it('says the six lines', () => {
    expect(pairsOf('stack')).toEqual([
      ['`push`:', 'rsp − 8, then store'],
      ['`pop`:', 'load, then rsp + 8'],
      ['`rip`:', 'address of the NEXT instruction (address + size)'],
      ['`call`:', 'push the return address, then jump'],
      ['`ret`:', 'pop into rip'],
    ])
    expect(linesOf('stack')).toEqual(['The stack grows down.'])
  })

  it('push: rsp − 8, then store. The stack grows down.', () => {
    const emulator = emulatorOf('mov rax, 0x1111\npush rax\nret\n')
    emulator.step()
    const before = emulator.getSnapshot().registers.rsp
    emulator.step()
    const after = emulator.getSnapshot().registers.rsp
    expect(after).toBe(before - 8n)
    expect(after < before, 'a push makes rsp smaller').toBe(true)
    expect(boxAt(emulator, after)).toBe(0x1111n)
  })

  it('pop: load, then rsp + 8', () => {
    const emulator = afterSteps('mov rax, 0x1111\npush rax\npop rbx\nret\n', 2)
    const before = emulator.getSnapshot().registers.rsp
    emulator.step()
    const { registers } = emulator.getSnapshot()
    expect(registers.rbx).toBe(0x1111n)
    expect(registers.rsp).toBe(before + 8n)
  })

  it('rip: the address of the next instruction, which is address + size', () => {
    const emulator = emulatorOf('mov eax, 7\nmov rbx, rax\nadd rbx, 1\nret\n')
    const { instructions } = emulator.program
    for (const index of [0, 1, 2]) {
      const { address, size } = instructions[index]
      // Before the step, rip already points at the instruction that runs next.
      expect(emulator.getSnapshot().rip).toBe(address)
      emulator.step()
      expect(emulator.getSnapshot().rip).toBe(address + BigInt(size))
      expect(emulator.getSnapshot().rip).toBe(instructions[index + 1].address)
    }
  })

  it('call: push the return address, then jump. ret: pop into rip.', () => {
    const emulator = emulatorOf('main:\ncall f\nmov ecx, 1\nret\nf:\nmov eax, 7\nret\n')
    const [call, afterCall, , first] = emulator.program.instructions
    const rspBefore = emulator.getSnapshot().registers.rsp

    emulator.step()
    const inFunction = emulator.getSnapshot()
    // The return address is the address of the instruction after the call.
    expect(afterCall.address).toBe(call.address + BigInt(call.size))
    expect(inFunction.registers.rsp).toBe(rspBefore - 8n)
    expect(boxAt(emulator, inFunction.registers.rsp)).toBe(afterCall.address)
    expect(inFunction.rip).toBe(first.address)

    emulator.step()
    emulator.step()
    const back = emulator.getSnapshot()
    expect(back.rip).toBe(afterCall.address)
    expect(back.registers.rsp).toBe(rspBefore)
  })
})

/* ──────────────────────────────── Calling convention ──────────────────────────────── */

describe('calling convention', () => {
  const [argumentsText, resultText] = meaningOf('calling-convention', 'Arguments').split('Result:')
  const argumentRegisters = registersIn(argumentsText)
  const resultRegisters = registersIn(resultText)
  const restored = registersIn(meaningOf('calling-convention', 'Must be restored'))
  const mayChange = registersIn(meaningOf('calling-convention', 'May change in any call'))
  const opening = codeIn(meaningOf('calling-convention', 'Opening lines'))
  const closing = codeIn(meaningOf('calling-convention', 'Closing lines'))

  it('names the registers', () => {
    expect(argumentRegisters).toEqual(['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9'])
    expect(resultRegisters).toEqual(['rax'])
    // rsp too: the System V ABI lists it, and a teacher may ask for it.
    expect(restored).toEqual(['rbx', 'rbp', 'r12', 'r13', 'r14', 'r15', 'rsp'])
    expect(mayChange).toEqual(['rax', 'rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11'])
  })

  it('puts every register in exactly one of the two lists', () => {
    expect([...restored, ...mayChange].sort()).toEqual([...REG64_NAMES].sort())
    for (const name of [...argumentRegisters, ...resultRegisters]) expect(mayChange).toContain(name)
  })

  it('printf takes its arguments from the argument registers, in this order', () => {
    const source = [
      'format:',
      '    .string "%d %d %d %d %d"',
      'main:',
      '    lea rdi, format[rip]',
      '    mov eax, 0',
      '    call printf@PLT',
      '    ret',
    ].join('\n')
    const [, ...numbers] = argumentRegisters
    const initialRegisters = Object.fromEntries(
      numbers.map((name, index) => [name, BigInt(index + 1)]),
    )
    const emulator = emulatorOf(source, { initialRegisters })
    emulator.run()
    expect(emulator.getSnapshot().output).toBe('1 2 3 4 5')
    // The result comes back in rax: printf returns how many characters it printed.
    expect(emulator.getSnapshot().registers.rax).toBe(9n)
  })

  it('a library call changes only registers that may change, and leaves the others alone', () => {
    const source = [
      'message:',
      '    .string "hi"',
      'main:',
      '    lea rdi, message[rip]',
      '    call printf@PLT',
      '    ret',
    ].join('\n')
    // Every register starts with its own number, and rsp is lined up for the call.
    const initialRegisters: Partial<Record<Reg64, bigint>> = {}
    for (const [index, name] of REG64_NAMES.entries()) {
      if (name !== 'rsp') initialRegisters[name] = 0x1000n + BigInt(index)
    }
    const emulator = emulatorOf(source, {
      initialRegisters,
      initialRsp: DEFAULT_OPTIONS.stackBase - 16n,
    })
    emulator.step()
    const before = emulator.getSnapshot().registers
    emulator.step()
    emulator.step()
    const after = emulator.getSnapshot().registers
    expect(emulator.getSnapshot().output).toBe('hi')

    for (const name of restored) expect(after[name], `${name} is restored`).toBe(before[name])
    expect(after.rsp, 'rsp is back where it was').toBe(before.rsp)
    // The emulator puts junk in every register that a real call may change.
    for (const name of mayChange) expect(after[name], `${name} changed`).not.toBe(before[name])
  })

  /** A `main` that follows the sheet: the opening lines, `extra` lines, printf, the closing lines. */
  function framedProgram(k: number, extra: readonly string[] = []): string {
    return [
      'message:',
      '    .string "x"',
      'main:',
      ...opening.map((line) => `    ${line.replace('16·k', String(16 * k))}`),
      ...extra.map((line) => `    ${line}`),
      '    lea rdi, message[rip]',
      '    mov eax, 0',
      '    call printf@PLT',
      '    mov eax, 0',
      ...closing.map((line) => `    ${line}`),
    ].join('\n')
  }

  /** Run until the `call` is the line that runs next. */
  function runUntilTheCall(emulator: Emulator, source: string): void {
    const callLine = source.split('\n').findIndex((line) => line.includes('call')) + 1
    while (emulator.getSnapshot().nextLine !== callLine) {
      expect(emulator.step().error).toBeNull()
    }
  }

  it('shows the opening and the closing lines', () => {
    expect(opening).toEqual(['push rbp', 'mov rbp, rsp', 'sub rsp, 16·k'])
    expect(closing).toEqual(['mov rsp, rbp', 'pop rbp', 'ret'])
    expect(lineStarting('calling-convention', 'k =')).toBe(
      'k = 1, 2, 3 … so that rsp ends in 0 before a `call` (no other `push`).',
    )
  })

  it.each([1, 2, 3])(
    'with k = %i, rsp ends in 0 before the call, and the function cleans up',
    (k) => {
      const source = framedProgram(k)
      const emulator = emulatorOf(source, { initialRegisters: { rbp: 0xabcdn } })
      const start = emulator.getSnapshot().registers

      runUntilTheCall(emulator, source)
      const atCall = emulator.getSnapshot().registers
      expect(atCall.rsp % 16n, 'rsp is a multiple of 16').toBe(0n)
      expect(atCall.rsp.toString(16).endsWith('0'), 'rsp ends in 0 in hex').toBe(true)
      expect(atCall.rsp).toBe(start.rsp - 8n - BigInt(16 * k))
      // The call itself brings no warning.
      expect(emulator.step().notes.filter((note) => note.kind === 'warning')).toEqual([])

      const end = emulator.run()
      expect(end.reason).toBe('halted')
      const finish = emulator.getSnapshot()
      expect(finish.output).toBe('x')
      expect(finish.registers.rbp, 'rbp is restored').toBe(0xabcdn)
      // The last `ret` popped the return address that was on top when main began.
      expect(finish.registers.rsp).toBe(start.rsp + 8n)
    },
  )

  it('needs "no other push": one more push leaves rsp ending in 8 before the call', () => {
    // Lesson 14 saves rbx with a `push` at the start of a function. That push moves rsp
    // by 8 more, so the rule of the sheet no longer gives a multiple of 16.
    expect(lineStarting('calling-convention', 'k =')).toContain('(no other `push`)')
    const source = framedProgram(1, ['push rbx'])
    const emulator = emulatorOf(source)
    runUntilTheCall(emulator, source)
    const { rsp } = emulator.getSnapshot().registers
    expect(rsp % 16n).toBe(8n)
    expect(rsp.toString(16).endsWith('8'), 'rsp ends in 8 in hex').toBe(true)
    // The emulator warns at the call, as it does on every call that is not lined up.
    const warnings = emulator.step().notes.filter((note) => note.kind === 'warning')
    expect(warnings.map((note) => note.text).join(' ')).toContain('not a multiple of 16')
  })
})

/* ──────────────────────────────── The hex ladder ──────────────────────────────── */

describe('counting down by 8 in hex', () => {
  it('goes from 00 down to 78, 8 at a time', () => {
    expect(HEX_LADDER.join(' ')).toBe('00 f8 f0 e8 e0 d8 d0 c8 c0 b8 b0 a8 a0 98 90 88 80 78')
    let value = 0x200
    for (const step of HEX_LADDER) {
      expect(step).toBe((value & 0xff).toString(16).padStart(2, '0'))
      value -= 8
    }
  })

  it('follows the rule in the text', () => {
    const [rule] = linesOf('hex-ladder')
    expect(rule).toBe(
      'The last digit goes 0, 8, 0, 8. When it goes from 0 to 8, the digit before it goes down by one (after 0 comes f).',
    )
    const last = HEX_LADDER.map((step) => step[1])
    const before = HEX_LADDER.map((step) => parseInt(step[0], 16))
    for (let index = 0; index < HEX_LADDER.length; index++) {
      expect(last[index]).toBe(index % 2 === 0 ? '0' : '8')
      if (index === 0) continue
      // The digit before the last one goes down on every second step: when the last
      // digit goes from 0 to 8. After 0 it is f (15).
      const goesDown = last[index] === '8'
      const expected = goesDown ? (before[index - 1] + 15) % 16 : before[index - 1]
      expect(before[index], HEX_LADDER[index]).toBe(expected)
    }
  })

  it('gives the value of each hex letter', () => {
    const line = lineStarting('hex-ladder', 'a =')
    const pairs = [...line.matchAll(/([a-f]) = (\d+)/g)].map((match) => [
      match[1],
      Number(match[2]),
    ])
    expect(pairs.map(([letter]) => letter).join('')).toBe('abcdef')
    for (const [letter, value] of pairs) expect(parseInt(String(letter), 16)).toBe(value)
  })

  it('shows the classic trap with the right answer', () => {
    expect(HEX_TRAP).toEqual({ start: '0x200', right: '0x1f8', wrong: '0x192' })
    expect(BigInt(HEX_TRAP.start) - 8n).toBe(BigInt(HEX_TRAP.right))
    expect(BigInt(HEX_TRAP.wrong)).not.toBe(BigInt(HEX_TRAP.right))
    expect(lineStarting('hex-ladder', 'Trap')).toBe('Trap: `0x200 − 8 = 0x1f8` (not `0x192`)')
  })

  it('matches what rsp does on the stack', () => {
    // Four pushes from an address that ends in 00: f8, f0, e8, e0.
    const source = 'push rax\npush rax\npush rax\npush rax\nret\n'
    const emulator = emulatorOf(source, { initialRsp: 0x7ffffffde000n })
    const seen = [emulator.getSnapshot().registers.rsp]
    for (let step = 0; step < 4; step++) {
      emulator.step()
      seen.push(emulator.getSnapshot().registers.rsp)
    }
    expect(seen.map((rsp) => rsp.toString(16).slice(-2))).toEqual(HEX_LADDER.slice(0, 5))
  })
})
