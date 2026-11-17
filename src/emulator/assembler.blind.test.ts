/**
 * Black-box tests for `assemble()`.
 *
 * These tests were written from the written behaviour contract only (plus PLAN.md,
 * `types.ts`, `registers.ts` and `bits.ts`), without looking at how the assembler was
 * built. Every expected number was worked out by hand from the rules in the contract. The
 * instruction sizes were also checked against the real x86-64 encodings: the bytes are in
 * the comments, and the lengths in section 7 were compared with what a real assembler
 * (clang, x86-64 target) produces for the same lines. They all agree. (clang cannot read
 * the two lines that write `movsx` with a 32-bit source, which gcc and GNU `as` accept;
 * the same instruction written as `movsxd` agrees.)
 *
 * Some tests build many inputs with a small seeded generator and compare the result with
 * a second, independent calculation written in this file (the jump-size rule, constant
 * expressions, memory operands, data addresses, the operand-rule table). The seeds are
 * fixed, so every run tests the same inputs.
 *
 * Layout of this file: one `describe` block per area of the contract, numbered 1 to 11.
 */
import { describe, expect, it } from 'vitest'
import { assemble } from './assembler'
import { ALL_REGISTER_NAMES, lookupRegister } from './registers'
import {
  LIBRARY_FUNCTIONS,
  MNEMONICS,
  REG64_NAMES,
  type AssembleCode,
  type AssembleResult,
  type DataItem,
  type Diagnostic,
  type EmulatorOptions,
  type ImmOperand,
  type Instruction,
  type MemOperand,
  type Mnemonic,
  type Operand,
  type OperandSize,
  type Program,
  type RegOperand,
  type SymbolInfo,
  type TargetOperand,
} from './types'

/* ════════════════════════════════ Helpers ════════════════════════════════ */

const HEADER = '.intel_syntax noprefix'

/** `message` is the first read-only item, so it sits at 0x402010. */
const RODATA = ['.section .rodata', 'message: .string "hi"', '.text']
/** `array` is the first writable item (0x404030, 24 bytes). `counter` follows it (0x404048). */
const DATA = ['.data', 'array: .quad 1, 2, 3', 'counter: .long 7', '.text']
const EQUS = ['.equ count, -8', '.equ size, 8']

/** Joins source lines. Argument N is line N of the program. */
function src(...lines: string[]): string {
  return lines.join('\n') + '\n'
}

/**
 * A complete small program around one statement:
 *
 *     .intel_syntax noprefix
 *     (the `before` lines)
 *     main:
 *         STATEMENT
 *         ret
 */
function around(statement: string, before: string[] = []): string {
  return src(HEADER, ...before, 'main:', `    ${statement}`, '    ret')
}

/** The line number of STATEMENT in `around(statement, before)`. */
function lineOf(before: string[] = []): number {
  return before.length + 3
}

function hex(value: bigint): string {
  return value < 0n ? `-0x${(-value).toString(16)}` : `0x${value.toString(16)}`
}

/** Text for failure messages (a bigint cannot go through JSON.stringify directly). */
function show(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === 'bigint' ? hex(item) : item),
    2,
  )
}

function at<T>(list: readonly T[], index: number): T {
  const item = list.at(index)
  if (item === undefined) {
    throw new Error(`Nothing at position ${index} of a list of ${list.length}`)
  }
  return item
}

/** Assembles a program that must be correct, and returns it. */
function ok(source: string, options?: EmulatorOptions): Program {
  const result = assemble(source, options)
  if (!result.ok) {
    throw new Error(
      `This program should assemble:\n${source}\nbut assemble() reported:\n${show(result.diagnostics)}`,
    )
  }
  return result.program
}

/** Assembles a program that must be rejected, and returns its errors (warnings left out). */
function errorsOf(source: string): Diagnostic[] {
  const result = assemble(source)
  if (result.ok) {
    throw new Error(`This program should be rejected, but it assembled:\n${source}`)
  }
  expect(result.program).toBeNull()
  const errors = result.diagnostics.filter((d) => d.severity === 'error')
  expect(errors.length, 'a failed result holds at least one error').toBeGreaterThan(0)
  return errors
}

function firstError(source: string): Diagnostic {
  return at(errorsOf(source), 0)
}

/** What the contract promises about every message. */
function expectFriendly(d: Diagnostic): void {
  const prefix = d.line > 0 ? `Line ${d.line}: ` : ''
  expect(d.message.startsWith(prefix), `should start with "${prefix}": ${d.message}`).toBe(true)
  const body = d.message.slice(prefix.length)
  // A real sentence: several words, and no leftovers of a broken template.
  expect(body.trim().split(/\s+/).length, `not a sentence: ${d.message}`).toBeGreaterThanOrEqual(3)
  expect(body).not.toMatch(/\[object |\bNaN\b|\$\{/)
  if (d.code !== 'undefined-symbol') expect(body).not.toMatch(/\bundefined\b/)
  // Code is wrapped in backticks, so backticks come in pairs.
  expect((body.match(/`/g) ?? []).length % 2, `unpaired backtick: ${d.message}`).toBe(0)
}

/** The program must have exactly one error: this code, on this line, with a friendly message. */
function onlyError(source: string, code: AssembleCode, line: number): Diagnostic {
  const errors = errorsOf(source)
  expect(
    errors.map((e) => `${e.code} on line ${e.line}`),
    show(errors),
  ).toEqual([`${code} on line ${line}`])
  const error = at(errors, 0)
  expectFriendly(error)
  return error
}

/** Like `onlyError`, for the places where the contract does not name one exact code. */
function onlyErrorAmong(source: string, codes: AssembleCode[], line: number): Diagnostic {
  const errors = errorsOf(source)
  expect(
    errors.map((e) => e.line),
    show(errors),
  ).toEqual([line])
  const error = at(errors, 0)
  expect(codes, show(error)).toContain(error.code)
  expectFriendly(error)
  return error
}

/** The first instruction of `around(statement, before)`. */
function one(statement: string, before: string[] = []): Instruction {
  return at(ok(around(statement, before)).instructions, 0)
}

function operandAt(ins: Instruction, position: number): Operand {
  const operand = ins.operands.at(position)
  if (operand === undefined) {
    throw new Error(`\`${ins.text}\` has no operand ${position}: ${show(ins.operands)}`)
  }
  return operand
}

function regAt(ins: Instruction, position: number): RegOperand {
  const operand = operandAt(ins, position)
  if (operand.kind !== 'reg') throw new Error(`Expected a register, got ${show(operand)}`)
  return operand
}

function immAt(ins: Instruction, position: number): ImmOperand {
  const operand = operandAt(ins, position)
  if (operand.kind !== 'imm') throw new Error(`Expected a number, got ${show(operand)}`)
  return operand
}

function memAt(ins: Instruction, position: number): MemOperand {
  const operand = operandAt(ins, position)
  if (operand.kind !== 'mem') throw new Error(`Expected a memory operand, got ${show(operand)}`)
  return operand
}

function targetAt(ins: Instruction, position: number): TargetOperand {
  const operand = operandAt(ins, position)
  if (operand.kind !== 'target') throw new Error(`Expected a jump target, got ${show(operand)}`)
  return operand
}

function symbolOf(program: Program, name: string): SymbolInfo {
  const found = program.symbols.get(name)
  if (!found) {
    throw new Error(`No symbol \`${name}\`. Symbols: ${[...program.symbols.keys()].join(', ')}`)
  }
  return found
}

function dataOf(program: Program, label: string): DataItem {
  const found = program.data.find((item) => item.label === label)
  if (!found) throw new Error(`No data item with the label \`${label}\`: ${show(program.data)}`)
  return found
}

/** What section 4 of the contract promises about every program, whatever the source was. */
function expectSoundProgram(program: Program, diagnostics: Diagnostic[]): void {
  const { instructions, layout, symbols } = program
  expect(instructions.length).toBeGreaterThan(0)
  expect(program.warnings).toEqual(diagnostics)

  // Instructions are placed one after another, and both maps know every one of them.
  let address = layout.textBase
  for (const [index, ins] of instructions.entries()) {
    expect(ins.index).toBe(index)
    expect(ins.address).toBe(address)
    expect(ins.size).toBeGreaterThan(0)
    expect(program.addressToIndex.get(ins.address)).toBe(index)
    expect(program.lineToIndex.get(ins.line)).toBe(index)
    address += BigInt(ins.size)
  }
  expect(layout.textEnd).toBe(address)
  expect(program.addressToIndex.size).toBe(instructions.length)
  expect(program.lineToIndex.size).toBe(instructions.length)

  // The entry is `main` when it is a code label, else the first instruction and a warning.
  const main = symbols.get('main')
  if (main?.kind === 'code') {
    expect(program.entryLabel).toBe('main')
    expect(program.entry).toBe(main.address)
  } else {
    expect(program.entryLabel).toBeNull()
    expect(program.entry).toBe(at(instructions, 0).address)
    expect(diagnostics.filter((d) => d.code === 'no-main').map((d) => d.line)).toEqual([0])
  }

  for (const ins of instructions) {
    for (const operand of ins.operands) {
      if (operand.kind === 'mem') {
        // The address of the label in the operand is the address of that symbol.
        const symbol = operand.symbol === null ? undefined : symbols.get(operand.symbol)
        expect(operand.symbolAddress).toBe(operand.symbol === null ? 0n : symbol?.address)
      }
      if (operand.kind === 'target') {
        // A target is a library function or a label of the program.
        if (operand.external) {
          expect(Object.values(LIBRARY_FUNCTIONS)).toContain(operand.address)
        } else {
          expect(symbols.get(operand.name)?.address).toBe(operand.address)
        }
        if (ins.mnemonic !== 'call') {
          // A jump is short or long, and a short jump always reaches its label.
          const distance = operand.address - (ins.address + BigInt(ins.size))
          expect([2, ins.mnemonic === 'jmp' ? 5 : 6]).toContain(ins.size)
          if (ins.size === 2) expect(distance >= -128n && distance <= 127n).toBe(true)
        }
      }
    }
  }

  // Every data item lies inside the area of its section.
  for (const item of program.data) {
    const [start, end] =
      item.section === 'data'
        ? [layout.dataBase, layout.dataEnd]
        : [layout.rodataBase, layout.rodataEnd]
    expect(item.address >= start && item.address + BigInt(item.bytes.length) <= end).toBe(true)
    expect(item.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)).toBe(
      true,
    )
  }
}

/** The parts of a memory operand that the contract describes. */
interface MemShape {
  size: MemOperand['size']
  base: MemOperand['base']
  index: MemOperand['index']
  /** Only compared when there is an index (without one the scale has no meaning). */
  scale: MemOperand['scale'] | null
  disp: bigint
  symbol: string | null
  symbolAddress: bigint
  equNames: string[]
}

function shape(m: MemOperand): MemShape {
  return {
    size: m.size,
    base: m.base,
    index: m.index,
    scale: m.index === null ? null : m.scale,
    disp: m.disp,
    symbol: m.symbol,
    symbolAddress: m.symbolAddress,
    equNames: m.equNames,
  }
}

const PLAIN_MEMORY: MemShape = {
  size: null,
  base: null,
  index: null,
  scale: null,
  disp: 0n,
  symbol: null,
  symbolAddress: 0n,
  equNames: [],
}

interface Case {
  statement: string
  before: string[]
}

/** Table rows: a statement, or a statement with the lines it needs before `main:`. */
function cases(...rows: (string | [statement: string, before: string[]])[]): Case[] {
  return rows.map((row) =>
    typeof row === 'string'
      ? { statement: row, before: [] }
      : { statement: row[0], before: row[1] },
  )
}

/** One test per statement: the statement is rejected with exactly this error code. */
function itRejects(code: AssembleCode, ...rows: (string | [string, string[]])[]): void {
  it.each(cases(...rows))(`\`$statement\` is rejected with ${code}`, ({ statement, before }) => {
    onlyError(around(statement, before), code, lineOf(before))
  })
}

/** One test per statement: the statement is accepted without any diagnostic. */
function itAccepts(...rows: (string | [string, string[]])[]): void {
  it.each(cases(...rows))('`$statement` is accepted', ({ statement, before }) => {
    const result = assemble(around(statement, before))
    expect(result.diagnostics, show(result.diagnostics)).toEqual([])
    expect(result.ok).toBe(true)
  })
}

function nops(count: number): string[] {
  return Array.from({ length: count }, () => '    nop')
}

/** A small seeded generator (mulberry32), so every run tests the same inputs. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(random: () => number, list: readonly T[]): T {
  return at(list, Math.floor(random() * list.length))
}

/** A whole number from `low` to `high`, both included. */
function between(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1))
}

/** A number written the way a student might write it: decimal, hex in both cases, or binary. */
function writeNumber(random: () => number, value: bigint): string {
  const digits = value < 0n ? -value : value
  const style = random()
  const text =
    style < 0.5
      ? digits.toString(10)
      : style < 0.75
        ? `0x${digits.toString(16)}`
        : style < 0.9
          ? `0X${digits.toString(16).toUpperCase()}`
          : `0b${digits.toString(2)}`
  return value < 0n ? `-${text}` : text
}

/* ═══════════════════════════ 1. Operand forms ═══════════════════════════ */

describe('1. Operand forms', () => {
  interface MemCase {
    form: string
    before?: string[]
    want: Partial<MemShape>
  }

  const MEMORY_FORMS: MemCase[] = [
    { form: '[rax]', want: { base: 'rax' } },
    { form: '[rbp]', want: { base: 'rbp' } },
    { form: '[rsp]', want: { base: 'rsp' } },
    { form: '[r15]', want: { base: 'r15' } },
    { form: '[RAX]', want: { base: 'rax' } },
    { form: '[rbp-8]', want: { base: 'rbp', disp: -8n } },
    { form: '[RBP-8]', want: { base: 'rbp', disp: -8n } },
    { form: '[rbp+16]', want: { base: 'rbp', disp: 16n } },
    { form: '[rbp-0x10]', want: { base: 'rbp', disp: -16n } },
    { form: '[rbp+8-16]', want: { base: 'rbp', disp: -8n } },
    { form: '-8[rbp]', want: { base: 'rbp', disp: -8n } },
    { form: '8[rsp]', want: { base: 'rsp', disp: 8n } },
    { form: '0x18[rsp]', want: { base: 'rsp', disp: 24n } },
    { form: 'count[rbp]', before: EQUS, want: { base: 'rbp', disp: -8n, equNames: ['count'] } },
    { form: 'count+8[rbp]', before: EQUS, want: { base: 'rbp', disp: 0n, equNames: ['count'] } },
    { form: '[rbp+count]', before: EQUS, want: { base: 'rbp', disp: -8n, equNames: ['count'] } },
    { form: '[rbp-size]', before: EQUS, want: { base: 'rbp', disp: -8n, equNames: ['size'] } },
    {
      form: 'message[rip]',
      before: RODATA,
      want: { base: 'rip', symbol: 'message', symbolAddress: 0x402010n },
    },
    {
      form: '[rip+message]',
      before: RODATA,
      want: { base: 'rip', symbol: 'message', symbolAddress: 0x402010n },
    },
    {
      form: 'counter[rip]',
      before: DATA,
      want: { base: 'rip', symbol: 'counter', symbolAddress: 0x404048n },
    },
    {
      form: 'array+8[rip]',
      before: DATA,
      want: { base: 'rip', symbol: 'array', symbolAddress: 0x404030n, disp: 8n },
    },
    { form: '[rax+rbx*8+16]', want: { base: 'rax', index: 'rbx', scale: 8, disp: 16n } },
    { form: '[rbx+rax]', want: { base: 'rbx', index: 'rax', scale: 1 } },
    { form: '[rbx+rax*1]', want: { base: 'rbx', index: 'rax', scale: 1 } },
    { form: '[8*rcx]', want: { index: 'rcx', scale: 8 } },
    { form: '[rcx*8]', want: { index: 'rcx', scale: 8 } },
    { form: '[rbx+4*rcx]', want: { base: 'rbx', index: 'rcx', scale: 4 } },
    { form: '[rbx+rcx*4-4]', want: { base: 'rbx', index: 'rcx', scale: 4, disp: -4n } },
    { form: '[rax+rax*2]', want: { base: 'rax', index: 'rax', scale: 2 } },
    { form: '[rdi+rcx*8]', want: { base: 'rdi', index: 'rcx', scale: 8 } },
    { form: '[r12+r13*2+8]', want: { base: 'r12', index: 'r13', scale: 2, disp: 8n } },
    {
      form: 'array[rax*8]',
      before: DATA,
      want: { index: 'rax', scale: 8, symbol: 'array', symbolAddress: 0x404030n },
    },
    {
      form: '[array+rax*8]',
      before: DATA,
      want: { index: 'rax', scale: 8, symbol: 'array', symbolAddress: 0x404030n },
    },
    {
      form: 'array[rbx]',
      before: DATA,
      want: { base: 'rbx', symbol: 'array', symbolAddress: 0x404030n },
    },
    // A bare data label is a memory operand at that address.
    { form: 'counter', before: DATA, want: { symbol: 'counter', symbolAddress: 0x404048n } },
    // The same label inside brackets, alone and with a number.
    { form: '[counter]', before: DATA, want: { symbol: 'counter', symbolAddress: 0x404048n } },
    {
      form: '[counter+4]',
      before: DATA,
      want: { symbol: 'counter', symbolAddress: 0x404048n, disp: 4n },
    },
    // The terms of the sum may come in any order.
    { form: '[16+rax]', want: { base: 'rax', disp: 16n } },
    { form: '[rbx*8+rax]', want: { base: 'rax', index: 'rbx', scale: 8 } },
    { form: '[8*rbx+rax+16]', want: { base: 'rax', index: 'rbx', scale: 8, disp: 16n } },
    // A code label may be used in a memory operand too.
    { form: 'main[rip]', want: { base: 'rip', symbol: 'main', symbolAddress: 0x401126n } },
  ]

  describe('every memory form', () => {
    it.each(MEMORY_FORMS)('`mov rax, $form` (memory is the source)', ({ form, before, want }) => {
      const ins = one(`mov rax, ${form}`, before)
      expect(regAt(ins, 0).reg.name).toBe('rax')
      expect(shape(memAt(ins, 1))).toEqual({ ...PLAIN_MEMORY, ...want })
    })

    it.each(MEMORY_FORMS)(
      '`mov $form, rax` (memory is the destination)',
      ({ form, before, want }) => {
        const ins = one(`mov ${form}, rax`, before)
        expect(shape(memAt(ins, 0))).toEqual({ ...PLAIN_MEMORY, ...want })
        expect(regAt(ins, 1).reg.name).toBe('rax')
      },
    )
  })

  describe('sizes written with `ptr`', () => {
    interface SizedCase {
      form: string
      reg: string
      size: OperandSize
      before?: string[]
    }

    const SIZED: SizedCase[] = [
      { form: 'byte ptr [rax]', reg: 'al', size: 8 },
      { form: 'word ptr [rax]', reg: 'ax', size: 16 },
      { form: 'dword ptr [rax]', reg: 'eax', size: 32 },
      { form: 'qword ptr [rax]', reg: 'rax', size: 64 },
      { form: 'BYTE PTR [rax]', reg: 'al', size: 8 },
      { form: 'Word Ptr [rax]', reg: 'ax', size: 16 },
      { form: 'dWoRd pTr [rax]', reg: 'eax', size: 32 },
      { form: 'QWORD ptr [rax]', reg: 'rax', size: 64 },
      { form: 'DWORD PTR [RBP-4]', reg: 'eax', size: 32 },
      { form: 'DWORD PTR -4[rbp]', reg: 'eax', size: 32 },
      { form: 'QWORD PTR count[rbp]', reg: 'rax', size: 64, before: EQUS },
      { form: 'BYTE PTR message[rip]', reg: 'al', size: 8, before: RODATA },
      { form: 'QWORD PTR array[rax*8]', reg: 'rax', size: 64, before: DATA },
      { form: 'DWORD PTR counter[rip]', reg: 'eax', size: 32, before: DATA },
      { form: 'dword ptr counter', reg: 'eax', size: 32, before: DATA },
    ]

    it.each(SIZED)('`mov $reg, $form` has size $size', ({ form, reg, size, before }) => {
      const ins = one(`mov ${reg}, ${form}`, before)
      expect(memAt(ins, 1).size).toBe(size)
      expect(ins.opSize).toBe(size)
    })

    it.each(SIZED)('`mov $form, 1` has size $size', ({ form, size, before }) => {
      const ins = one(`mov ${form}, 1`, before)
      expect(memAt(ins, 0).size).toBe(size)
      expect(immAt(ins, 1).value).toBe(1n)
      expect(ins.opSize).toBe(size)
    })

    it('the size is null when no `ptr` is written', () => {
      const ins = one('mov eax, [rbp-4]')
      expect(memAt(ins, 1).size).toBeNull()
      // The width then comes from the register.
      expect(ins.opSize).toBe(32)
    })

    it('a size word does not change the rest of the operand', () => {
      const ins = one('mov eax, dword ptr [rax+rbx*4+12]')
      expect(shape(memAt(ins, 1))).toEqual({
        ...PLAIN_MEMORY,
        size: 32,
        base: 'rax',
        index: 'rbx',
        scale: 4,
        disp: 12n,
      })
    })
  })

  describe('whitespace', () => {
    it('extra spaces around every part do not change the operand', () => {
      const ins = one('mov   rax ,   [ rbp - 8 ]')
      expect(regAt(ins, 0).reg.name).toBe('rax')
      expect(shape(memAt(ins, 1))).toEqual({ ...PLAIN_MEMORY, base: 'rbp', disp: -8n })
    })

    it('spaces inside a base + index*scale + number form', () => {
      const ins = one('mov rax, [ rax + rbx * 8 + 16 ]')
      expect(shape(memAt(ins, 1))).toEqual({
        ...PLAIN_MEMORY,
        base: 'rax',
        index: 'rbx',
        scale: 8,
        disp: 16n,
      })
    })

    it('several spaces between the size word, `ptr` and the bracket', () => {
      const ins = one('mov eax,   dword    ptr    [rbp-4]')
      expect(shape(memAt(ins, 1))).toEqual({ ...PLAIN_MEMORY, size: 32, base: 'rbp', disp: -4n })
    })

    it('tabs work like spaces', () => {
      const program = ok(
        src(
          HEADER,
          'main:',
          '\tmov\trax,\t[rbp\t-\t8]',
          '\tmov\teax,\tDWORD\tPTR\t[rbp-4]',
          '\tlea\trdi,\t8[rsp]',
          '\tret',
        ),
      )
      expect(program.instructions).toHaveLength(4)
      expect(shape(memAt(at(program.instructions, 0), 1))).toEqual({
        ...PLAIN_MEMORY,
        base: 'rbp',
        disp: -8n,
      })
      expect(shape(memAt(at(program.instructions, 1), 1))).toEqual({
        ...PLAIN_MEMORY,
        size: 32,
        base: 'rbp',
        disp: -4n,
      })
      expect(shape(memAt(at(program.instructions, 2), 1))).toEqual({
        ...PLAIN_MEMORY,
        base: 'rsp',
        disp: 8n,
      })
    })

    it('spaces at the end of the line and a comment after the operand', () => {
      const ins = one('mov rax, [rbp-8]     # load the local   ')
      expect(shape(memAt(ins, 1))).toEqual({ ...PLAIN_MEMORY, base: 'rbp', disp: -8n })
    })
  })

  describe('the text of a memory operand', () => {
    it('is tidy and has lower-case keywords', () => {
      expect(memAt(one('MOV   EAX,DWORD PTR [RBP-4]'), 1).text).toBe('dword ptr [rbp-4]')
    })

    it('keeps the `.equ` name', () => {
      expect(memAt(one('mov rax, count[rbp]', EQUS), 1).text).toBe('count[rbp]')
    })

    it('keeps the label of a rip-relative operand', () => {
      expect(memAt(one('lea rdi, message[rip]', RODATA), 1).text).toBe('message[rip]')
    })
  })

  describe('memory operands in other instructions', () => {
    it('`lea rdi, message[rip]`', () => {
      const ins = one('lea rdi, message[rip]', RODATA)
      expect(ins.mnemonic).toBe('lea')
      expect(regAt(ins, 0).reg.name).toBe('rdi')
      expect(shape(memAt(ins, 1))).toEqual({
        ...PLAIN_MEMORY,
        base: 'rip',
        symbol: 'message',
        symbolAddress: 0x402010n,
      })
    })

    it('`cmp dword ptr [rbp-4], 10`', () => {
      const ins = one('cmp dword ptr [rbp-4], 10')
      expect(shape(memAt(ins, 0))).toEqual({ ...PLAIN_MEMORY, size: 32, base: 'rbp', disp: -4n })
      expect(immAt(ins, 1).value).toBe(10n)
    })

    it('`inc qword ptr [rax]`', () => {
      const ins = one('inc qword ptr [rax]')
      expect(ins.operands).toHaveLength(1)
      expect(shape(memAt(ins, 0))).toEqual({ ...PLAIN_MEMORY, size: 64, base: 'rax' })
    })

    it('`imul eax, [rbp-4]`', () => {
      const ins = one('imul eax, [rbp-4]')
      expect(shape(memAt(ins, 1))).toEqual({ ...PLAIN_MEMORY, base: 'rbp', disp: -4n })
    })

    it('`movzx eax, byte ptr [rdi+rcx]`', () => {
      const ins = one('movzx eax, byte ptr [rdi+rcx]')
      expect(shape(memAt(ins, 1))).toEqual({
        ...PLAIN_MEMORY,
        size: 8,
        base: 'rdi',
        index: 'rcx',
        scale: 1,
      })
    })

    it('`add total[rbp], rax` with a `.equ` name', () => {
      const ins = one('add total[rbp], rax', ['.equ total, -16'])
      expect(shape(memAt(ins, 0))).toEqual({
        ...PLAIN_MEMORY,
        base: 'rbp',
        disp: -16n,
        equNames: ['total'],
      })
    })
  })

  describe('register operands', () => {
    it.each([...ALL_REGISTER_NAMES])('`mov %s, %s` reads both registers', (name) => {
      const ins = one(`mov ${name}, ${name}`)
      const info = lookupRegister(name)
      expect(info).toBeDefined()
      expect(regAt(ins, 0).reg).toEqual(info)
      expect(regAt(ins, 1).reg).toEqual(info)
      expect(regAt(ins, 0).text).toBe(name)
      expect(ins.opSize).toBe(info?.size)
    })

    it.each([...ALL_REGISTER_NAMES])('upper-case `%s` is the same register', (name) => {
      const upper = name.toUpperCase()
      const ins = one(`MOV ${upper}, ${upper}`)
      expect(regAt(ins, 0).reg).toEqual(lookupRegister(name))
      // RegOperand.text is "as written (lower-cased)".
      expect(regAt(ins, 0).text).toBe(name)
      expect(regAt(ins, 1).text).toBe(name)
    })

    it('there are 68 register names', () => {
      expect(ALL_REGISTER_NAMES).toHaveLength(68)
    })
  })

  describe('the other operand kinds', () => {
    it('a plain number is an immediate without a symbol', () => {
      const imm = immAt(one('mov eax, 5'), 1)
      expect(imm.value).toBe(5n)
      expect(imm.symbol).toBeNull()
    })

    it('a bare `.equ` name is an immediate that remembers the name', () => {
      const imm = immAt(one('mov eax, size', EQUS), 1)
      expect(imm.value).toBe(8n)
      expect(imm.symbol).toBe('size')
    })

    it('a bare data label is a memory operand, not an immediate', () => {
      const ins = one('mov eax, counter', DATA)
      expect(operandAt(ins, 1).kind).toBe('mem')
    })

    it('a label after `jmp` is a jump target', () => {
      const target = targetAt(one('jmp main'), 0)
      expect(target.name).toBe('main')
      expect(hex(target.address)).toBe('0x401126')
      expect(target.external).toBe(false)
    })
  })

  describe('memory operands built from their parts (fixed seed)', () => {
    const INDEX_REGISTERS = REG64_NAMES.filter((name) => name !== 'rsp')
    const SIZE_WORDS: [word: string, bits: OperandSize, register: string][] = [
      ['byte', 8, 'al'],
      ['word', 16, 'ax'],
      ['dword', 32, 'eax'],
      ['qword', 64, 'rax'],
    ]

    interface Built {
      /** The whole instruction, e.g. `mov eax, DWORD PTR count[rbp+rcx*4]`. */
      statement: string
      want: MemShape
    }

    /**
     * Writes one memory operand from parts chosen at random, using only forms the contract
     * describes. In the program around it `count` is -8 and `array` is at 0x404030.
     */
    function build(random: () => number): Built {
      const upper = (text: string): string => (random() < 0.2 ? text.toUpperCase() : text)
      const want: MemShape = { ...PLAIN_MEMORY, equNames: [] }
      /** The terms inside the brackets and in front of them. Only the first has no sign. */
      const inside: string[] = []
      const prefix: string[] = []
      const add = (list: string[], sign: '+' | '-', text: string): void => {
        list.push(list.length === 0 && sign === '+' ? text : `${sign}${text}`)
      }

      // The registers: `label[rip]`, or a base and an index.
      let needsLabel = true
      if (random() < 0.2) {
        want.base = 'rip'
        add(inside, '+', 'rip')
      } else {
        const base = random() < 0.8 ? pick(random, REG64_NAMES) : null
        const index = random() < 0.45 ? pick(random, INDEX_REGISTERS) : null
        const scale = pick(random, [1, 2, 4, 8] as const)
        want.base = base
        want.index = index
        want.scale = index === null ? null : scale
        if (base !== null && index !== null && scale === 1 && random() < 0.5) {
          // A second register without `*` is an index with scale 1.
          add(inside, '+', upper(base))
          add(inside, '+', upper(index))
        } else {
          const scaled =
            index === null
              ? []
              : [random() < 0.75 ? `${upper(index)}*${scale}` : `${scale}*${upper(index)}`]
          const plain = base === null ? [] : [upper(base)]
          const registers = random() < 0.5 ? [...plain, ...scaled] : [...scaled, ...plain]
          for (const register of registers) add(inside, '+', register)
        }
        needsLabel = base === null && index === null
      }

      // The label: inside the brackets, or in front of them when something else is inside.
      if (needsLabel || random() < 0.15) {
        want.symbol = 'array'
        want.symbolAddress = 0x404030n
        if (inside.length > 0 && random() < 0.5) add(prefix, '+', 'array')
        else add(inside, '+', 'array')
      }

      // Numbers and the `.equ` name, inside the brackets or in front of them.
      const numbers = between(random, 0, 2)
      for (let i = 0; i < numbers; i++) {
        const value = BigInt(between(random, -200, 200))
        want.disp += value
        const text = writeNumber(random, value < 0n ? -value : value)
        add(random() < 0.3 ? prefix : inside, value < 0n ? '-' : '+', text)
      }
      if (random() < 0.25) {
        const minus = random() < 0.3
        want.disp += minus ? 8n : -8n
        want.equNames = ['count']
        // A name in front of the brackets is written without a sign.
        if (!minus && random() < 0.5) add(prefix, '+', 'count')
        else add(inside, minus ? '-' : '+', 'count')
      }

      // Sometimes with spaces around every sign and inside the brackets.
      let terms = inside.join('')
      if (random() < 0.3) terms = ` ${terms.replace(/[-+*]/g, ' $& ')} `
      const operand = `${prefix.join('')}[${terms}]`

      const sized = pick(random, [null, null, ...SIZE_WORDS])
      if (sized === null) return { statement: `mov rax, ${operand}`, want }
      const [word, bits, register] = sized
      want.size = bits
      return { statement: `mov ${register}, ${upper(word)} ${upper('ptr')} ${operand}`, want }
    }

    it('300 random operands come back with the parts they were written from', () => {
      const random = makeRandom(1126)
      const failures: string[] = []
      for (let i = 0; i < 300; i++) {
        const { statement, want } = build(random)
        const result = assemble(
          src(
            HEADER,
            '.equ count, -8',
            '.data',
            'array: .quad 1, 2',
            '.text',
            'main:',
            `    ${statement}`,
            '    ret',
          ),
        )
        if (!result.ok) {
          failures.push(`${statement}\n  was rejected: ${show(result.diagnostics)}`)
          continue
        }
        const got = shape(memAt(at(result.program.instructions, 0), 1))
        if (show(got) !== show(want)) {
          failures.push(`${statement}\n  want ${show(want)}\n  got  ${show(got)}`)
        }
      }
      expect(failures).toEqual([])
    })
  })
})

/* ══════════════════════════════ 2. Numbers ══════════════════════════════ */

describe('2. Numbers', () => {
  describe('literals', () => {
    const LITERALS: [literal: string, value: bigint][] = [
      ['42', 42n],
      ['0', 0n],
      ['7', 7n],
      ['1000000', 1_000_000n],
      ['0x2A', 42n],
      ['0X2a', 42n],
      ['0x2a', 42n],
      ['0xff', 255n],
      ['0xFF', 255n],
      ['0xDeadBeef', 0xdeadbeefn],
      ['0x0010', 16n],
      ['0x0', 0n],
      ['0b101', 5n],
      ['0b0101', 5n],
      ['0b11111111', 255n],
      ['-8', -8n],
      ['-1', -1n],
      ['-0x10', -16n],
      ['-0b11', -3n],
      ['+5', 5n],
      ['+0x10', 16n],
      ['0xffffffffffffffff', 0xffff_ffff_ffff_ffffn],
      ['18446744073709551615', 0xffff_ffff_ffff_ffffn],
      ['-9223372036854775808', -0x8000_0000_0000_0000n],
      ["'A'", 65n],
      ["'a'", 97n],
      ["'0'", 48n],
      ["' '", 32n],
      ["'#'", 35n],
      ["','", 44n],
      ["':'", 58n],
      ["'['", 91n],
      ["'\"'", 34n],
      [String.raw`'\n'`, 10n],
      [String.raw`'\t'`, 9n],
      [String.raw`'\r'`, 13n],
      [String.raw`'\0'`, 0n],
      [String.raw`'\\'`, 92n],
      [String.raw`'\"'`, 34n],
      [String.raw`'\''`, 39n],
    ]

    it.each(LITERALS)('`mov rax, %s`', (literal, value) => {
      const ins = one(`mov rax, ${literal}`)
      const imm = immAt(ins, 1)
      expect(imm.value).toBe(value)
      expect(imm.symbol).toBeNull()
    })

    it('a negative number keeps its sign in `ImmOperand.value`', () => {
      expect(immAt(one('mov eax, -1'), 1).value).toBe(-1n)
      expect(immAt(one('sub rsp, -16'), 1).value).toBe(-16n)
    })

    it('a character literal works as a byte to compare with', () => {
      const ins = one("cmp al, 'z'")
      expect(immAt(ins, 1).value).toBe(122n)
      expect(ins.opSize).toBe(8)
    })

    it('`#` inside a character literal does not start a comment', () => {
      const program = ok(
        src(HEADER, 'main:', "    mov al, '#'", "    cmp al, '#'   # a hash", '    ret'),
      )
      expect(program.instructions).toHaveLength(3)
      expect(immAt(at(program.instructions, 0), 1).value).toBe(35n)
      expect(immAt(at(program.instructions, 1), 1).value).toBe(35n)
    })
  })

  describe('constant expressions', () => {
    const NAMES = ['.equ count, 8', '.equ size, 4']

    const EXPRESSIONS: [expression: string, value: bigint][] = [
      ['2+3', 5n],
      ['10-4', 6n],
      ['3*4', 12n],
      ['2+3*4', 14n],
      ['2*3+4', 10n],
      ['10-2-3', 5n],
      ['10-2*3', 4n],
      ['2*3*4', 24n],
      ['1+2+3', 6n],
      ['8-4+2', 6n],
      ['4-8', -4n],
      ['0x10+0b11', 19n],
      ['count+8', 16n],
      ['2*size', 8n],
      ['size*2', 8n],
      ['size*2+1', 9n],
      ['1+size*2', 9n],
      ['count-size', 4n],
      ['count+size', 12n],
      ['count*size', 32n],
      ['0x10+count', 24n],
      ['count - size - 1', 3n],
      ['count + 8', 16n],
      ['2 * size', 8n],
    ]

    it.each(EXPRESSIONS)('`mov rax, %s`', (expression, value) => {
      expect(immAt(one(`mov rax, ${expression}`, NAMES), 1).value).toBe(value)
    })

    it('`sub rsp, 2*size` uses the value of the expression', () => {
      const ins = one('sub rsp, 2*size', ['.equ size, 8'])
      expect(immAt(ins, 1).value).toBe(16n)
      // 16 fits a signed byte, so this is the 4-byte form (48 83 EC 10).
      expect(ins.size).toBe(4)
    })

    it('an expression works as the number in front of a bracket', () => {
      const ins = one('mov rax, count+8[rbp]', ['.equ count, -16'])
      expect(memAt(ins, 1).disp).toBe(-8n)
      expect(memAt(ins, 1).equNames).toEqual(['count'])
    })

    it('an expression works inside the brackets', () => {
      const ins = one('mov rax, [rbp+count+4]', ['.equ count, -16'])
      expect(memAt(ins, 1).disp).toBe(-12n)
      expect(memAt(ins, 1).base).toBe('rbp')
    })

    it('300 random expressions have the value of an independent calculation (fixed seed)', () => {
      const random = makeRandom(2026)
      const constants: [name: string, value: bigint][] = [
        ['count', 8n],
        ['size', 4n],
        ['below', -16n],
      ]
      const failures: string[] = []
      for (let i = 0; i < 300; i++) {
        // Numbers and names joined by `+`, `-` and `*`. Only the first number may have a sign.
        const gap = random() < 0.3 ? ' ' : ''
        const values: bigint[] = []
        const operators: string[] = []
        let text = ''
        const length = between(random, 1, 6)
        for (let k = 0; k < length; k++) {
          if (k > 0) {
            const operator = pick(random, ['+', '-', '*', '+', '-'])
            operators.push(operator)
            text += `${gap}${operator}${gap}`
          }
          if (random() < 0.3) {
            const [name, value] = pick(random, constants)
            values.push(value)
            text += name
          } else {
            const digits = BigInt(between(random, 0, 300))
            const value = k === 0 && random() < 0.2 ? -digits : digits
            values.push(value)
            text += writeNumber(random, value)
          }
        }
        // The usual precedence: every `*` first, then `+` and `-` from left to right.
        const products: bigint[] = [at(values, 0)]
        const signs: bigint[] = [1n]
        operators.forEach((operator, k) => {
          const value = at(values, k + 1)
          if (operator === '*') {
            products[products.length - 1] = at(products, -1) * value
          } else {
            products.push(value)
            signs.push(operator === '+' ? 1n : -1n)
          }
        })
        const want = products.reduce((total, product, k) => total + at(signs, k) * product, 0n)

        const result = assemble(
          src(
            HEADER,
            ...constants.map(([name, value]) => `.equ ${name}, ${value}`),
            'main:',
            `    mov rax, ${text}`,
            '    ret',
          ),
        )
        if (!result.ok) {
          failures.push(`${text} = ${want} was rejected: ${show(result.diagnostics)}`)
          continue
        }
        const got = immAt(at(result.program.instructions, 0), 1).value
        if (got !== want) failures.push(`${text}: want ${want}, got ${got}`)
      }
      expect(failures).toEqual([])
    })
  })

  describe('`.equ` names', () => {
    it('`.equ`, `.set` and `name = value` all define a constant', () => {
      const program = ok(
        src(
          HEADER,
          '.equ first, 10',
          '.set second, 0x20',
          'third = -3',
          'main:',
          '    mov rax, first',
          '    mov rbx, second',
          '    mov rcx, third',
          '    ret',
        ),
      )
      expect(program.constants.get('first')).toBe(10n)
      expect(program.constants.get('second')).toBe(32n)
      expect(program.constants.get('third')).toBe(-3n)
      expect(program.constants.size).toBe(3)
      const [a, b, c] = [0, 1, 2].map((i) => immAt(at(program.instructions, i), 1))
      expect([a?.value, b?.value, c?.value]).toEqual([10n, 32n, -3n])
      expect([a?.symbol, b?.symbol, c?.symbol]).toEqual(['first', 'second', 'third'])
    })

    it.each<[string, bigint]>([
      ['.equ k, 42', 42n],
      ['.equ k, -8', -8n],
      ['.equ k, 0x10', 16n],
      ['.equ k, 0b1000', 8n],
      [".equ k, 'A'", 65n],
      ['.equ k, 2+3*4', 14n],
      ['.EQU k, 5', 5n],
      ['.Set k, 6', 6n],
      ['k = 7', 7n],
      ['k = 0x10 + 1', 17n],
    ])('`%s` gives the value', (definition, value) => {
      const program = ok(src(HEADER, definition, 'main:', '    mov rax, k', '    ret'))
      expect(program.constants.get('k')).toBe(value)
      expect(immAt(at(program.instructions, 0), 1).value).toBe(value)
    })

    it('a `.equ` value may use an earlier `.equ` name', () => {
      const program = ok(
        src(HEADER, '.equ slot, 8', '.equ frame, slot*4', 'main:', '    sub rsp, frame', '    ret'),
      )
      expect(program.constants.get('frame')).toBe(32n)
      expect(immAt(at(program.instructions, 0), 1).value).toBe(32n)
    })

    it('a `.equ` name may be used before the line that defines it', () => {
      const program = ok(
        src(
          HEADER, // 1
          'main:', // 2
          '    mov eax, count', // 3
          '    sub rsp, size*2', // 4
          '    mov rax, slot[rbp]', // 5
          '    ret', // 6
          '.equ count, 5', // 7
          '.equ size, 8', // 8
          'slot = -16', // 9
        ),
      )
      expect(immAt(at(program.instructions, 0), 1).value).toBe(5n)
      expect(immAt(at(program.instructions, 1), 1).value).toBe(16n)
      const mem = memAt(at(program.instructions, 2), 1)
      expect(mem.disp).toBe(-16n)
      expect(mem.equNames).toEqual(['slot'])
      expect(mem.base).toBe('rbp')
    })

    it('a `.equ` value may use a `.equ` name that is defined on a later line', () => {
      const program = ok(
        src(HEADER, '.equ frame, slot*4', '.equ slot, 8', 'main:', '    sub rsp, frame', '    ret'),
      )
      expect(program.constants.get('frame')).toBe(32n)
      expect(immAt(at(program.instructions, 0), 1).value).toBe(32n)
    })

    it('a chain of ten constants, each one defined by the name on the next line', () => {
      // c0 = c1+1, c1 = c2+1, ... c8 = c9+1, c9 = 0: every name is used before its own line.
      const chain = Array.from({ length: 9 }, (_, i) => `.equ c${i}, c${i + 1}+1`)
      const program = ok(src(HEADER, ...chain, '.equ c9, 0', 'main:', '    mov eax, c0', '    ret'))
      expect(program.constants.size).toBe(10)
      expect(program.constants.get('c0')).toBe(9n)
      expect(program.constants.get('c5')).toBe(4n)
      expect(immAt(at(program.instructions, 0), 1).value).toBe(9n)
    })

    it('a data value may use a `.equ` name that is defined on a later line', () => {
      const program = ok(
        src(
          HEADER,
          '.data',
          'value: .quad later, later*2',
          '.equ later, 5',
          '.text',
          'main:',
          '    ret',
        ),
      )
      expect(dataOf(program, 'value').bytes).toEqual([
        5, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0,
      ])
    })

    it('`.equ` works in the data section too and takes no space', () => {
      const program = ok(
        src(
          HEADER,
          '.data',
          'first: .quad 1',
          '.equ answer, 42',
          'second: .quad 2',
          '.text',
          'main:',
          '    mov eax, answer',
          '    ret',
        ),
      )
      expect(program.constants.get('answer')).toBe(42n)
      expect(hex(dataOf(program, 'first').address)).toBe('0x404030')
      expect(hex(dataOf(program, 'second').address)).toBe('0x404038')
      expect(program.data).toHaveLength(2)
    })

    it('an unknown name in an expression is `undefined-symbol`', () => {
      onlyError(around('mov eax, missing+8'), 'undefined-symbol', 3)
    })
  })

  describe('`offset`', () => {
    it.each([
      'offset message',
      'OFFSET message',
      'Offset message',
      'OFFSET FLAT:message',
      'offset flat:message',
      'Offset Flat:message',
    ])('`mov rdi, %s` is the address of the data label', (operand) => {
      const ins = one(`mov rdi, ${operand}`, RODATA)
      const imm = immAt(ins, 1)
      expect(hex(imm.value)).toBe('0x402010')
      expect(imm.symbol).toBe('message')
      // The address fits signed 32 bits: REX.W C7 /0 imm32 = 7 bytes.
      expect(ins.size).toBe(7)
    })

    it('`mov edi, OFFSET FLAT:message` is the 5-byte form', () => {
      const ins = one('mov edi, OFFSET FLAT:message', RODATA)
      expect(hex(immAt(ins, 1).value)).toBe('0x402010')
      expect(ins.size).toBe(5)
    })

    it('`offset` of a label in `.data`', () => {
      const imm = immAt(one('mov rsi, offset counter', DATA), 1)
      expect(hex(imm.value)).toBe('0x404048')
      expect(imm.symbol).toBe('counter')
    })

    it('`offset` of a code label', () => {
      const imm = immAt(one('mov rax, offset main'), 1)
      expect(hex(imm.value)).toBe('0x401126')
      expect(imm.symbol).toBe('main')
    })

    it('`offset` of a label that is defined later in the file', () => {
      const program = ok(
        src(HEADER, 'main:', '    mov rdi, offset text', '    ret', '.data', 'text: .string "x"'),
      )
      expect(hex(immAt(at(program.instructions, 0), 1).value)).toBe('0x404030')
    })

    it('`offset` of an unknown label is `undefined-symbol`', () => {
      onlyError(around('mov rdi, offset missing'), 'undefined-symbol', 3)
    })
  })

  describe('numbers that are errors', () => {
    describe('a leading zero', () => {
      itRejects(
        'bad-number',
        'mov eax, 010',
        'mov eax, 08',
        'mov eax, 007',
        'sub rsp, 016',
        'mov rax, [rbp-08]',
        'mov rax, 08[rbp]',
        'push 010',
        '.equ k, 010',
        // "A leading zero and more digits", with and without a sign in front.
        'mov eax, 00',
        'mov eax, -010',
        'mov eax, +08',
      )

      it('`.quad 010` in the data section', () => {
        onlyError(
          src(HEADER, '.data', 'x: .quad 010', '.text', 'main:', '    ret'),
          'bad-number',
          3,
        )
      })

      it('the message says to remove the zero', () => {
        const error = onlyError(around('mov eax, 010'), 'bad-number', 3)
        expect(error.message).toMatch(/zero|`0`|octal/i)
      })

      it('a single `0` and hex or binary digits that start with 0 are fine', () => {
        expect(immAt(one('mov eax, 0'), 1).value).toBe(0n)
        expect(immAt(one('mov eax, 0x010'), 1).value).toBe(16n)
        expect(immAt(one('mov eax, 0b010'), 1).value).toBe(2n)
      })
    })

    describe('junk that starts with a digit', () => {
      itRejects(
        'bad-number',
        'mov eax, 12abc',
        'mov eax, 0xZZ',
        'mov eax, 1Fh',
        'mov eax, 0x',
        'mov eax, 0b12',
        'mov eax, 9a',
        'mov eax, 0b',
        'add rsp, 16h',
        'mov rax, [rbp-8x]',
      )
    })
  })
})

/* ═════════════════════════════ 3. Directives ═════════════════════════════ */

describe('3. Directives', () => {
  /** A program whose data lines come right after `sectionLine`. The first data line is line 3. */
  function withData(sectionLine: string, ...dataLines: string[]): Program {
    return ok(src(HEADER, sectionLine, ...dataLines, '.text', 'main:', '    ret'))
  }

  /** Every data byte of the program, in address order. */
  function allBytes(program: Program): number[] {
    return [...program.data]
      .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
      .flatMap((item) => item.bytes)
  }

  describe('`.intel_syntax noprefix`', () => {
    it('is accepted, and the program has no warning', () => {
      const result = assemble(src(HEADER, 'main:', '    ret'))
      expect(result.ok).toBe(true)
      expect(result.diagnostics).toEqual([])
    })

    it('a program without it still assembles, with `missing-intel-syntax` on line 0', () => {
      const result = assemble(src('main:', '    ret'))
      expect(result.ok).toBe(true)
      expect(result.diagnostics.map((d) => [d.severity, d.code, d.line])).toEqual([
        ['warning', 'missing-intel-syntax', 0],
      ])
      expect(at(result.diagnostics, 0).message.trim().split(/\s+/).length).toBeGreaterThanOrEqual(3)
    })

    it('counts wherever it is written in the program', () => {
      const result = assemble(src('main:', '    ret', HEADER))
      expect(result.ok).toBe(true)
      expect(result.diagnostics.map((d) => d.code)).not.toContain('missing-intel-syntax')
    })

    it('the directive name may be written in upper case', () => {
      const result = assemble(src('.INTEL_SYNTAX noprefix', 'main:', '    ret'))
      expect(result.ok).toBe(true)
      expect(result.diagnostics).toEqual([])
    })

    it('a comment may follow it', () => {
      const result = assemble(src('.intel_syntax noprefix   # Intel syntax', 'main:', '    ret'))
      expect(result.ok).toBe(true)
      expect(result.diagnostics).toEqual([])
    })

    it('a line that is only a comment does not count as having it', () => {
      const result = assemble(src('# .intel_syntax noprefix', 'main:', '    ret'))
      expect(result.ok).toBe(true)
      expect(result.diagnostics.map((d) => [d.severity, d.code, d.line])).toEqual([
        ['warning', 'missing-intel-syntax', 0],
      ])
    })
  })

  describe('section switches', () => {
    it.each([
      ['.data', 'data'],
      ['.DATA', 'data'],
      ['.section .data', 'data'],
      ['.section .data.rel.local,"aw"', 'data'],
      ['.bss', 'data'],
      ['.section .bss', 'data'],
      ['.rodata', 'rodata'],
      ['.section .rodata', 'rodata'],
      ['.section\t.rodata', 'rodata'],
      ['.SECTION .rodata', 'rodata'],
      ['.section .rodata.str1.1,"aMS",@progbits,1', 'rodata'],
      ['.text', 'rodata'],
      ['.section .text', 'rodata'],
    ])('data written after `%s` goes to the %s area', (sectionLine, area) => {
      const result = assemble(
        src(HEADER, sectionLine, 'value: .quad 7', '.text', 'main:', '    ret'),
      )
      expect(result.diagnostics, show(result.diagnostics)).toEqual([])
      if (!result.ok) throw new Error('expected ok')
      const item = at(result.program.data, 0)
      expect(item.section).toBe(area)
      expect(hex(item.address)).toBe(area === 'data' ? '0x404030' : '0x402010')
      expect(symbolOf(result.program, 'value').kind).toBe('data')
    })

    it('`.text` after `.data` goes back to code', () => {
      const program = ok(
        src(
          HEADER, // 1
          '.data', // 2
          'value: .quad 7', // 3
          '.text', // 4
          'main:', // 5
          '    mov rax, value[rip]', // 6
          '    ret', // 7
        ),
      )
      expect(program.instructions).toHaveLength(2)
      expect(hex(at(program.instructions, 0).address)).toBe('0x401126')
      expect(symbolOf(program, 'main').kind).toBe('code')
    })

    it('`.section .text` after `.data` goes back to code', () => {
      const program = ok(src(HEADER, '.data', 'v: .quad 7', '.section .text', 'main:', '    ret'))
      expect(program.instructions).toHaveLength(1)
    })

    it('the program can switch sections many times', () => {
      const program = ok(
        src(
          HEADER, // 1
          '.data', // 2
          'a: .quad 1', // 3   data   0x404030
          '.section .rodata', // 4
          'b: .quad 2', // 5   rodata 0x402010
          '.section .data', // 6
          'c: .quad 3', // 7   data   0x404038
          '.text', // 8
          'd: .quad 4', // 9   rodata 0x402018 (data written in .text is read-only)
          '.bss', // 10
          'e: .zero 8', // 11  data   0x404040
          '.rodata', // 12
          'f: .quad 6', // 13  rodata 0x402020
          '.text', // 14
          'main:', // 15
          '    ret', // 16
        ),
      )
      const placed = Object.fromEntries(
        ['a', 'b', 'c', 'd', 'e', 'f'].map((label) => {
          const item = dataOf(program, label)
          return [label, `${item.section} ${hex(item.address)}`]
        }),
      )
      expect(placed).toEqual({
        a: 'data 0x404030',
        b: 'rodata 0x402010',
        c: 'data 0x404038',
        d: 'rodata 0x402018',
        e: 'data 0x404040',
        f: 'rodata 0x402020',
      })
      expect(hex(program.layout.rodataEnd)).toBe('0x402028')
      expect(hex(program.layout.dataEnd)).toBe('0x404048')
    })

    it('`.section .note.GNU-stack` is ignored without a diagnostic', () => {
      const result = assemble(
        src(HEADER, 'main:', '    ret', '.section .note.GNU-stack,"",@progbits'),
      )
      expect(result.ok).toBe(true)
      expect(result.diagnostics).toEqual([])
    })

    it('an unknown section name gives a warning and is treated as read-only data', () => {
      const result = assemble(
        src(HEADER, '.section .mystuff', 'value: .quad 7', '.text', 'main:', '    ret'),
      )
      if (!result.ok) throw new Error(`expected ok: ${show(result.diagnostics)}`)
      expect(result.diagnostics.map((d) => [d.severity, d.code, d.line])).toEqual([
        ['warning', 'unknown-directive', 2],
      ])
      expectFriendly(at(result.diagnostics, 0))
      const item = dataOf(result.program, 'value')
      expect(item.section).toBe('rodata')
      expect(hex(item.address)).toBe('0x402010')
    })
  })

  describe('directives that are accepted and change nothing', () => {
    itAccepts(
      '.globl main',
      '.global main',
      '.GLOBL main',
      '.type main, @function',
      '.type\tmain, @function',
      '.text',
      '.intel_syntax noprefix',
    )

    it('`.globl` does not change the program', () => {
      const plain = ok(src(HEADER, 'main:', '    mov eax, 1', '    ret'))
      const withGlobl = ok(
        src(HEADER, '.globl main', '.type main, @function', 'main:', '    mov eax, 1', '    ret'),
      )
      expect(withGlobl.instructions.map((i) => [i.text, i.address, i.size])).toEqual(
        plain.instructions.map((i) => [i.text, i.address, i.size]),
      )
      expect(hex(withGlobl.entry)).toBe(hex(plain.entry))
    })
  })

  describe('directives that are silently ignored', () => {
    itAccepts(
      '.file "hello.c"',
      '.ident "GCC: (GNU) 13.2.0"',
      '.size main, .-main',
      '.align 8',
      '.p2align 4',
      '.p2align 4,,10',
      '.balign 16',
      '.cfi_startproc',
      '.cfi_endproc',
      '.cfi_def_cfa_offset 16',
      '.cfi_offset 6, -16',
      '.cfi_def_cfa_register 6',
      '.cfi_def_cfa 7, 8',
      '.loc 1 5 0',
      '.weak helper',
      '.local buffer',
      '.addrsig',
      '.addrsig_sym main',
      '.FILE "hello.c"',
    )

    // Changed by the emulator owner (M8, content audit ABOUT-1): `.comm` makes a variable,
    // so skipping it quietly left a later `buffer[rip]` with only "not defined". It is a
    // warning on its own line now, with the `.data` line to write instead.
    it.each(['.comm buffer, 16, 8', '.lcomm buffer, 16'])(
      '`%s` is skipped with a warning on its line, and the program still assembles',
      (line) => {
        const result = assemble(around(line))
        if (!result.ok) throw new Error(`expected ok: ${show(result.diagnostics)}`)
        expect(result.diagnostics.map((d) => [d.severity, d.code, d.line])).toEqual([
          ['warning', 'unknown-directive', 3],
        ])
        expect(at(result.diagnostics, 0).message).toContain('`buffer: .zero 16`')
        expectFriendly(at(result.diagnostics, 0))
      },
    )

    it('`.align` adds no padding between data items', () => {
      const program = withData('.data', 'a: .byte 1', '.align 8', 'b: .quad 2')
      expect(hex(dataOf(program, 'a').address)).toBe('0x404030')
      expect(hex(dataOf(program, 'b').address)).toBe('0x404031')
    })
  })

  describe('unknown directives', () => {
    it.each(['.foobar 1, 2', '.thing', '.code64', '.macro push_all'])(
      '`%s` gives a warning on its line, and the program still assembles',
      (line) => {
        const result = assemble(around(line))
        if (!result.ok) throw new Error(`expected ok: ${show(result.diagnostics)}`)
        expect(result.diagnostics.map((d) => [d.severity, d.code, d.line])).toEqual([
          ['warning', 'unknown-directive', 3],
        ])
        expectFriendly(at(result.diagnostics, 0))
        expect(result.program.warnings).toEqual(result.diagnostics)
        // The directive is ignored: the program is just `ret`.
        expect(result.program.instructions.map((i) => i.text)).toEqual(['ret'])
        expect(result.program.data).toEqual([])
      },
    )
  })

  describe('strings', () => {
    it('`.string` stores the bytes of the text and then a 0 byte', () => {
      const program = withData('.section .rodata', 'greeting:', '    .string "Hi!"')
      expect(program.data).toHaveLength(1)
      expect(at(program.data, 0)).toMatchObject({
        label: 'greeting',
        line: 4,
        section: 'rodata',
        address: 0x402010n,
        directive: '.string',
        elementSize: 1,
        bytes: [72, 105, 33, 0],
        text: 'Hi!',
      })
    })

    it('`.asciz` is the same as `.string`', () => {
      const item = at(withData('.section .rodata', 's: .asciz "abc"').data, 0)
      expect(item.bytes).toEqual([97, 98, 99, 0])
      expect(item.text).toBe('abc')
      expect(item.directive).toBe('.asciz')
      expect(item.elementSize).toBe(1)
    })

    it('`.ascii` has no 0 byte at the end', () => {
      const item = at(withData('.section .rodata', 's: .ascii "abc"').data, 0)
      expect(item.bytes).toEqual([97, 98, 99])
      expect(item.text).toBe('abc')
      expect(item.directive).toBe('.ascii')
    })

    it('the item after an `.ascii` starts right behind its last byte', () => {
      const program = withData('.section .rodata', 'a: .ascii "abc"', 'b: .string "d"')
      expect(hex(dataOf(program, 'b').address)).toBe('0x402013')
      expect(allBytes(program)).toEqual([97, 98, 99, 100, 0])
    })

    it.each<[string, number[], string]>([
      [String.raw`"a\nb"`, [97, 10, 98], 'a\nb'],
      [String.raw`"a\tb"`, [97, 9, 98], 'a\tb'],
      [String.raw`"a\rb"`, [97, 13, 98], 'a\rb'],
      [String.raw`"a\0b"`, [97, 0, 98], 'a\0b'],
      [String.raw`"a\\b"`, [97, 92, 98], 'a\\b'],
      [String.raw`"a\"b"`, [97, 34, 98], 'a"b'],
      [String.raw`"a\'b"`, [97, 39, 98], "a'b"],
      [String.raw`"\n"`, [10], '\n'],
      [String.raw`"\\"`, [92], '\\'],
      [String.raw`"\\n"`, [92, 110], '\\n'],
      [String.raw`"%d\n"`, [37, 100, 10], '%d\n'],
      [String.raw`"\"quoted\""`, [34, 113, 117, 111, 116, 101, 100, 34], '"quoted"'],
    ])('the escapes in `.string %s`', (literal, bytes, text) => {
      const item = at(withData('.section .rodata', `s: .string ${literal}`).data, 0)
      expect(item.bytes).toEqual([...bytes, 0])
      expect(item.text).toBe(text)
    })

    it.each<[string, string]>([
      ['"Total: %d"', 'Total: %d'],
      ['"a, b, c"', 'a, b, c'],
      ['"a#b"', 'a#b'],
      ['"100% # done"', '100% # done'],
      ['"a;b"', 'a;b'],
      ['"see http://x /* y */"', 'see http://x /* y */'],
      ['"$5 and %rax"', '$5 and %rax'],
      ['"[rax]"', '[rax]'],
      ['"it\'s"', "it's"],
      ['"  two  spaces  "', '  two  spaces  '],
      ['"MiXeD Case"', 'MiXeD Case'],
      ['"mov eax, 010"', 'mov eax, 010'],
      ['""', ''],
    ])('special characters inside `.string %s` are plain text', (literal, text) => {
      const result = assemble(
        src(HEADER, '.section .rodata', `s: .string ${literal}`, '.text', 'main:', '    ret'),
      )
      expect(result.diagnostics, show(result.diagnostics)).toEqual([])
      if (!result.ok) throw new Error('expected ok')
      const item = at(result.program.data, 0)
      expect(item.text).toBe(text)
      expect(item.bytes).toEqual([...Array.from(text, (c) => c.charCodeAt(0)), 0])
    })

    it('a comment may follow a string', () => {
      const item = at(withData('.section .rodata', 's: .string "a#b"   # the text').data, 0)
      expect(item.text).toBe('a#b')
      expect(item.bytes).toEqual([97, 35, 98, 0])
    })

    it.each<[string, number[]]>([
      ['é', [0xc3, 0xa9]],
      ['ñ', [0xc3, 0xb1]],
      ['日本', [0xe6, 0x97, 0xa5, 0xe6, 0x9c, 0xac]],
      ['€', [0xe2, 0x82, 0xac]],
      ['😀', [0xf0, 0x9f, 0x98, 0x80]],
    ])('text is stored as UTF-8 bytes: "%s"', (text, bytes) => {
      const item = at(withData('.section .rodata', `s: .string "${text}"`).data, 0)
      expect(item.bytes).toEqual([...bytes, 0])
      expect(item.text).toBe(text)
    })

    it('several strings on one line each get their own 0 byte', () => {
      const program = withData('.section .rodata', 's: .string "a", "b"', 'next: .byte 7')
      expect(allBytes(program)).toEqual([97, 0, 98, 0, 7])
      expect(hex(dataOf(program, 's').address)).toBe('0x402010')
      expect(hex(dataOf(program, 'next').address)).toBe('0x402014')
    })

    it('several `.ascii` strings on one line are joined without 0 bytes', () => {
      const program = withData('.section .rodata', 's: .ascii "ab", "cd"')
      expect(allBytes(program)).toEqual([97, 98, 99, 100])
    })

    it('directive names are not case-sensitive', () => {
      const program = withData('.section .rodata', 's: .STRING "Ab"', 't: .Ascii "c"')
      expect(allBytes(program)).toEqual([65, 98, 0, 99])
    })

    describe('bad strings', () => {
      itRejects(
        'bad-string',
        '.string "abc',
        String.raw`.string "a\qb"`,
        String.raw`.string "a\zb"`,
        '.asciz "no end',
        '.ascii "no end',
        String.raw`.string "ends with a backslash\"`,
      )
    })
  })

  describe('numbers in data', () => {
    interface NumberCase {
      line: string
      elementSize: 1 | 2 | 4 | 8
      bytes: number[]
    }

    const FF = 0xff
    const NUMBER_DATA: NumberCase[] = [
      {
        line: '.quad 0x1122334455667788',
        elementSize: 8,
        bytes: [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11],
      },
      {
        line: '.quad 1, 2',
        elementSize: 8,
        bytes: [1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0],
      },
      { line: '.quad 258', elementSize: 8, bytes: [2, 1, 0, 0, 0, 0, 0, 0] },
      { line: '.quad -1', elementSize: 8, bytes: [FF, FF, FF, FF, FF, FF, FF, FF] },
      { line: '.quad -2', elementSize: 8, bytes: [0xfe, FF, FF, FF, FF, FF, FF, FF] },
      { line: '.quad -9223372036854775808', elementSize: 8, bytes: [0, 0, 0, 0, 0, 0, 0, 0x80] },
      {
        line: '.quad 18446744073709551615',
        elementSize: 8,
        bytes: [FF, FF, FF, FF, FF, FF, FF, FF],
      },
      { line: '.QUAD 5', elementSize: 8, bytes: [5, 0, 0, 0, 0, 0, 0, 0] },
      { line: '.long 258', elementSize: 4, bytes: [2, 1, 0, 0] },
      { line: '.long 1, 2, 3', elementSize: 4, bytes: [1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0] },
      { line: '.long -1', elementSize: 4, bytes: [FF, FF, FF, FF] },
      { line: '.long 0xdeadbeef', elementSize: 4, bytes: [0xef, 0xbe, 0xad, 0xde] },
      { line: '.long 4294967295', elementSize: 4, bytes: [FF, FF, FF, FF] },
      { line: '.long -2147483648', elementSize: 4, bytes: [0, 0, 0, 0x80] },
      { line: '.long 2+3*4', elementSize: 4, bytes: [14, 0, 0, 0] },
      { line: '.int 258', elementSize: 4, bytes: [2, 1, 0, 0] },
      { line: '.int -2', elementSize: 4, bytes: [0xfe, FF, FF, FF] },
      { line: '.word 0x1234', elementSize: 2, bytes: [0x34, 0x12] },
      { line: '.word 1, 2', elementSize: 2, bytes: [1, 0, 2, 0] },
      { line: '.word 65535', elementSize: 2, bytes: [FF, FF] },
      { line: '.word -32768', elementSize: 2, bytes: [0, 0x80] },
      { line: '.short 0x1234', elementSize: 2, bytes: [0x34, 0x12] },
      { line: '.short -2', elementSize: 2, bytes: [0xfe, FF] },
      { line: '.byte 1, 2, 3', elementSize: 1, bytes: [1, 2, 3] },
      { line: '.byte 0xff', elementSize: 1, bytes: [FF] },
      { line: '.byte 255', elementSize: 1, bytes: [FF] },
      { line: '.byte -1', elementSize: 1, bytes: [FF] },
      { line: '.byte -128', elementSize: 1, bytes: [0x80] },
      { line: '.byte 0b101', elementSize: 1, bytes: [5] },
      { line: ".byte 'A'", elementSize: 1, bytes: [65] },
      { line: ".byte 'H', 'i', 0", elementSize: 1, bytes: [72, 105, 0] },
    ]

    it.each(NUMBER_DATA)('`$line` is stored little-endian', ({ line, elementSize, bytes }) => {
      const program = withData('.data', `value: ${line}`)
      expect(program.data).toHaveLength(1)
      const item = at(program.data, 0)
      expect(item.bytes).toEqual(bytes)
      expect(item.elementSize).toBe(elementSize)
      expect(item.text).toBeNull()
      expect(item.label).toBe('value')
      expect(item.section).toBe('data')
      expect(hex(item.address)).toBe('0x404030')
      expect(hex(program.layout.dataEnd)).toBe(hex(0x404030n + BigInt(bytes.length)))
    })

    it('`DataItem.directive` is the directive as written', () => {
      const program = withData('.data', 'a: .quad 1', 'b: .long 2', 'c: .word 3', 'd: .byte 4')
      expect(program.data.map((item) => item.directive)).toEqual([
        '.quad',
        '.long',
        '.word',
        '.byte',
      ])
      expect(program.data.map((item) => item.line)).toEqual([3, 4, 5, 6])
    })

    it('a value may be a `.equ` name or an expression with one', () => {
      const program = withData('.data', '.equ size, 8', 'value: .quad size, size*2, size+1')
      expect(dataOf(program, 'value').bytes).toEqual([
        8, 0, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0,
      ])
    })

    describe('a value that does not fit', () => {
      it.each([
        '.byte 256',
        '.byte 1000',
        '.byte -129',
        '.byte 1, 2, 300',
        '.word 65536',
        '.word -32769',
        '.short 70000',
        '.long 4294967296',
        '.long -2147483649',
        '.int 0x100000000',
        '.quad 18446744073709551616',
        '.quad -9223372036854775809',
      ])('`%s` is rejected with immediate-too-large', (line) => {
        onlyError(
          src(HEADER, '.data', `value: ${line}`, '.text', 'main:', '    ret'),
          'immediate-too-large',
          3,
        )
      })
    })
  })

  describe('`.zero`, `.space` and `.skip`', () => {
    it.each<[string, number]>([
      ['.zero 4', 4],
      ['.zero 1', 1],
      ['.zero 16', 16],
      ['.space 3', 3],
      ['.skip 2', 2],
      ['.ZERO 8', 8],
      ['.zero 0x10', 16],
    ])('`%s` stores %i zero bytes', (line, count) => {
      const program = withData('.data', `buffer: ${line}`, 'after: .byte 1')
      const item = dataOf(program, 'buffer')
      expect(item.bytes).toEqual(Array.from({ length: count }, () => 0))
      expect(item.section).toBe('data')
      expect(hex(item.address)).toBe('0x404030')
      expect(hex(dataOf(program, 'after').address)).toBe(hex(0x404030n + BigInt(count)))
    })

    it('`.zero` in `.bss` is writable data', () => {
      const program = withData('.bss', 'buffer: .zero 32')
      const item = dataOf(program, 'buffer')
      expect(item.section).toBe('data')
      expect(item.bytes).toHaveLength(32)
      expect(hex(program.layout.dataEnd)).toBe('0x404050')
    })
  })

  describe('where data goes', () => {
    it('data written in `.text` goes to the read-only area, not into the code', () => {
      const program = ok(
        src(
          HEADER, // 1
          'main:', // 2
          '    mov eax, 1', // 3   0x401126 (5 bytes)
          'note: .string "hi"', // 4   read-only data
          '    ret', // 5   0x40112b
        ),
      )
      expect(program.instructions.map((i) => hex(i.address))).toEqual(['0x401126', '0x40112b'])
      expect(hex(program.layout.textEnd)).toBe('0x40112c')
      const item = dataOf(program, 'note')
      expect(item.section).toBe('rodata')
      expect(hex(item.address)).toBe('0x402010')
      expect(symbolOf(program, 'note')).toMatchObject({ kind: 'data', address: 0x402010n, line: 4 })
      expect(hex(program.layout.rodataEnd)).toBe('0x402013')
    })

    it('items are placed one after another in source order with no padding', () => {
      const program = withData(
        '.section .rodata',
        'a: .string "ab"', // 0x402010, 3 bytes
        'b: .quad 1', // 0x402013, 8 bytes
        'c: .byte 2', // 0x40201b, 1 byte
        'd: .long 3', // 0x40201c, 4 bytes
        'e: .word 4', // 0x402020, 2 bytes
        'f: .ascii "xyz"', // 0x402022, 3 bytes
        'g: .zero 5', // 0x402025, 5 bytes
      )
      expect(program.data.map((item) => `${item.label} ${hex(item.address)}`)).toEqual([
        'a 0x402010',
        'b 0x402013',
        'c 0x40201b',
        'd 0x40201c',
        'e 0x402020',
        'f 0x402022',
        'g 0x402025',
      ])
      expect(hex(program.layout.rodataBase)).toBe('0x402010')
      expect(hex(program.layout.rodataEnd)).toBe('0x40202a')
      expect(program.data.every((item) => item.section === 'rodata')).toBe(true)
    })

    it('read-only data and writable data are counted apart', () => {
      const program = ok(
        src(
          HEADER,
          '.section .rodata',
          'format: .string "%d\\n"', // 4 bytes
          '.data',
          'total: .quad 0', // 8 bytes
          'count: .long 3', // 4 bytes
          '.text',
          'main:',
          '    ret',
        ),
      )
      expect(program.layout).toMatchObject({
        rodataBase: 0x402010n,
        rodataEnd: 0x402014n,
        dataBase: 0x404030n,
        dataEnd: 0x40403cn,
      })
      expect(hex(dataOf(program, 'count').address)).toBe('0x404038')
    })

    it('a program without data has empty data areas', () => {
      const program = ok(src(HEADER, 'main:', '    ret'))
      expect(program.data).toEqual([])
      expect(hex(program.layout.rodataBase)).toBe('0x402010')
      expect(hex(program.layout.rodataEnd)).toBe('0x402010')
      expect(hex(program.layout.dataBase)).toBe('0x404030')
      expect(hex(program.layout.dataEnd)).toBe('0x404030')
    })

    it('`rodataBase` and `dataBase` options move the data', () => {
      const program = ok(
        src(HEADER, 'ro: .string "x"', '.data', 'rw: .quad 1', '.text', 'main:', '    ret'),
        { rodataBase: 0x500000n, dataBase: 0x600000n },
      )
      expect(hex(dataOf(program, 'ro').address)).toBe('0x500000')
      expect(hex(dataOf(program, 'rw').address)).toBe('0x600000')
      expect(program.layout).toMatchObject({
        rodataBase: 0x500000n,
        rodataEnd: 0x500002n,
        dataBase: 0x600000n,
        dataEnd: 0x600008n,
      })
    })

    it('60 random mixes of sections and data items are placed by the rules (fixed seed)', () => {
      type Area = 'text' | 'rodata' | 'data'
      const SECTIONS: [line: string, area: Area][] = [
        ['.text', 'text'],
        ['.section .text', 'text'],
        ['.rodata', 'rodata'],
        ['.section .rodata', 'rodata'],
        ['.section .rodata.str1.1,"aMS",@progbits,1', 'rodata'],
        ['.data', 'data'],
        ['.section .data', 'data'],
        ['.bss', 'data'],
        ['.section .bss', 'data'],
      ]
      const NUMBERS: [directive: string, width: number][] = [
        ['.quad', 8],
        ['.long', 4],
        ['.int', 4],
        ['.word', 2],
        ['.short', 2],
        ['.byte', 1],
      ]
      const STRINGS: [directive: string, ending: number][] = [
        ['.string', 1],
        ['.asciz', 1],
        ['.ascii', 0],
      ]

      /** One data directive, and how many bytes it takes. */
      function item(random: () => number): { text: string; bytes: number } {
        const count = between(random, 1, 4)
        const kind = random()
        if (kind < 0.5) {
          const [directive, width] = pick(random, NUMBERS)
          const values = Array.from({ length: count }, (_, i) => i + 1).join(', ')
          return { text: `${directive} ${values}`, bytes: width * count }
        }
        if (kind < 0.7) {
          return {
            text: `${pick(random, ['.zero', '.space', '.skip'])} ${count * 3}`,
            bytes: count * 3,
          }
        }
        const [directive, ending] = pick(random, STRINGS)
        return { text: `${directive} "${'x'.repeat(count * 2)}"`, bytes: count * 2 + ending }
      }

      const failures: string[] = []
      for (let seed = 1; seed <= 60; seed++) {
        const random = makeRandom(seed)
        const lines = [HEADER]
        const want: string[] = []
        let area: Area = 'text'
        let readOnly = 0x402010n
        let writable = 0x404030n
        const count = between(random, 1, 25)
        for (let k = 0; k < count; k++) {
          if (random() < 0.25) {
            const [line, next] = pick(random, SECTIONS)
            lines.push(line)
            area = next
            continue
          }
          const { text, bytes } = item(random)
          lines.push(`d${k}: ${text}`)
          // Data written in the text or rodata section is read-only data.
          if (area === 'data') {
            want.push(`d${k} data ${hex(writable)} ${bytes}`)
            writable += BigInt(bytes)
          } else {
            want.push(`d${k} rodata ${hex(readOnly)} ${bytes}`)
            readOnly += BigInt(bytes)
          }
          // Lines that take no space.
          if (random() < 0.15) {
            lines.push(
              pick(random, ['.align 8', `.equ unused${k}, 1`, '.globl main', '# note', '']),
            )
          }
        }
        lines.push('.text', 'main:', '    ret')
        want.push(`data ends at ${hex(writable)}`, `rodata ends at ${hex(readOnly)}`)

        const result = assemble(src(...lines))
        if (!result.ok) {
          failures.push(
            `seed ${seed} was rejected: ${show(result.diagnostics)}\n${lines.join('\n')}`,
          )
          continue
        }
        const { data, layout, symbols } = result.program
        const got = [
          ...data.map((d) => `${d.label} ${d.section} ${hex(d.address)} ${d.bytes.length}`),
          `data ends at ${hex(layout.dataEnd)}`,
          `rodata ends at ${hex(layout.rodataEnd)}`,
        ]
        const labels = data.every((d) => {
          const symbol = d.label === null ? undefined : symbols.get(d.label)
          return symbol?.kind === 'data' && symbol.address === d.address
        })
        if (show([...got].sort()) !== show([...want].sort()) || !labels) {
          failures.push(
            `seed ${seed}:\n${lines.join('\n')}\n  want ${show(want)}\n  got  ${show(got)}`,
          )
        }
      }
      expect(failures).toEqual([])
    })
  })

  describe('labels on data', () => {
    it('several labels may name the same item, and `DataItem.label` is the first', () => {
      const program = ok(
        src(
          HEADER, // 1
          '.data', // 2
          'first:', // 3
          'second:', // 4
          'third: .quad 7', // 5
          'other: .quad 8', // 6
          '.text', // 7
          'main:', // 8
          '    mov rax, second[rip]', // 9
          '    ret', // 10
        ),
      )
      expect(program.data).toHaveLength(2)
      expect(at(program.data, 0).label).toBe('first')
      for (const name of ['first', 'second', 'third']) {
        expect(symbolOf(program, name)).toMatchObject({ name, kind: 'data', address: 0x404030n })
      }
      expect(symbolOf(program, 'first').line).toBe(3)
      expect(symbolOf(program, 'second').line).toBe(4)
      expect(symbolOf(program, 'third').line).toBe(5)
      expect(hex(symbolOf(program, 'other').address)).toBe('0x404038')
      expect(hex(memAt(at(program.instructions, 0), 1).symbolAddress)).toBe('0x404030')
    })

    it('two labels on the same line as the item', () => {
      const program = withData('.data', 'a: b: .quad 7')
      expect(at(program.data, 0).label).toBe('a')
      expect(hex(symbolOf(program, 'a').address)).toBe('0x404030')
      expect(hex(symbolOf(program, 'b').address)).toBe('0x404030')
    })

    it('an item without a label has `label: null`', () => {
      const program = withData('.data', '    .quad 1', 'named: .quad 2')
      expect(at(program.data, 0).label).toBeNull()
      expect(at(program.data, 1).label).toBe('named')
    })

    it('a data label may be used before the line that defines it', () => {
      const program = ok(
        src(
          HEADER, // 1
          'main:', // 2
          '    lea rdi, text[rip]', // 3
          '    mov rax, number[rip]', // 4
          '    ret', // 5
          '.section .rodata', // 6
          'text: .string "later"', // 7
          '.data', // 8
          'number: .quad 5', // 9
        ),
      )
      expect(hex(memAt(at(program.instructions, 0), 1).symbolAddress)).toBe('0x402010')
      expect(hex(memAt(at(program.instructions, 1), 1).symbolAddress)).toBe('0x404030')
    })

    it('a label at the end of the data section sits at the end of the data area', () => {
      const program = ok(
        src(HEADER, '.data', 'value: .quad 1', 'end_of_data:', '.text', 'main:', '    ret'),
      )
      expect(hex(symbolOf(program, 'end_of_data').address)).toBe('0x404038')
      expect(hex(program.layout.dataEnd)).toBe('0x404038')
    })
  })

  describe('known directives with wrong arguments', () => {
    itRejects(
      'bad-directive',
      '.equ count',
      '.string',
      '.equ',
      '.set count',
      '.asciz',
      '.ascii',
      '.zero',
    )
  })

  describe('redefining a constant', () => {
    it('two `.equ` lines with the same name', () => {
      onlyError(around('.equ k, 2', ['.equ k, 1']), 'duplicate-label', 4)
    })

    it('`.set` after `.equ`', () => {
      onlyError(around('.set k, 2', ['.equ k, 1']), 'duplicate-label', 4)
    })

    it('`name = value` after `.equ`', () => {
      onlyError(around('k = 2', ['.equ k, 1']), 'duplicate-label', 4)
    })

    it('a name may not be both a constant and a label', () => {
      const errors = errorsOf(src(HEADER, '.equ value, 5', 'main:', '    ret', 'value:', '    ret'))
      expect(errors.length).toBeGreaterThan(0)
    })
  })
})

/* ═════════════════════════ 4. Labels and layout ═════════════════════════ */

describe('4. Labels and layout', () => {
  const LOOP = src(
    '.intel_syntax noprefix', // 1
    '.text', // 2
    '.globl main', // 3
    'main:', // 4
    '    mov eax, 0', // 5   0x401126  5 bytes
    '    mov ecx, 1', // 6   0x40112b  5
    'loop:', // 7
    '    add eax, ecx', // 8   0x401130  2
    '    inc ecx', // 9   0x401132  2
    '    cmp ecx, 10', // 10  0x401134  3
    '    jle loop', // 11  0x401137  2
    '    ret', // 12  0x401139  1
  )

  describe('addresses', () => {
    it('the first instruction is at 0x401126', () => {
      const program = ok(src(HEADER, 'main:', '    ret'))
      expect(hex(at(program.instructions, 0).address)).toBe('0x401126')
      expect(hex(program.layout.textBase)).toBe('0x401126')
      expect(hex(program.layout.textEnd)).toBe('0x401127')
    })

    it('each instruction starts where the one before it ends', () => {
      const program = ok(LOOP)
      expect(program.instructions.map((i) => `${hex(i.address)} ${i.size} ${i.text}`)).toEqual([
        '0x401126 5 mov eax, 0',
        '0x40112b 5 mov ecx, 1',
        '0x401130 2 add eax, ecx',
        '0x401132 2 inc ecx',
        '0x401134 3 cmp ecx, 10',
        '0x401137 2 jle loop',
        '0x401139 1 ret',
      ])
      expect(hex(program.layout.textEnd)).toBe('0x40113a')
    })

    it('`textBase` moves the code', () => {
      const program = ok(LOOP, { textBase: 0x400000n })
      expect(program.instructions.map((i) => hex(i.address))).toEqual([
        '0x400000',
        '0x400005',
        '0x40000a',
        '0x40000c',
        '0x40000e',
        '0x400011',
        '0x400013',
      ])
      expect(hex(program.layout.textBase)).toBe('0x400000')
      expect(hex(program.layout.textEnd)).toBe('0x400014')
      expect(hex(program.entry)).toBe('0x400000')
      expect(hex(symbolOf(program, 'loop').address)).toBe('0x40000a')
      expect(hex(targetAt(at(program.instructions, 5), 0).address)).toBe('0x40000a')
      expect(program.addressToIndex.get(0x40000an)).toBe(2)
      expect(program.addressToIndex.has(0x401126n)).toBe(false)
    })

    it('the three base options reach every address in the program', () => {
      const program = ok(
        src(
          HEADER, // 1
          'greeting: .string "hi"', // 2   read-only 0x500000 (3 bytes)
          '.data', // 3
          'value: .quad 1', // 4   writable  0x600000
          '.text', // 5
          'main:', // 6
          '    lea rdi, greeting[rip]', // 7   0x700000 (7)
          '    mov rax, value[rip]', // 8   0x700007 (7)
          '    mov rsi, offset value', // 9   0x70000e (7)
          '    jmp main', // 10  0x700015 (2)
        ),
        { textBase: 0x700000n, rodataBase: 0x500000n, dataBase: 0x600000n },
      )
      expect(program.instructions.map((i) => hex(i.address))).toEqual([
        '0x700000',
        '0x700007',
        '0x70000e',
        '0x700015',
      ])
      expect(hex(memAt(at(program.instructions, 0), 1).symbolAddress)).toBe('0x500000')
      expect(hex(memAt(at(program.instructions, 1), 1).symbolAddress)).toBe('0x600000')
      expect(hex(immAt(at(program.instructions, 2), 1).value)).toBe('0x600000')
      expect(hex(targetAt(at(program.instructions, 3), 0).address)).toBe('0x700000')
      expect(hex(symbolOf(program, 'greeting').address)).toBe('0x500000')
      expect(hex(symbolOf(program, 'value').address)).toBe('0x600000')
      expect(hex(program.entry)).toBe('0x700000')
      expect(program.layout).toMatchObject({
        textBase: 0x700000n,
        textEnd: 0x700017n,
        rodataBase: 0x500000n,
        rodataEnd: 0x500003n,
        dataBase: 0x600000n,
        dataEnd: 0x600008n,
      })
    })

    it('options for the running machine do not change the program', () => {
      const plain = assemble(LOOP)
      expect(assemble(LOOP, {})).toEqual(plain)
      expect(
        assemble(LOOP, {
          stackBase: 0x7000_0000n,
          initialRsp: 0x6fff_fff8n,
          maxSteps: 5,
          clobberCallerSaved: false,
          initialRegisters: { rax: 7n },
          stdin: '42\n',
        }),
      ).toEqual(plain)
    })

    it('`index` and `line` of every instruction', () => {
      const program = ok(LOOP)
      expect(program.instructions.map((i) => i.index)).toEqual([0, 1, 2, 3, 4, 5, 6])
      expect(program.instructions.map((i) => i.line)).toEqual([5, 6, 8, 9, 10, 11, 12])
    })

    it('`addressToIndex` maps every instruction address to its index', () => {
      const program = ok(LOOP)
      expect(program.addressToIndex.size).toBe(7)
      for (const ins of program.instructions) {
        expect(program.addressToIndex.get(ins.address)).toBe(ins.index)
      }
      expect(program.addressToIndex.get(0x401130n)).toBe(2)
      // An address in the middle of an instruction is not in the map.
      expect(program.addressToIndex.has(0x401127n)).toBe(false)
      expect(program.addressToIndex.has(program.layout.textEnd)).toBe(false)
    })

    it('`lineToIndex` maps each line that has an instruction to its index', () => {
      const program = ok(LOOP)
      expect([...program.lineToIndex.entries()].sort((a, b) => a[0] - b[0])).toEqual([
        [5, 0],
        [6, 1],
        [8, 2],
        [9, 3],
        [10, 4],
        [11, 5],
        [12, 6],
      ])
    })

    it('`program.source` is the text that was assembled', () => {
      expect(ok(LOOP).source).toBe(LOOP)
    })
  })

  describe('entry', () => {
    it('is `main` when the label exists', () => {
      const program = ok(LOOP)
      expect(hex(program.entry)).toBe('0x401126')
      expect(program.entryLabel).toBe('main')
      expect(program.warnings).toEqual([])
    })

    it('is `main` even when `main` is not the first instruction', () => {
      const program = ok(
        src(
          HEADER, // 1
          'helper:', // 2
          '    mov eax, 7', // 3   0x401126 (5)
          '    ret', // 4   0x40112b (1)
          'main:', // 5
          '    call helper', // 6   0x40112c (5)
          '    ret', // 7   0x401131
        ),
      )
      expect(hex(program.entry)).toBe('0x40112c')
      expect(program.entryLabel).toBe('main')
      expect(program.warnings).toEqual([])
      expect(hex(targetAt(at(program.instructions, 2), 0).address)).toBe('0x401126')
    })

    it('is the first instruction when there is no `main`, with a `no-main` warning on line 0', () => {
      const result = assemble(src(HEADER, 'start:', '    mov eax, 1', '    ret'))
      if (!result.ok) throw new Error(`expected ok: ${show(result.diagnostics)}`)
      expect(hex(result.program.entry)).toBe('0x401126')
      expect(result.program.entryLabel).toBeNull()
      expect(result.diagnostics.map((d) => [d.severity, d.code, d.line])).toEqual([
        ['warning', 'no-main', 0],
      ])
      expect(result.program.warnings).toEqual(result.diagnostics)
    })

    it('a program with no label at all starts at the first instruction', () => {
      const result = assemble(src(HEADER, '    mov eax, 1', '    ret'))
      if (!result.ok) throw new Error(`expected ok: ${show(result.diagnostics)}`)
      expect(hex(result.program.entry)).toBe('0x401126')
      expect(result.program.entryLabel).toBeNull()
      expect(result.diagnostics.map((d) => d.code)).toEqual(['no-main'])
    })

    it('labels are case-sensitive, so `Main` is not `main`', () => {
      const result = assemble(src(HEADER, 'Main:', '    ret'))
      if (!result.ok) throw new Error(`expected ok: ${show(result.diagnostics)}`)
      expect(result.program.entryLabel).toBeNull()
      expect(result.diagnostics.map((d) => d.code)).toEqual(['no-main'])
    })

    it('a data label named `main` is not an entry point', () => {
      const result = assemble(
        src(HEADER, '.data', 'main: .quad 1', '.text', 'start:', '    nop', '    ret'),
      )
      if (!result.ok) throw new Error(`expected ok: ${show(result.diagnostics)}`)
      expect(result.program.entryLabel).toBeNull()
      expect(hex(result.program.entry)).toBe('0x401126')
      expect(result.diagnostics.map((d) => d.code)).toEqual(['no-main'])
    })

    it('both whole-program warnings can appear together, each on line 0', () => {
      const result = assemble(src('start:', '    ret'))
      if (!result.ok) throw new Error(`expected ok: ${show(result.diagnostics)}`)
      expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
        'missing-intel-syntax',
        'no-main',
      ])
      expect(result.diagnostics.every((d) => d.line === 0 && d.severity === 'warning')).toBe(true)
      expect(result.program.warnings).toEqual(result.diagnostics)
    })
  })

  describe('code labels', () => {
    it('a code label is a symbol with its address and line', () => {
      const program = ok(LOOP)
      expect(symbolOf(program, 'main')).toMatchObject({
        name: 'main',
        address: 0x401126n,
        kind: 'code',
        line: 4,
      })
      expect(symbolOf(program, 'loop')).toMatchObject({
        name: 'loop',
        address: 0x401130n,
        kind: 'code',
        line: 7,
      })
      expect([...program.symbols.keys()].sort()).toEqual(['loop', 'main'])
    })

    it('a label and its instruction may share a line', () => {
      const program = ok(src(HEADER, 'main: push rbp', 'again: pop rbp', '    ret'))
      expect(program.instructions.map((i) => i.text)).toEqual(['push rbp', 'pop rbp', 'ret'])
      expect(program.instructions.map((i) => i.line)).toEqual([2, 3, 4])
      expect(symbolOf(program, 'main')).toMatchObject({ address: 0x401126n, line: 2 })
      expect(symbolOf(program, 'again')).toMatchObject({ address: 0x401127n, line: 3 })
    })

    it('several labels may name the same instruction', () => {
      const program = ok(
        src(
          HEADER, // 1
          'main:', // 2
          'start:', // 3
          'a: b: mov eax, 1', // 4
          '    jmp start', // 5
          '    jmp b', // 6
        ),
      )
      for (const name of ['main', 'start', 'a', 'b']) {
        expect(symbolOf(program, name)).toMatchObject({ kind: 'code', address: 0x401126n })
      }
      expect(hex(targetAt(at(program.instructions, 1), 0).address)).toBe('0x401126')
      expect(hex(targetAt(at(program.instructions, 2), 0).address)).toBe('0x401126')
    })

    it('a label keeps naming the next instruction across a switch to `.data` and back', () => {
      const program = ok(
        src(
          HEADER, // 1
          'main:', // 2
          '.data', // 3
          'value: .quad 1', // 4
          '.text', // 5
          '    ret', // 6
        ),
      )
      expect(symbolOf(program, 'main')).toMatchObject({ kind: 'code', address: 0x401126n })
      expect(symbolOf(program, 'value')).toMatchObject({ kind: 'data', address: 0x404030n })
      expect(program.entryLabel).toBe('main')
    })

    it('a label at the very end is a code label at `layout.textEnd`', () => {
      const program = ok(
        src(
          HEADER, // 1
          'main:', // 2
          '    jmp done', // 3   0x401126 (2)
          '    nop', // 4   0x401128 (1)
          'done:', // 5   0x401129 = textEnd
        ),
      )
      expect(hex(program.layout.textEnd)).toBe('0x401129')
      expect(symbolOf(program, 'done')).toMatchObject({ kind: 'code', address: 0x401129n, line: 5 })
      const jump = at(program.instructions, 0)
      expect(hex(targetAt(jump, 0).address)).toBe('0x401129')
      expect(jump.size).toBe(2)
    })

    it('a jump may go forward to a label that is defined later', () => {
      const program = ok(
        src(
          HEADER, // 1
          'main:', // 2
          '    cmp eax, 0', // 3   0x401126 (3)
          '    je skip', // 4   0x401129 (2)
          '    inc eax', // 5   0x40112b (2)
          'skip:', // 6
          '    ret', // 7   0x40112d
        ),
      )
      expect(hex(targetAt(at(program.instructions, 1), 0).address)).toBe('0x40112d')
      expect(targetAt(at(program.instructions, 1), 0).name).toBe('skip')
    })

    it.each(['.L2', '.LC0', '_start', 'my_label', 'my.label', 'a$b', 'Label9', '__x', 'L1'])(
      'the label name `%s` is legal',
      (name) => {
        const program = ok(src(HEADER, 'main:', `    jmp ${name}`, `${name}:`, '    ret'))
        expect(symbolOf(program, name)).toMatchObject({ kind: 'code', address: 0x401128n })
        expect(targetAt(at(program.instructions, 0), 0).name).toBe(name)
      },
    )

    it.each(['loop', 'test', 'add', 'mov', 'call', 'ret', 'nop', 'push'])(
      'a label may be named like the instruction `%s`',
      (name) => {
        const result = assemble(
          src(
            HEADER, // 1
            'main:', // 2
            '    mov eax, 0', // 3   0x401126 (5)
            `${name}:`, // 4
            '    inc eax', // 5   0x40112b (2)
            `    jmp ${name}`, // 6   0x40112d (2)
          ),
        )
        if (!result.ok) throw new Error(`expected ok: ${show(result.diagnostics)}`)
        expect(result.diagnostics).toEqual([])
        expect(symbolOf(result.program, name)).toMatchObject({ kind: 'code', address: 0x40112bn })
        const jump = at(result.program.instructions, 2)
        expect(jump.mnemonic).toBe('jmp')
        expect(targetAt(jump, 0)).toMatchObject({ name, address: 0x40112bn, external: false })
      },
    )

    it('`test:` and a `test` instruction on the same line', () => {
      const program = ok(src(HEADER, 'main:', 'test: test eax, eax', '    jne test', '    ret'))
      expect(program.instructions.map((i) => i.mnemonic)).toEqual(['test', 'jne', 'ret'])
      expect(hex(targetAt(at(program.instructions, 1), 0).address)).toBe('0x401126')
    })

    it('`call add` calls the label `add`', () => {
      const program = ok(
        src(HEADER, 'add:', '    add eax, 1', '    ret', 'main:', '    call add', '    ret'),
      )
      const call = at(program.instructions, 2)
      expect(call.mnemonic).toBe('call')
      expect(targetAt(call, 0)).toMatchObject({ name: 'add', address: 0x401126n, external: false })
    })

    it('labels are case-sensitive: `Loop` and `loop` are two labels', () => {
      const program = ok(
        src(
          HEADER, // 1
          'main:', // 2
          'Loop:', // 3
          '    nop', // 4   0x401126
          'loop:', // 5
          '    nop', // 6   0x401127
          '    jmp Loop', // 7
          '    jmp loop', // 8
        ),
      )
      expect(hex(targetAt(at(program.instructions, 2), 0).address)).toBe('0x401126')
      expect(hex(targetAt(at(program.instructions, 3), 0).address)).toBe('0x401127')
    })

    it('a jump to a label written in another letter case is `undefined-symbol`', () => {
      onlyError(src(HEADER, 'main:', 'loop:', '    nop', '    jmp LOOP'), 'undefined-symbol', 5)
    })

    it('labels may be named like built-in JavaScript properties', () => {
      const result = assemble(
        src(
          HEADER, // 1
          '.equ valueOf, 3', // 2
          'main:', // 3
          'constructor:', // 4
          '    mov eax, valueOf', // 5   0x401126 (5)
          'toString:', // 6
          '    nop', // 7   0x40112b (1)
          '__proto__:', // 8
          '    jmp toString', // 9   0x40112c (2)
          'hasOwnProperty:', // 10
          '    jmp constructor', // 11  0x40112e (2)
          '    jmp __proto__', // 12  0x401130 (2)
          '    call hasOwnProperty', // 13  0x401132 (5)
        ),
      )
      if (!result.ok) throw new Error(`expected ok: ${show(result.diagnostics)}`)
      expect(result.diagnostics).toEqual([])
      const program = result.program
      expect(hex(symbolOf(program, 'constructor').address)).toBe('0x401126')
      expect(hex(symbolOf(program, 'toString').address)).toBe('0x40112b')
      expect(hex(symbolOf(program, '__proto__').address)).toBe('0x40112c')
      expect(hex(symbolOf(program, 'hasOwnProperty').address)).toBe('0x40112e')
      expect(program.constants.get('valueOf')).toBe(3n)
      expect(immAt(at(program.instructions, 0), 1).value).toBe(3n)
      expect(program.instructions.slice(2).map((i) => hex(targetAt(i, 0).address))).toEqual([
        '0x40112b',
        '0x401126',
        '0x40112c',
        '0x40112e',
      ])
    })

    it.each(['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty'])(
      'the undefined name `%s` is reported like any other unknown name',
      (name) => {
        onlyError(around(`jmp ${name}`), 'undefined-symbol', 3)
        onlyError(around(`call ${name}`), 'undefined-symbol', 3)
        onlyError(around(`mov eax, ${name}`), 'undefined-symbol', 3)
        onlyError(around(`${name} eax, 1`), 'unknown-instruction', 3)
      },
    )
  })

  describe('bad labels', () => {
    it.each(['rax', 'al', 'eax', 'ax', 'ah', 'r8', 'r8d', 'sil', 'rsp', 'r15b'])(
      'a label named like the register `%s` is `bad-label`',
      (name) => {
        onlyError(around(`${name}:`), 'bad-label', 3)
      },
    )

    it('a register name as a data label is `bad-label` too', () => {
      onlyError(src(HEADER, '.data', 'rbx: .quad 1', '.text', 'main:', '    ret'), 'bad-label', 3)
    })

    it.each(['RAX', 'Eax', 'AL', 'R8D', 'Sil'])(
      'register names are not case-sensitive, so the label `%s` is `bad-label` too',
      (name) => {
        onlyError(around(`${name}:`), 'bad-label', 3)
      },
    )

    it.each(['9lives:', 'a-b:', 'two words:'])(
      '`%s` does not have the shape of a label name, and its line gets one error',
      (line) => {
        const errors = errorsOf(around(line))
        expect(errors.map((e) => e.line)).toEqual([3])
        expectFriendly(at(errors, 0))
      },
    )

    it('the same code label twice is `duplicate-label` on the second line', () => {
      onlyError(
        src(
          HEADER, // 1
          'main:', // 2
          '    mov eax, 1', // 3
          'again:', // 4
          '    inc eax', // 5
          'again:', // 6
          '    ret', // 7
        ),
        'duplicate-label',
        6,
      )
    })

    it('`main` twice is `duplicate-label`', () => {
      onlyError(around('main:'), 'duplicate-label', 3)
    })

    it('the same data label twice is `duplicate-label` on the second line', () => {
      onlyError(
        src(HEADER, '.data', 'value: .quad 1', 'value: .quad 2', '.text', 'main:', '    ret'),
        'duplicate-label',
        4,
      )
    })

    it('one name for a code label and a data label is `duplicate-label`', () => {
      onlyError(
        src(HEADER, 'main:', '    ret', 'thing:', '    ret', '.data', 'thing: .quad 2'),
        'duplicate-label',
        7,
      )
    })
  })

  describe('line endings', () => {
    it('`\\r\\n` line endings give the same program as `\\n`', () => {
      const unix = ok(LOOP)
      const windows = ok(LOOP.replaceAll('\n', '\r\n'))
      expect(windows.instructions.map((i) => [i.text, i.line, i.address, i.size])).toEqual(
        unix.instructions.map((i) => [i.text, i.line, i.address, i.size]),
      )
      expect(windows.warnings).toEqual([])
      expect(windows.entryLabel).toBe('main')
      expect([...windows.symbols.keys()].sort()).toEqual(['loop', 'main'])
    })

    it('`\\r\\n` after a string does not become part of the string', () => {
      const program = ok(
        ['.intel_syntax noprefix', 'text: .string "hi"', 'main:', '    ret', ''].join('\r\n'),
      )
      expect(dataOf(program, 'text').bytes).toEqual([104, 105, 0])
    })

    it('an error in a `\\r\\n` file has the right line number', () => {
      const source = [HEADER, 'main:', '    mov eax, 1', '    mov [rax], [rbx]', '    ret'].join(
        '\r\n',
      )
      const error = onlyError(source, 'memory-to-memory', 4)
      expect(error.message).toBe(
        "Line 4: you can't move memory into memory. Load it into a register first.",
      )
    })

    it('the last line does not need a line ending', () => {
      const program = ok([HEADER, 'main:', '    mov eax, 1', '    ret'].join('\n'))
      expect(program.instructions.map((i) => i.text)).toEqual(['mov eax, 1', 'ret'])
    })

    it('blank lines and comment lines keep the line numbers right', () => {
      const program = ok(
        src(
          '# my program', // 1
          '', // 2
          HEADER, // 3
          '', // 4
          '   # the entry point', // 5
          'main:   # starts here', // 6
          '', // 7
          '    mov eax, 1   # one', // 8
          '\t', // 9
          '    ret', // 10
        ),
      )
      expect(program.instructions.map((i) => [i.line, i.text])).toEqual([
        [8, 'mov eax, 1'],
        [10, 'ret'],
      ])
      expect(symbolOf(program, 'main').line).toBe(6)
      expect(program.warnings).toEqual([])
    })
  })

  describe('comments', () => {
    it.each([
      "# don't forget the apostrophe",
      '# a "quote that never ends',
      '# first; second',
      '# see http://example.com // and /* this */',
      '# AT&T would write %rax and $5',
      '# [rax',
      '#',
      '#no space',
      '####',
    ])('a whole-line comment `%s` is ignored', (comment) => {
      const result = assemble(src(HEADER, 'main:', comment, '    ret'))
      expect(result.diagnostics, show(result.diagnostics)).toEqual([])
      expect(result.ok).toBe(true)
    })

    it.each([
      "mov eax, 1 # don't forget",
      'mov eax, 1 # a "quote that never ends',
      'mov eax, 1 # first; second',
      'mov eax, 1 # see http://example.com // and /* this */',
      'mov eax, 1 # AT&T would write %rax and $5',
      'mov eax, 1 #no space',
      'mov eax, 1# no space before',
    ])('the comment in `%s` is ignored', (statement) => {
      const result = assemble(around(statement))
      expect(result.diagnostics, show(result.diagnostics)).toEqual([])
      if (!result.ok) throw new Error('expected ok')
      expect(at(result.program.instructions, 0).text).toBe('mov eax, 1')
    })
  })

  describe('a program with no instructions', () => {
    it.each<[string, string]>([
      ['an empty string', ''],
      ['only spaces and blank lines', '   \n\t\n  \n'],
      ['only comments', '# one\n   # two\n'],
      ['only the syntax line', '.intel_syntax noprefix\n'],
      ['only a label', '.intel_syntax noprefix\nmain:\n'],
      ['only data', '.intel_syntax noprefix\n.data\nvalue: .quad 1\n'],
      ['only constants', '.intel_syntax noprefix\n.equ k, 1\n'],
    ])('%s is `empty-program` on line 0', (_name, source) => {
      onlyError(source, 'empty-program', 0)
    })
  })

  describe('the same input always gives the same result', () => {
    it('assembling a program twice', () => {
      expect(assemble(LOOP)).toEqual(assemble(LOOP))
    })

    it('a failed call does not change the next call', () => {
      const before = assemble(LOOP)
      expect(assemble('mov [rax], [rbx] ; "\n\0').ok).toBe(false)
      expect(assemble(LOOP)).toEqual(before)
    })

    it('two programs with the same label names do not share anything', () => {
      const first = ok(src(HEADER, 'main:', '    nop', 'here:', '    ret'))
      const second = ok(src(HEADER, 'main:', '    mov eax, 1', 'here:', '    ret'))
      expect(hex(symbolOf(first, 'here').address)).toBe('0x401127')
      expect(hex(symbolOf(second, 'here').address)).toBe('0x40112b')
    })
  })
})

/* ═══════════════════════════ 5. Every error code ═══════════════════════════ */

describe('5. Every error code', () => {
  const TWO_LABELS = ['.data', 'first: .quad 1', 'second: .quad 2', '.text']

  describe('unknown-instruction', () => {
    itRejects(
      'unknown-instruction',
      'mvo eax, 1',
      'movv eax, 1',
      'frobnicate rax',
      'hello',
      'hello world',
      'moove rax, rbx',
      'MVO EAX, 1',
    )

    /** How many letters must be added, removed or changed to turn `a` into `b`. */
    function editDistance(a: string, b: string): number {
      let row = Array.from({ length: b.length + 1 }, (_, j) => j)
      for (let i = 1; i <= a.length; i++) {
        const next = [i]
        for (let j = 1; j <= b.length; j++) {
          const change = at(row, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1)
          next.push(Math.min(change, at(row, j) + 1, at(next, j - 1) + 1))
        }
        row = next
      }
      return at(row, b.length)
    }

    /** Every spelling the contract supports: the canonical mnemonics and the folded ones. */
    const SUPPORTED = [
      ...MNEMONICS,
      ...'jz jnz jnle jnl jnge jng jnbe jnb jnc jnae jc jna movsxd endbr64'.split(' '),
    ]

    it.each([
      // one letter away
      ['moov eax, 1', 'mov'],
      ['pussh rax', 'push'],
      ['pusj rax', 'push'],
      ['cal main', 'call'],
      ['leavee', 'leave'],
      ['testt eax, eax', 'test'],
      ['decc eax', 'dec'],
      // two letters away
      ['mooov eax, 1', 'mov'],
      ['ppushh rax', 'push'],
      ['pusher rax', 'push'],
      ['xtestx eax, eax', 'test'],
    ])('the near miss `%s` gets the hint "Did you mean `%s`?"', (statement, meant) => {
      const word = at(statement.split(' '), 0)
      expect(editDistance(word, meant), 'the test itself: this word is a near miss').toBeLessThan(3)
      const error = onlyError(around(statement), 'unknown-instruction', 3)
      expect(error.message).toMatch(/did you mean/i)
      expect(error.message).toContain(`\`${meant}\``)
    })

    it.each(['mvo eax, 1', 'movv eax, 1', 'cmpp eax, 1', 'jmpp main', 'rett'])(
      'the near miss `%s` gets a "Did you mean" hint',
      (statement) => {
        const error = onlyError(around(statement), 'unknown-instruction', 3)
        expect(error.message).toMatch(/did you mean/i)
      },
    )

    it.each(['frobnicate rax', 'pushhhh rax', 'mooooov eax, 1', 'compare eax, 1', 'increment eax'])(
      '`%s` is more than two letters away from every mnemonic and gets no hint',
      (statement) => {
        const word = at(statement.split(' '), 0)
        const nearest = Math.min(...SUPPORTED.map((mnemonic) => editDistance(word, mnemonic)))
        expect(nearest, 'the test itself: this word is far from every mnemonic').toBeGreaterThan(2)
        const error = onlyError(around(statement), 'unknown-instruction', 3)
        expect(error.message).not.toMatch(/did you mean/i)
      },
    )
  })

  describe('unsupported-instruction', () => {
    itRejects(
      'unsupported-instruction',
      'mul rbx',
      'div rcx',
      'idiv rcx',
      'neg rax',
      'not rax',
      'shl rax, 1',
      'shr rax, 1',
      'sal rax, 1',
      'sar rax, 1',
      'rol rax, 1',
      'ror rax, 1',
      'adc rax, rbx',
      'sbb rax, rbx',
      'xchg rax, rbx',
      'cdq',
      'cqo',
      'cdqe',
      'cwde',
      'movabs rax, 5',
      'syscall',
      'int 0x80',
      'enter 16, 0',
      'loop main',
      'hlt',
      'cmove rax, rbx',
      'cmovne rax, rbx',
      'cmovg rax, rbx',
      'cmovl rax, rbx',
      'cmovge rax, rbx',
      'cmovle rax, rbx',
      'cmova rax, rbx',
      'cmovb rax, rbx',
      'sete al',
      'setne al',
      'setg al',
      'setl al',
      'setge al',
      'setle al',
      'seta al',
      'setb al',
      'movs',
      'stos',
      'lods',
      'scas',
      'cmps',
      'cld',
      'std',
      'bswap eax',
      'bt eax, 1',
      'SHL RAX, 1',
      'Syscall',
    )

    it('the message names the instruction', () => {
      const error = onlyError(around('shl rax, 1'), 'unsupported-instruction', 3)
      expect(error.message).toContain('`shl`')
    })
  })

  describe('unknown-register', () => {
    itRejects(
      'unknown-register',
      'mov rex, 1',
      'mov eex, 1',
      'mov r16, 1',
      'mov r8l, 1',
      'mov eip, 1',
      'mov rip, 1',
      'mov eax, eex',
      'mov rax, rex',
      'add rax, r16',
      'mov rax, rip',
    )

    it.each(['mov rex, 1', 'mov eex, 1', 'mov r8l, 1', 'mov eax, eex'])(
      '`%s` gets a "Did you mean" hint, because a real name is one letter away',
      (statement) => {
        const error = onlyError(around(statement), 'unknown-register', 3)
        expect(error.message).toMatch(/did you mean/i)
      },
    )
  })

  describe('operand-count', () => {
    itRejects(
      'operand-count',
      'mov eax',
      'mov',
      'mov eax, ebx, ecx',
      'add eax',
      'add eax, 1, 2',
      'sub rsp',
      'cmp eax',
      'and eax',
      'or eax',
      'xor eax',
      'test eax',
      'lea rax',
      'movzx eax',
      'movsx eax',
      'push',
      'push rax, rbx',
      'pop',
      'pop rax, rbx',
      'inc',
      'inc eax, ebx',
      'dec',
      'dec eax, 1',
      'ret 8',
      'ret rax',
      'nop eax',
      'leave rax',
      'jmp',
      'jmp main, main',
      'je',
      'call',
      'call main, main',
    )

    it('the message shows the right shape of the instruction', () => {
      const error = onlyError(around('mov eax'), 'operand-count', 3)
      expect(error.message).toMatch(/`mov\b[^`]*`/)
    })
  })

  describe('bad-operand', () => {
    itRejects('bad-operand', 'mov eax, ?', 'mov eax, @', 'mov eax, !')
  })

  describe('bad-number', () => {
    itRejects('bad-number', 'mov eax, 010', 'mov eax, 12abc', 'mov eax, 0xZZ', 'mov eax, 1Fh')
  })

  describe('bad-memory-operand', () => {
    itRejects(
      'bad-memory-operand',
      'mov rax, [rax*3]',
      'mov rax, [rax*5]',
      'mov rax, [rbx+rcx*16]',
      'mov rax, [rbx+rcx*0]',
      'mov rax, [rbp-rax]',
      'mov rax, [rbp-rax*2]',
      ['mov rax, [first+second]', TWO_LABELS],
      ['mov rax, first[rip+rax]', TWO_LABELS],
      ['mov rax, [rip+rax+first]', TWO_LABELS],
      'mov rax, [rip]',
      'mov rax, [rip+8]',
      'mov rax, [rax',
      'mov rax, [rbp-8',
      'mov [rbp-8, rax',
      'mov rax, []',
      'mov rax, [rax]junk',
      'mov rax, [rax]5',
      'lea rax, [rbx*3]',
    )
  })

  describe('bad-directive', () => {
    itRejects('bad-directive', '.equ count', '.string')
  })

  describe('bad-string', () => {
    itRejects('bad-string', '.string "abc', String.raw`.string "a\qb"`)
  })

  describe('bad-label', () => {
    itRejects('bad-label', 'rax:', 'al:')
  })

  describe('duplicate-label', () => {
    itRejects('duplicate-label', 'main:', ['.equ k, 2', ['.equ k, 1']])
  })

  describe('undefined-symbol', () => {
    itRejects(
      'undefined-symbol',
      'mov eax, nothere',
      'mov rax, [rbp+nothere]',
      'mov rax, nothere[rbp]',
      'lea rdi, nothere[rip]',
      'mov rax, offset nothere',
      'mov rax, OFFSET FLAT:nothere',
      'jmp nothere',
      'je nothere',
      'jle nothere',
      'call nothere',
      'call nothere@PLT',
      'add rax, nothere*2',
      'cmp dword ptr [rbp-4], nothere',
      '.equ k, nothere+1',
    )

    it('a name that is only defined in another letter case is unknown', () => {
      onlyError(around('mov eax, COUNT', ['.equ count, 5']), 'undefined-symbol', 4)
    })
  })

  describe('memory-to-memory', () => {
    itRejects(
      'memory-to-memory',
      'mov [rax], [rbx]',
      'mov qword ptr [rax], qword ptr [rbx]',
      'mov dword ptr [rbp-4], dword ptr [rbp-8]',
      'mov [rbp-8], [rbp-16]',
      ['mov first, second', TWO_LABELS],
      ['mov first[rip], second[rip]', TWO_LABELS],
      ['mov count[rbp], size[rbp]', EQUS],
      'add [rax], [rbx]',
      'sub [rax], [rbx]',
      'cmp [rax], [rbx]',
      'and [rax], [rbx]',
      'or [rax], [rbx]',
      'xor [rax], [rbx]',
      'test [rax], [rbx]',
      'cmp dword ptr [rbp-4], dword ptr [rbp-8]',
    )

    it.each([
      'mov [rax], [rbx]',
      'mov qword ptr [rbp-8], qword ptr [rbp-16]',
      'MOV [RAX], [RBX]',
      'mov   [rax] ,   [rbx]   # copy',
    ])('the message for `%s` is exactly the sentence in the contract', (statement) => {
      const error = onlyError(around(statement), 'memory-to-memory', 3)
      expect(error.message).toBe(
        "Line 3: you can't move memory into memory. Load it into a register first.",
      )
    })

    it('the exact message uses the line number of the instruction', () => {
      const source = src(
        HEADER, // 1
        '.equ first, -8', // 2
        '.equ second, -16', // 3
        '', // 4
        'main:', // 5
        '    push rbp', // 6
        '    mov rbp, rsp', // 7
        '    sub rsp, 16', // 8
        '', // 9
        '    # copy first into second', // 10
        '    mov second[rbp], first[rbp]', // 11
        '    leave', // 12
        '    ret', // 13
      )
      const error = onlyError(source, 'memory-to-memory', 11)
      expect(error.message).toBe(
        "Line 11: you can't move memory into memory. Load it into a register first.",
      )
    })
  })

  describe('immediate-destination', () => {
    itRejects(
      'immediate-destination',
      'mov 5, eax',
      'mov 5, rax',
      'mov 1, 2',
      'mov 5, [rax]',
      'mov 0x10, al',
      "mov 'A', al",
      ['mov count, rax', EQUS],
      'add 5, rax',
      'sub 1, rsp',
      'cmp 0, eax',
      'and 1, eax',
      'or 1, eax',
      'xor 1, eax',
      'test 1, eax',
    )
  })

  describe('size-mismatch', () => {
    itRejects(
      'size-mismatch',
      'mov eax, bx',
      'mov rax, ebx',
      'mov al, bx',
      'mov ax, eax',
      'mov eax, rbx',
      'mov rax, al',
      'mov r8d, rax',
      'add rax, ebx',
      'sub eax, cx',
      'cmp al, bx',
      'and rax, eax',
      'or eax, al',
      'xor rax, eax',
      'test eax, bx',
      'mov eax, qword ptr [rbp-8]',
      'mov rax, dword ptr [rbp-4]',
      'mov byte ptr [rax], ebx',
      'mov qword ptr [rbp-8], eax',
      'add dword ptr [rax], rbx',
      'cmp al, word ptr [rax]',
      'movzx eax, ebx',
      'movzx ax, bx',
      'movzx eax, dword ptr [rax]',
      'movsx eax, ebx',
      'movsx rax, rbx',
      'movsx ax, word ptr [rax]',
    )

    it('the message names both registers and their sizes in bits', () => {
      const error = onlyError(around('mov eax, bx'), 'size-mismatch', 3)
      expect(error.message).toContain('eax')
      expect(error.message).toMatch(/\bbx\b/)
      expect(error.message).toMatch(/\b32\b/)
      expect(error.message).toMatch(/\b16\b/)
    })

    it('the message for 64-bit and 8-bit registers', () => {
      const error = onlyError(around('mov rax, bl'), 'size-mismatch', 3)
      expect(error.message).toContain('rax')
      expect(error.message).toMatch(/\bbl\b/)
      expect(error.message).toMatch(/\b64\b/)
      expect(error.message).toMatch(/\b8\b/)
    })
  })

  describe('missing-size', () => {
    itRejects(
      'missing-size',
      'mov [rbp-8], 5',
      'mov [rax], 0',
      'mov -8[rbp], 5',
      ['mov count[rbp], 5', EQUS],
      ['mov counter, 5', DATA],
      ['mov counter[rip], 5', DATA],
      'add [rax], 1',
      'sub [rax], 1',
      'cmp [rax], 0',
      'and [rax], 1',
      'or [rax], 1',
      'xor [rax], 1',
      'test [rax], 1',
      'movzx eax, [rbx]',
      'movsx rax, [rbx]',
      'movsx eax, [rbp-1]',
    )

    it('the message says which words to add', () => {
      const error = onlyError(around('mov [rbp-8], 5'), 'missing-size', 3)
      for (const word of ['byte ptr', 'word ptr', 'dword ptr', 'qword ptr']) {
        expect(error.message).toContain(word)
      }
    })

    it.each(['inc [rax]', 'dec [rbp-8]'])(
      '`%s` is rejected, because the memory operand needs a size',
      (statement) => {
        onlyErrorAmong(around(statement), ['missing-size', 'invalid-operands'], 3)
      },
    )
  })

  describe('immediate-too-large', () => {
    itRejects(
      'immediate-too-large',
      'mov al, 256',
      'mov al, -129',
      'mov ah, 256',
      'mov ax, 65536',
      'mov ax, -32769',
      'mov eax, 4294967296',
      'mov eax, 0x100000000',
      'mov eax, -2147483649',
      'mov rax, 18446744073709551616',
      'mov rax, 0x10000000000000000',
      'mov rax, -9223372036854775809',
      'add rax, 0x80000000',
      'add rax, 2147483648',
      'add rax, -2147483649',
      'sub rsp, 0x100000000',
      'cmp rax, 0x80000000',
      'and rax, 0x80000000',
      'or rax, 0x100000000',
      'xor rax, 0x100000000',
      'add eax, 0x100000000',
      'add al, 256',
      'cmp al, 256',
      'cmp al, -129',
      'sub ax, 65536',
      'test al, 256',
      'test eax, 0x100000000',
      'mov qword ptr [rax], 0x100000000',
      'mov qword ptr [rax], 0x80000000',
      'mov qword ptr [rax], -2147483649',
      'mov dword ptr [rax], 0x100000000',
      'mov word ptr [rax], 65536',
      'mov byte ptr [rax], 256',
      'cmp byte ptr [rax], 300',
      'add qword ptr [rbp-8], 0x80000000',
      'cmp dword ptr [rbp-4], 4294967296',
    )

    describe('the largest and smallest values that fit', () => {
      itAccepts(
        'mov al, 255',
        'mov al, -128',
        'mov al, 0',
        'mov ah, 255',
        'mov ax, 65535',
        'mov ax, -32768',
        'mov eax, 4294967295',
        'mov eax, 0xffffffff',
        'mov eax, -2147483648',
        'mov rax, 0xffffffffffffffff',
        'mov rax, 18446744073709551615',
        'mov rax, -9223372036854775808',
        'mov rax, 0x7fffffffffffffff',
        'mov rax, 0x8000000000000000',
        'mov rax, 0x100000000',
        'mov r15, 0xffffffffffffffff',
        'add rax, 0x7fffffff',
        'add rax, 2147483647',
        'add rax, -2147483648',
        'sub rsp, 2147483647',
        'cmp rax, -2147483648',
        'and rax, 0x7fffffff',
        'add eax, 0xffffffff',
        'add eax, -2147483648',
        'add ax, 65535',
        'add al, 255',
        'cmp al, 255',
        'cmp al, -128',
        'test al, 255',
        'test eax, 0xffffffff',
        'mov qword ptr [rax], 0x7fffffff',
        'mov qword ptr [rax], -2147483648',
        'mov dword ptr [rax], 0xffffffff',
        'mov dword ptr [rax], -2147483648',
        'mov word ptr [rax], 0xffff',
        'mov word ptr [rax], -32768',
        'mov byte ptr [rax], 0xff',
        'mov byte ptr [rax], -128',
        'cmp byte ptr [rax], 255',
        'add qword ptr [rbp-8], 0x7fffffff',
      )

      it('a 64-bit register takes 0xffffffffffffffff as its value', () => {
        const ins = one('mov rax, 0xffffffffffffffff')
        expect(immAt(ins, 1).value).toBe(0xffff_ffff_ffff_ffffn)
        expect(ins.opSize).toBe(64)
      })
    })

    describe('both edges of the range, for every instruction and every size', () => {
      const DESTINATIONS: [text: string, bits: 8 | 16 | 32 | 64][] = [
        ['bl', 8],
        ['bx', 16],
        ['ebx', 32],
        ['rbx', 64],
        ['byte ptr [rax]', 8],
        ['word ptr [rax]', 16],
        ['dword ptr [rax]', 32],
        ['qword ptr [rax]', 64],
      ]

      /** The smallest and the largest number that fits, by the rules of the contract. */
      function range(mnemonic: string, destination: string, bits: number): [bigint, bigint] {
        // A 64-bit register takes any 64-bit value from `mov`.
        if (mnemonic === 'mov' && destination === 'rbx') return [-(2n ** 63n), 2n ** 64n - 1n]
        // Every other 64-bit destination takes a number that fits signed 32 bits.
        if (bits === 64) return [-(2n ** 31n), 2n ** 31n - 1n]
        return [-(2n ** BigInt(bits - 1)), 2n ** BigInt(bits) - 1n]
      }

      it.each(['mov', 'add', 'sub', 'cmp', 'and', 'or', 'xor', 'test'])(
        '`%s`: the edge values are accepted, and one more is `immediate-too-large`',
        (mnemonic) => {
          const problems: string[] = []
          for (const [destination, bits] of DESTINATIONS) {
            const [low, high] = range(mnemonic, destination, bits)
            for (const [value, fits] of [
              [low - 1n, false],
              [low, true],
              [high, true],
              [high + 1n, false],
            ] as const) {
              const statement = `${mnemonic} ${destination}, ${value}`
              const result = assemble(around(statement))
              const errors = result.diagnostics.filter((d) => d.severity === 'error')
              const got = result.ok ? 'ok' : errors.map((e) => `${e.code} on line ${e.line}`).join()
              const want = fits ? 'ok' : 'immediate-too-large on line 3'
              if (got !== want)
                problems.push(`\`${statement}\` gave ${got}, the contract says ${want}`)
            }
          }
          expect(problems).toEqual([])
        },
      )
    })
  })

  describe('push-pop-operand', () => {
    itRejects(
      'push-pop-operand',
      'push eax',
      'push ax',
      'push al',
      'push r8d',
      'push 0x80000000',
      'push 2147483648',
      'push 0x100000000',
      'push -2147483649',
      'push qword ptr [rax]',
      'push [rax]',
      'pop eax',
      'pop ax',
      'pop al',
      'pop 5',
      'pop qword ptr [rax]',
      'pop [rax]',
      ['push counter', DATA],
    )
  })

  describe('invalid-operands', () => {
    itRejects(
      'invalid-operands',
      'lea rax, rbx',
      'lea rax, 5',
      'lea [rax], rbx',
      'lea al, [rbx]',
      'lea rax, eax',
      'imul rbx',
      'imul eax, ebx, 5',
      'imul rax, rbx, 10',
      'movzx eax, 5',
    )

    it.each(['imul rbx', 'imul eax, ebx, 5'])(
      'the message for `%s` says that only the 2-operand form is supported',
      (statement) => {
        const error = onlyError(around(statement), 'invalid-operands', 3)
        expect(error.message).toMatch(/\b2\b|\btwo\b/i)
      },
    )

    it.each([
      'imul al, bl',
      'imul [rax], rbx',
      'imul eax, rbx',
      'imul rax, ebx',
      'imul eax, word ptr [rax]',
      'movzx rax, ebx',
      'movzx al, bl',
      'movzx [rax], bl',
      'movsx dword ptr [rax], bl',
      'movzx eax, qword ptr [rax]',
      'inc 5',
      'dec 1',
      'imul 5, eax',
      'lea 5, [rax]',
      'movzx 5, al',
    ])('`%s` is rejected with one error on its line', (statement) => {
      onlyErrorAmong(
        around(statement),
        ['invalid-operands', 'size-mismatch', 'immediate-destination'],
        3,
      )
    })

    it('`imul eax, 0x100000000` is rejected, because the number does not fit', () => {
      onlyErrorAmong(
        around('imul eax, 0x100000000'),
        ['immediate-too-large', 'invalid-operands'],
        3,
      )
    })
  })

  describe('high-byte-rex', () => {
    itRejects(
      'high-byte-rex',
      'mov ah, sil',
      'mov ah, dil',
      'mov ah, spl',
      'mov ah, bpl',
      'mov ah, r8b',
      'mov r9b, ch',
      'mov bpl, ah',
      'add bh, dil',
      'cmp dh, spl',
      'xor ch, r15b',
      'test ah, r10b',
      'or r12b, bh',
      // Rule 2 comes before the size rules, so this is not `size-mismatch`.
      'mov ah, r8d',
      'mov r8, ah',
      'movzx r8d, ah',
      'movsx r9, bh',
      // A register inside the brackets is a register of the instruction too.
      'mov ah, [r8]',
      'mov [r9], ch',
      'mov bh, [rax+r10*2]',
    )

    itAccepts(
      'mov ah, bl',
      'mov ah, al',
      'mov bh, ch',
      'mov ah, 5',
      'mov ah, [rax]',
      'add dh, cl',
      'movzx eax, ah',
      'mov sil, r8b',
      'mov dil, al',
    )
  })

  describe('jump-target', () => {
    itRejects(
      'jump-target',
      'jmp printf',
      'jmp puts',
      'jmp exit',
      'je printf',
      'jne scanf',
      'jmp rax',
      'jmp [rax]',
      'jmp qword ptr [rax]',
      'jmp 5',
      'jmp 0x401126',
      'je rax',
      'jne 5',
      'jle [rax]',
      'call rax',
      'call [rax]',
      'call qword ptr [rax]',
      'call 5',
      'call 0x401126',
    )
  })

  describe('address-register', () => {
    itRejects(
      'address-register',
      'mov eax, [ebp-8]',
      'mov al, [ax]',
      'mov rax, [eax]',
      'mov rax, [al]',
      'mov rax, [r8d]',
      'mov rax, [rbx+ecx*4]',
      'lea rax, [edi+8]',
      'mov rax, -8[ebp]',
      'mov rax, [rax+rsp*2]',
      'mov rax, [rsp*2]',
      'mov rax, [rax+rsp*8]',
      'mov rax, [rax*2+rbx*4]',
      'mov rax, [rax+rbx+rcx]',
      'mov rax, [rax+rbx+rcx*2]',
    )
  })

  describe('comment-style', () => {
    itRejects(
      'comment-style',
      'mov eax, 1 ; set eax',
      '; a whole-line comment',
      'mov eax, 1 ;',
      'mov eax, 1; no space',
      'mov eax, 1 // set eax',
      '// a whole-line comment',
      'mov eax, 1 /* set eax */',
      '/* a whole-line comment */',
      'ret ; done',
    )

    it('the message says that a comment starts with `#`', () => {
      for (const statement of ['mov eax, 1 ; set eax', 'mov eax, 1 // set eax']) {
        const error = onlyError(around(statement), 'comment-style', 3)
        expect(error.message).toContain('`#`')
      }
    })
  })

  describe('att-syntax', () => {
    describe('a `%` in front of a register', () => {
      itRejects(
        'att-syntax',
        'mov %rax, %rbx',
        'mov %eax, 5',
        'mov eax, %ebx',
        'push %rbp',
        'mov -8(%rbp), %eax',
        'add %rbx, %rax',
        'MOV %RAX, %RBX',
      )
    })

    describe('a `$` in front of a number', () => {
      itRejects(
        'att-syntax',
        'mov $5, %eax',
        'mov eax, $5',
        'add rsp, $16',
        'push $1',
        'mov $0x10, eax',
      )
    })

    describe('a size letter at the end of the instruction name', () => {
      itRejects(
        'att-syntax',
        'movq rax, rbx',
        'movl eax, ebx',
        'movw ax, bx',
        'movb al, bl',
        'pushq rbp',
        'popq rbp',
        'addq rax, rbx',
        'addl eax, ebx',
        'subq rax, rbx',
        'subl eax, ebx',
        'cmpq rax, rbx',
        'cmpl eax, ebx',
        'leaq rax, [rbx]',
        'callq main',
        'retq',
        'jmpq main',
        'incq rax',
        'incl eax',
        'decq rax',
        'decl eax',
        'imulq rax, rbx',
        'imull eax, ebx',
        'xorq rax, rax',
        'xorl eax, eax',
        'andq rax, rbx',
        'andl eax, ebx',
        'orq rax, rbx',
        'orl eax, ebx',
        'testq rax, rax',
        'testl eax, eax',
        'MOVQ rax, rbx',
        'movq %rsp, %rbp',
        'movl $0, -4(%rbp)',
        'pushq %rbp',
      )

      it('the message says to write `mov`, not `movq`', () => {
        const error = onlyError(around('movq rax, rbx'), 'att-syntax', 3)
        expect(error.message).toContain('`mov`')
        expect(error.message).toContain('`movq`')
      })

      // These spellings have a size letter too, but the list in the contract does not name
      // them. The contract can be read two ways here (`att-syntax`, or `unknown-instruction`
      // with a "did you mean" hint). Both ways the message names the instruction to write.
      it.each([
        ['calll main', 'call'],
        ['pushl rax', 'push'],
        ['addw ax, bx', 'add'],
        ['testb al, 1', 'test'],
        ['cmpb al, 1', 'cmp'],
        ['leal eax, [rbx]', 'lea'],
      ])('`%s` gets one error on its line, and the message names `%s`', (statement, meant) => {
        const error = onlyErrorAmong(around(statement), ['att-syntax', 'unknown-instruction'], 3)
        expect(error.message).toContain(`\`${meant}\``)
      })
    })
  })

  describe('wrong-section', () => {
    it('an instruction inside `.data`', () => {
      const error = onlyError(
        src(
          HEADER, // 1
          '.data', // 2
          'value: .quad 5', // 3
          '    mov rax, 1', // 4
          '.text', // 5
          'main:', // 6
          '    ret', // 7
        ),
        'wrong-section',
        4,
      )
      expect(error.message).toContain('.data')
      expect(error.message).toContain('.text')
    })

    it('a program that forgets `.text` after `.data` gets one error for each instruction', () => {
      const errors = errorsOf(
        src(
          HEADER, // 1
          '.data', // 2
          'value: .quad 5', // 3
          'main:', // 4
          '    mov rax, 1', // 5
          '    ret', // 6
        ),
      )
      expect(errors.map((e) => [e.code, e.line])).toEqual([
        ['wrong-section', 5],
        ['wrong-section', 6],
      ])
      for (const error of errors) expectFriendly(error)
    })

    it.each(['.section .data', '.bss', '.section .bss'])(
      'an instruction after `%s`',
      (sectionLine) => {
        onlyError(src(HEADER, 'main:', '    ret', sectionLine, '    nop'), 'wrong-section', 5)
      },
    )
  })

  describe('empty-program', () => {
    it('is reported on line 0', () => {
      const error = firstError('')
      expect(error).toMatchObject({ severity: 'error', code: 'empty-program', line: 0 })
      expectFriendly(error)
    })
  })

  describe('legal forms of every instruction', () => {
    interface Legal {
      statement: string
      mnemonic: Mnemonic
      opSize: OperandSize | null
      kinds: Operand['kind'][]
      before?: string[]
    }

    const legal = (
      statement: string,
      opSize: OperandSize,
      kinds: Operand['kind'][],
      before?: string[],
    ): Legal => ({
      statement,
      mnemonic: statement.split(' ')[0] as Mnemonic,
      opSize,
      kinds,
      before,
    })

    const LEGAL: Legal[] = [
      // mov d, s
      legal('mov rax, rbx', 64, ['reg', 'reg']),
      legal('mov eax, ebx', 32, ['reg', 'reg']),
      legal('mov ax, bx', 16, ['reg', 'reg']),
      legal('mov al, bl', 8, ['reg', 'reg']),
      legal('mov eax, 5', 32, ['reg', 'imm']),
      legal('mov rax, -1', 64, ['reg', 'imm']),
      legal('mov ah, 1', 8, ['reg', 'imm']),
      legal('mov rax, [rbx]', 64, ['reg', 'mem']),
      legal('mov eax, dword ptr [rbp-4]', 32, ['reg', 'mem']),
      legal('mov [rbx], rax', 64, ['mem', 'reg']),
      legal('mov [rbp-4], edi', 32, ['mem', 'reg']),
      legal('mov byte ptr [rax], bl', 8, ['mem', 'reg']),
      legal('mov dword ptr [rbx], 5', 32, ['mem', 'imm']),
      legal('mov qword ptr [rbp-8], 0', 64, ['mem', 'imm']),
      legal('mov word ptr [rax], 7', 16, ['mem', 'imm']),
      legal('mov byte ptr [rax], 7', 8, ['mem', 'imm']),
      legal('mov eax, counter', 32, ['reg', 'mem'], DATA),
      legal('mov counter, eax', 32, ['mem', 'reg'], DATA),
      legal('mov eax, size', 32, ['reg', 'imm'], EQUS),
      // add sub cmp and or xor: the same shapes as mov
      ...(['add', 'sub', 'cmp', 'and', 'or', 'xor'] as const).flatMap((m) => [
        legal(`${m} rax, rbx`, 64, ['reg', 'reg']),
        legal(`${m} al, bl`, 8, ['reg', 'reg']),
        legal(`${m} eax, 5`, 32, ['reg', 'imm']),
        legal(`${m} rax, [rbx]`, 64, ['reg', 'mem']),
        legal(`${m} [rbx], rax`, 64, ['mem', 'reg']),
        legal(`${m} dword ptr [rbx], 5`, 32, ['mem', 'imm']),
        legal(`${m} eax, dword ptr [rbp-4]`, 32, ['reg', 'mem']),
      ]),
      // test a, b
      legal('test eax, eax', 32, ['reg', 'reg']),
      legal('test rax, rax', 64, ['reg', 'reg']),
      legal('test al, 1', 8, ['reg', 'imm']),
      legal('test rax, 1', 64, ['reg', 'imm']),
      legal('test byte ptr [rax], 1', 8, ['mem', 'imm']),
      legal('test [rax], ebx', 32, ['mem', 'reg']),
      legal('test eax, [rbx]', 32, ['reg', 'mem']),
      // inc d, dec d
      legal('inc rax', 64, ['reg']),
      legal('inc al', 8, ['reg']),
      legal('dec ecx', 32, ['reg']),
      legal('dec cx', 16, ['reg']),
      legal('inc dword ptr [rbp-4]', 32, ['mem']),
      legal('inc byte ptr [rax]', 8, ['mem']),
      legal('dec qword ptr [rax]', 64, ['mem']),
      legal('dec word ptr [rax]', 16, ['mem']),
      // imul d, s
      legal('imul rax, rbx', 64, ['reg', 'reg']),
      legal('imul eax, ebx', 32, ['reg', 'reg']),
      legal('imul ax, bx', 16, ['reg', 'reg']),
      legal('imul eax, [rbp-4]', 32, ['reg', 'mem']),
      legal('imul eax, dword ptr [rbp-4]', 32, ['reg', 'mem']),
      legal('imul rax, 10', 64, ['reg', 'imm']),
      legal('imul eax, -3', 32, ['reg', 'imm']),
      // movzx d, s and movsx d, s
      legal('movzx eax, al', 32, ['reg', 'reg']),
      legal('movzx eax, bx', 32, ['reg', 'reg']),
      legal('movzx rax, bl', 64, ['reg', 'reg']),
      legal('movzx rax, bx', 64, ['reg', 'reg']),
      legal('movzx ax, bl', 16, ['reg', 'reg']),
      legal('movzx eax, byte ptr [rbp-1]', 32, ['reg', 'mem']),
      legal('movzx eax, word ptr [rax]', 32, ['reg', 'mem']),
      legal('movsx eax, bl', 32, ['reg', 'reg']),
      legal('movsx eax, bx', 32, ['reg', 'reg']),
      legal('movsx rax, al', 64, ['reg', 'reg']),
      legal('movsx rax, bx', 64, ['reg', 'reg']),
      legal('movsx rax, eax', 64, ['reg', 'reg']),
      legal('movsx rax, dword ptr [rbp-4]', 64, ['reg', 'mem']),
      legal('movsx eax, byte ptr [rax]', 32, ['reg', 'mem']),
      // lea d, s
      legal('lea rax, [rbx]', 64, ['reg', 'mem']),
      legal('lea eax, [rbx+rcx]', 32, ['reg', 'mem']),
      legal('lea ax, [rbx]', 16, ['reg', 'mem']),
      legal('lea rax, [rbx+rcx*4+8]', 64, ['reg', 'mem']),
      legal('lea rdi, message[rip]', 64, ['reg', 'mem'], RODATA),
      legal('lea rsi, [rbp-4]', 64, ['reg', 'mem']),
      // push s, pop d
      legal('push rax', 64, ['reg']),
      legal('push r12', 64, ['reg']),
      legal('push 5', 64, ['imm']),
      legal('push -1', 64, ['imm']),
      legal('push 2147483647', 64, ['imm']),
      legal('push -2147483648', 64, ['imm']),
      legal('pop rax', 64, ['reg']),
      legal('pop r15', 64, ['reg']),
    ]

    it.each(LEGAL)('`$statement`', ({ statement, mnemonic, opSize, kinds, before }) => {
      const result = assemble(around(statement, before))
      expect(result.diagnostics, show(result.diagnostics)).toEqual([])
      if (!result.ok) throw new Error('expected ok')
      const ins = at(result.program.instructions, 0)
      expect(ins.mnemonic).toBe(mnemonic)
      expect(ins.operands.map((operand) => operand.kind)).toEqual(kinds)
      expect(ins.opSize).toBe(opSize)
      expect(ins.line).toBe(lineOf(before))
    })

    const JUMPS: Mnemonic[] = [
      'jmp',
      'je',
      'jne',
      'jg',
      'jge',
      'jl',
      'jle',
      'ja',
      'jae',
      'jb',
      'jbe',
      'js',
      'jns',
      'jo',
      'jno',
      'call',
    ]

    it.each(JUMPS)('`%s main` takes one label and has no operand size', (mnemonic) => {
      const ins = one(`${mnemonic} main`)
      expect(ins.mnemonic).toBe(mnemonic)
      expect(ins.operands).toHaveLength(1)
      expect(targetAt(ins, 0)).toMatchObject({ name: 'main', address: 0x401126n, external: false })
      expect(ins.opSize).toBeNull()
    })

    it.each<[string, number]>([
      ['ret', 1],
      ['nop', 1],
      ['leave', 1],
    ])('`%s` takes no operand', (mnemonic, bytes) => {
      const ins = one(mnemonic)
      expect(ins.mnemonic).toBe(mnemonic)
      expect(ins.operands).toEqual([])
      expect(ins.opSize).toBeNull()
      expect(ins.size).toBe(bytes)
      expect(ins.text).toBe(mnemonic)
    })
  })

  describe('the order of the checks (the first failure wins)', () => {
    it.each(['mov ah, r8b, 1', 'mov [rax], [rbx], 5', 'push eax, ebx', 'jmp rax, rbx', 'pop 5, 6'])(
      'the operand count comes first: `%s`',
      (statement) => {
        onlyError(around(statement), 'operand-count', 3)
      },
    )

    it.each(['mov ah, r8d', 'movzx ah, r8b', 'imul ah, r8b', 'add bh, r9', 'lea ah, [r8]'])(
      'a high byte register next to a REX register comes before the rules of the instruction: `%s`',
      (statement) => {
        onlyError(around(statement), 'high-byte-rex', 3)
      },
    )

    it.each(['mov 300, al', 'add 5, [rax]', 'mov 0x100000000, [rax]', 'cmp 1, dword ptr [rax]'])(
      'a number as the destination comes before the other two-operand checks: `%s`',
      (statement) => {
        onlyError(around(statement), 'immediate-destination', 3)
      },
    )

    it.each(['mov dword ptr [rax], qword ptr [rbx]', 'add byte ptr [rax], qword ptr [rbx]'])(
      'memory to memory comes before the sizes of the operands: `%s`',
      (statement) => {
        onlyError(around(statement), 'memory-to-memory', 3)
      },
    )

    it.each(['mov [rax], 0x100000000', 'add [rbp-8], 99999999999'])(
      'a missing size comes before the size of the number: `%s`',
      (statement) => {
        onlyError(around(statement), 'missing-size', 3)
      },
    )
  })

  describe('habits from other assemblers', () => {
    it.each(['section .text', 'global main', 'extern printf'])(
      'the NASM line `%s` is not an instruction',
      (line) => {
        onlyError(src(HEADER, line, 'main:', '    ret'), 'unknown-instruction', 2)
      },
    )

    it.each([
      'mov dword [rbp-4], 5',
      'mov eax, dword [rbp-4]',
      'mov rax, QWORD [rax]',
      'mov eax, [rel message]',
      'msg db "hi", 0',
      'mov eax, 1Fh',
      'mov eax, [ebp+8]',
    ])('`%s` gets one error on its line', (statement) => {
      const errors = errorsOf(around(statement, RODATA))
      expect(errors.map((e) => e.line)).toEqual([lineOf(RODATA)])
      expectFriendly(at(errors, 0))
    })
  })

  describe('the whole operand-rule table', () => {
    /**
     * The kinds of operand the table talks about: a register of each width, memory
     * without a size, memory with each `ptr` size, and a number.
     */
    type Kind = 'R8' | 'R16' | 'R32' | 'R64' | 'M' | 'M8' | 'M16' | 'M32' | 'M64' | 'I'
    const KINDS: Kind[] = ['R8', 'R16', 'R32', 'R64', 'M', 'M8', 'M16', 'M32', 'M64', 'I']
    const DESTINATION: Record<Kind, string> = {
      R8: 'bl',
      R16: 'bx',
      R32: 'ebx',
      R64: 'rbx',
      M: '[rax]',
      M8: 'byte ptr [rax]',
      M16: 'word ptr [rax]',
      M32: 'dword ptr [rax]',
      M64: 'qword ptr [rax]',
      I: '5',
    }
    const SOURCE: Record<Kind, string> = {
      R8: 'cl',
      R16: 'cx',
      R32: 'ecx',
      R64: 'rcx',
      M: '[rdx]',
      M8: 'byte ptr [rdx]',
      M16: 'word ptr [rdx]',
      M32: 'dword ptr [rdx]',
      M64: 'qword ptr [rdx]',
      I: '7',
    }
    const isRegister = (kind: Kind): boolean => kind.startsWith('R')
    const isMemory = (kind: Kind): boolean => kind.startsWith('M')
    /** The width in bits, or null for a number and for memory without a `ptr` size. */
    const width = (kind: Kind): number | null =>
      kind === 'M' || kind === 'I' ? null : Number(kind.slice(1))

    /** 'ok', the one code the table names, or the codes to choose from where it names none. */
    type Verdict = 'ok' | AssembleCode | AssembleCode[]
    const NOT_NAMED: AssembleCode[] = [
      'invalid-operands',
      'size-mismatch',
      'immediate-destination',
      'missing-size',
    ]

    /** The generic two-operand checks, in the order of the contract. */
    function generic(d: Kind, s: Kind): Verdict {
      if (d === 'I') return 'immediate-destination'
      if (isMemory(d) && isMemory(s)) return 'memory-to-memory'
      if (isRegister(d) && isRegister(s)) return width(d) === width(s) ? 'ok' : 'size-mismatch'
      if (isRegister(d) && isMemory(s)) {
        return s === 'M' || width(d) === width(s) ? 'ok' : 'size-mismatch'
      }
      if (isMemory(d) && isRegister(s)) {
        return d === 'M' || width(d) === width(s) ? 'ok' : 'size-mismatch'
      }
      // The source is a number (5 and 7 fit every size).
      return d === 'M' ? 'missing-size' : 'ok'
    }

    /** `imul d, s`: d is a register of 16/32/64 bits; s is the same size, or a number. */
    function imul(d: Kind, s: Kind): Verdict {
      if (!isRegister(d) || d === 'R8') return NOT_NAMED
      if (s === 'I' || s === 'M') return 'ok'
      return width(s) === width(d) ? 'ok' : NOT_NAMED
    }

    /** `movzx d, s` and `movsx d, s`. */
    function extend(mnemonic: 'movzx' | 'movsx', d: Kind, s: Kind): Verdict {
      if (!isRegister(d) || d === 'R8' || s === 'I') return NOT_NAMED
      if (s === 'M') return 'missing-size'
      const from = width(s) ?? 0
      const to = width(d) ?? 0
      if (from >= to) return 'size-mismatch'
      if (from === 8 || from === 16) return 'ok'
      // 32 bits into 64 bits: only `movsx` has this form.
      return mnemonic === 'movsx' ? 'ok' : NOT_NAMED
    }

    /** `lea d, s`: d is a register of 16/32/64 bits and s is memory. */
    function lea(d: Kind, s: Kind): Verdict {
      return isRegister(d) && d !== 'R8' && isMemory(s) ? 'ok' : 'invalid-operands'
    }

    /** One line of text when `statement` does not get the verdict of the table, else null. */
    function problem(statement: string, verdict: Verdict): string | null {
      const result = assemble(around(statement))
      const errors = result.diagnostics.filter((d) => d.severity === 'error')
      const got = result.ok ? 'ok' : errors.map((e) => `${e.code} on line ${e.line}`).join(' and ')
      const allowed = (Array.isArray(verdict) ? verdict : [verdict]).map((code) =>
        code === 'ok' ? 'ok' : `${code} on line 3`,
      )
      if (allowed.includes(got)) return null
      return `\`${statement}\` gave ${got}, but the table says ${allowed.join(' or ')}`
    }

    /** Checks every pair of operand kinds of one instruction. */
    function pairs(mnemonic: string, rule: (d: Kind, s: Kind) => Verdict): string[] {
      return KINDS.flatMap((d) =>
        KINDS.map((s) => problem(`${mnemonic} ${DESTINATION[d]}, ${SOURCE[s]}`, rule(d, s))),
      ).filter((line) => line !== null)
    }

    it.each(['mov', 'add', 'sub', 'cmp', 'and', 'or', 'xor', 'test'])(
      'all 100 pairs of operand kinds for `%s`',
      (mnemonic) => {
        expect(pairs(mnemonic, generic)).toEqual([])
      },
    )

    it('all 100 pairs of operand kinds for `imul`', () => {
      expect(pairs('imul', imul)).toEqual([])
    })

    it.each(['movzx', 'movsx'] as const)('all 100 pairs of operand kinds for `%s`', (mnemonic) => {
      expect(pairs(mnemonic, (d, s) => extend(mnemonic, d, s))).toEqual([])
    })

    it('all 100 pairs of operand kinds for `lea`', () => {
      expect(pairs('lea', lea)).toEqual([])
    })

    it.each(['inc', 'dec'])('every operand kind for `%s`', (mnemonic) => {
      const problems = KINDS.map((d) =>
        problem(
          `${mnemonic} ${DESTINATION[d]}`,
          d === 'I' ? NOT_NAMED : d === 'M' ? ['missing-size', 'invalid-operands'] : 'ok',
        ),
      ).filter((line) => line !== null)
      expect(problems).toEqual([])
    })

    it('every operand kind for `push` and `pop`', () => {
      const problems = KINDS.flatMap((d) => [
        problem(`push ${DESTINATION[d]}`, d === 'R64' || d === 'I' ? 'ok' : 'push-pop-operand'),
        problem(`pop ${DESTINATION[d]}`, d === 'R64' ? 'ok' : 'push-pop-operand'),
      ]).filter((line) => line !== null)
      expect(problems).toEqual([])
    })

    it('every wrong number of operands, for every instruction', () => {
      const COUNTS: [mnemonic: string, operands: number][] = [
        ...['mov', 'add', 'sub', 'cmp', 'and', 'or', 'xor', 'test', 'lea', 'movzx', 'movsx'].map(
          (mnemonic): [string, number] => [mnemonic, 2],
        ),
        ...['inc', 'dec', 'push', 'pop', 'jmp', 'je', 'jne', 'jle', 'jg', 'jb', 'call'].map(
          (mnemonic): [string, number] => [mnemonic, 1],
        ),
        ...['ret', 'nop', 'leave', 'endbr64'].map((mnemonic): [string, number] => [mnemonic, 0]),
      ]
      const problems: string[] = []
      for (const [mnemonic, operands] of COUNTS) {
        for (let count = 0; count <= 3; count++) {
          if (count === operands) continue
          const statement = `${mnemonic} ${['rax', 'rbx', 'rcx'].slice(0, count).join(', ')}`
          const line = problem(statement.trim(), 'operand-count')
          if (line !== null) problems.push(line)
        }
      }
      expect(problems).toEqual([])
    })
  })
})

/* ═════════════════ 6. One error per line, many lines ═════════════════ */

describe('6. One error per line, many lines', () => {
  it('reports three errors on three different lines, sorted by line', () => {
    const errors = errorsOf(
      src(
        HEADER, // 1
        'main:', // 2
        '    mov eax, ebx', // 3
        '    mov eax, bx', // 4  size-mismatch
        '    add rax, 1', // 5
        '    mov [rax], [rbx]', // 6  memory-to-memory
        '    push rbx', // 7
        '    pop eax', // 8  push-pop-operand
        '    ret', // 9
      ),
    )
    expect(errors.map((e) => [e.line, e.code])).toEqual([
      [4, 'size-mismatch'],
      [6, 'memory-to-memory'],
      [8, 'push-pop-operand'],
    ])
    for (const error of errors) expectFriendly(error)
    expect(at(errors, 1).message).toBe(
      "Line 6: you can't move memory into memory. Load it into a register first.",
    )
  })

  it('errors of different kinds come back sorted by line', () => {
    const errors = errorsOf(
      src(
        HEADER, // 1
        'main:', // 2
        '    jmp nowhere', // 3  undefined-symbol (known only after all labels are read)
        '    mov eax, 010', // 4  bad-number (seen while reading the line)
        '    mov [rax], [rbx]', // 5  memory-to-memory (seen while checking operands)
        '    movq rax, rbx', // 6  att-syntax
        '    shl eax, 1', // 7  unsupported-instruction
        '    mov eax, 1 ; one', // 8  comment-style
        '    call nothing', // 9  undefined-symbol
        '    ret', // 10
      ),
    )
    expect(errors.map((e) => [e.line, e.code])).toEqual([
      [3, 'undefined-symbol'],
      [4, 'bad-number'],
      [5, 'memory-to-memory'],
      [6, 'att-syntax'],
      [7, 'unsupported-instruction'],
      [8, 'comment-style'],
      [9, 'undefined-symbol'],
    ])
    for (const error of errors) expectFriendly(error)
  })

  it('errors in the data section and in the code are reported together', () => {
    const errors = errorsOf(
      src(
        HEADER, // 1
        '.data', // 2
        'small: .byte 256', // 3  immediate-too-large
        'text: .string "open', // 4  bad-string
        '.text', // 5
        'main:', // 6
        '    mov rex, 1', // 7  unknown-register
        '    ret', // 8
        'main:', // 9  duplicate-label
      ),
    )
    expect(errors.map((e) => [e.line, e.code])).toEqual([
      [3, 'immediate-too-large'],
      [4, 'bad-string'],
      [7, 'unknown-register'],
      [9, 'duplicate-label'],
    ])
  })

  it.each([
    'mov eex, 010',
    'movq %rax, $5',
    'mov [eax], [ebx]',
    'mov al, 256 ; too big',
    'push eax, ebx',
    'mvo %rax, 010 ; note',
    'mov [rax*3], [rbx*5]',
  ])('a line with two problems gives one error: `%s`', (statement) => {
    const errors = errorsOf(around(statement))
    expect(errors.map((e) => e.line)).toEqual([3])
    expectFriendly(at(errors, 0))
  })

  // Problems that are found at different moments: while reading the label, while reading
  // the operands, and after all the labels of the program are known.
  it.each([
    'main: mov eax, bx',
    'main: jmp nowhere',
    'main: mov [rax], [rbx]',
    'rax: mov eax, bx',
    'rax: jmp nowhere',
    '    mov rax, [nothere+alsonot]',
    '    jmp nowhere ; a comment in the wrong style',
    '    lea rdi, nothere[rip], rax',
  ])('problems of different kinds on one line give one error: `%s`', (line) => {
    const errors = errorsOf(src(HEADER, 'main:', '    ret', line))
    expect(errors.map((e) => e.line)).toEqual([4])
    expectFriendly(at(errors, 0))
  })

  it('problems of different kinds on one data line give one error', () => {
    const errors = errorsOf(
      src(
        HEADER, // 1
        '.data', // 2
        'x: .byte 1', // 3
        'x: .byte 256', // 4  the label is defined twice, and 256 does not fit
        'x: .quad nothere', // 5  the label is defined twice, and the name is unknown
        '.text', // 6
        'main:', // 7
        '    ret', // 8
      ),
    )
    expect(errors.map((e) => e.line)).toEqual([4, 5])
  })

  it('a bad line does not hide a later bad line', () => {
    const errors = errorsOf(
      src(
        HEADER, // 1
        'main:', // 2
        '    ??? what is this', // 3
        '    mov eax, 1', // 4
        '    mov [rax], 5', // 5  missing-size
        '    ret', // 6
      ),
    )
    expect(errors.map((e) => e.line)).toEqual([3, 5])
    expect(at(errors, 1).code).toBe('missing-size')
  })

  it('stops collecting after 20 errors', () => {
    const bad = Array.from({ length: 25 }, () => '    mov eax, 010')
    const errors = errorsOf(src(HEADER, 'main:', ...bad, '    ret'))
    expect(errors).toHaveLength(20)
    expect(errors.map((e) => e.line)).toEqual(Array.from({ length: 20 }, (_, i) => i + 3))
    expect(errors.every((e) => e.code === 'bad-number')).toBe(true)
  })

  it('exactly 20 bad lines give 20 errors, and 19 give 19', () => {
    for (const count of [19, 20]) {
      const bad = Array.from({ length: count }, () => '    pop eax')
      const errors = errorsOf(src(HEADER, 'main:', ...bad, '    ret'))
      expect(errors).toHaveLength(count)
    }
  })

  it('never returns more than 20 errors, whatever their kinds', () => {
    const kinds = [
      '    mov eax, 010',
      '    mov [rax], [rbx]',
      '    jmp nowhere',
      '    movq rax, rbx',
      '    pop eax',
      '    mov eex, 1',
    ]
    const bad = Array.from({ length: 60 }, (_, i) => at(kinds, i % kinds.length))
    const errors = errorsOf(src(HEADER, 'main:', ...bad, '    ret'))
    expect(errors).toHaveLength(20)
    const lines = errors.map((e) => e.line)
    expect(lines).toEqual([...lines].sort((a, b) => a - b))
    expect(new Set(lines).size).toBe(20)
  })

  it('all diagnostics are sorted by line, warnings included', () => {
    const result = assemble(
      src(
        'start:', // 1  (no `.intel_syntax`, no `main`: line 0 warnings if they are reported)
        '    .foobar', // 2  unknown-directive (warning)
        '    mov eax, bx', // 3  size-mismatch
        '    .whatever', // 4  unknown-directive (warning)
        '    pop eax', // 5  push-pop-operand
      ),
    )
    expect(result.ok).toBe(false)
    expect(result.program).toBeNull()
    const lines = result.diagnostics.map((d) => d.line)
    expect(lines).toEqual([...lines].sort((a, b) => a - b))
    expect(
      result.diagnostics.filter((d) => d.severity === 'error').map((d) => [d.line, d.code]),
    ).toEqual([
      [3, 'size-mismatch'],
      [5, 'push-pop-operand'],
    ])
  })

  it('warnings of a correct program are sorted by line too', () => {
    const result = assemble(
      src(
        'start:', // 1
        '    .first_unknown', // 2
        '    nop', // 3
        '    .second_unknown', // 4
        '    ret', // 5
      ),
    )
    if (!result.ok) throw new Error(`expected ok: ${show(result.diagnostics)}`)
    expect(result.diagnostics.map((d) => d.line)).toEqual([0, 0, 2, 4])
    expect(result.diagnostics.every((d) => d.severity === 'warning')).toBe(true)
    expect(result.program.warnings).toEqual(result.diagnostics)
  })

  describe('random programs with bad lines at known places (fixed seed)', () => {
    /** Lines that are correct wherever they stand. */
    const GOOD = [
      'push rbp',
      'mov rbp, rsp',
      'sub rsp, 16',
      'mov eax, 0',
      'mov rax, [rbp-8]',
      'mov [rbp-8], rdi',
      'add dword ptr [rbp-4], 1',
      'cmp eax, 10',
      'inc ecx',
      'imul eax, ebx',
      'movzx eax, al',
      'test eax, eax',
      'xor eax, eax',
      'lea rdi, 8[rsp]',
      'mov rax, 0x1122334455667788',
      'and rsp, -16',
      'push 5',
      'pop rbp',
      'call printf@PLT',
      'leave',
      'nop',
      'ret',
    ]
    /** Lines that are wrong wherever they stand, each with the one error it gets. */
    const BAD: [text: string, code: AssembleCode][] = [
      ['mov [rax], [rbx]', 'memory-to-memory'],
      ['mov eax, bx', 'size-mismatch'],
      ['pop eax', 'push-pop-operand'],
      ['mov eax, 010', 'bad-number'],
      ['movq rax, rbx', 'att-syntax'],
      ['mov %rax, %rbx', 'att-syntax'],
      ['shl eax, 1', 'unsupported-instruction'],
      ['mvo eax, 1', 'unknown-instruction'],
      ['mov rex, 1', 'unknown-register'],
      ['jmp nowhere', 'undefined-symbol'],
      ['mov [rax], 5', 'missing-size'],
      ['mov al, 256', 'immediate-too-large'],
      ['mov ah, sil', 'high-byte-rex'],
      ['lea rax, rbx', 'invalid-operands'],
      ['mov eax, 1 ; one', 'comment-style'],
      ['jmp rax', 'jump-target'],
      ['mov rax, [eax]', 'address-register'],
      ['mov rax, [rax*3]', 'bad-memory-operand'],
      ['mov 5, eax', 'immediate-destination'],
      ['push', 'operand-count'],
    ]

    interface Made {
      source: string
      /** The good instructions as "line text", in order. */
      good: string[]
      /** The bad lines as "line code", in order. */
      bad: string[]
      hasMain: boolean
      /** Set when no instruction follows `main:`: then `main:` gets a warning on its line. */
      emptyMainLine: number | null
    }

    /** A program of good lines, labels and jumps between them, with `badCount` bad lines. */
    function make(random: () => number, badCount: number): Made {
      const labels = between(random, 1, 6)
      const body: { text: string; code: AssembleCode | null; label: boolean }[] = []
      for (let i = between(random, 8, 40); i > 0; i--) {
        const jump = `${pick(random, ['jmp', 'je', 'jle', 'jne', 'call'])} L${between(random, 0, labels - 1)}`
        body.push({ text: random() < 0.15 ? jump : pick(random, GOOD), code: null, label: false })
      }
      // Every label is defined once, somewhere in the program.
      const place = (entry: (typeof body)[number]): void => {
        body.splice(between(random, 0, body.length), 0, entry)
      }
      for (let k = 0; k < labels; k++) place({ text: `L${k}:`, code: null, label: true })
      const hasMain = random() < 0.5
      if (hasMain) place({ text: 'main:', code: null, label: true })
      for (let k = 0; k < badCount; k++) {
        const [text, code] = pick(random, BAD)
        place({ text, code, label: false })
      }
      // Line 1 is the header, so entry i of the body is line i + 2.
      const lines = body.map((entry) => (entry.label ? entry.text : `    ${entry.text}`))
      const numbered = body.map((entry, i) => ({ ...entry, line: i + 2 }))
      const mainAt = numbered.findIndex((e) => e.text === 'main:')
      const mainAtEnd = mainAt !== -1 && numbered.slice(mainAt).every((e) => e.label)
      return {
        source: src(HEADER, ...lines),
        good: numbered.filter((e) => !e.label && e.code === null).map((e) => `${e.line} ${e.text}`),
        bad: numbered.filter((e) => e.code !== null).map((e) => `${e.line} ${e.code}`),
        hasMain,
        emptyMainLine: mainAtEnd ? numbered[mainAt].line : null,
      }
    }

    it('60 programs without a bad line assemble, and every instruction is on its line', () => {
      const random = makeRandom(60)
      for (let i = 0; i < 60; i++) {
        const { source, good, hasMain, emptyMainLine } = make(random, 0)
        const result = assemble(source)
        if (!result.ok) throw new Error(`expected ok:\n${source}\n${show(result.diagnostics)}`)
        // Changed by the emulator owner (M8): a `main:` with no instruction after it now
        // gets a warning on its line (the program would have nothing to run).
        const mainWarnings = !hasMain
          ? ['warning no-main on line 0']
          : emptyMainLine !== null
            ? [`warning no-main on line ${emptyMainLine}`]
            : []
        expect(result.diagnostics.map((d) => `${d.severity} ${d.code} on line ${d.line}`)).toEqual(
          mainWarnings,
        )
        expect(result.program.instructions.map((ins) => `${ins.line} ${ins.text}`)).toEqual(good)
        expect(result.program.entryLabel).toBe(hasMain ? 'main' : null)
        expectSoundProgram(result.program, result.diagnostics)
      }
    })

    it.each([1, 2, 3, 5, 10, 19, 20])(
      '20 programs with %i bad lines: exactly those lines are reported, in order',
      (badCount) => {
        const random = makeRandom(1000 + badCount)
        for (let i = 0; i < 20; i++) {
          const { source, bad } = make(random, badCount)
          const errors = errorsOf(source)
          expect(
            errors.map((e) => `${e.line} ${e.code}`),
            `${source}\n${show(errors)}`,
          ).toEqual(bad)
          for (const error of errors) expectFriendly(error)
        }
      },
    )

    it.each([21, 30, 60])(
      '20 programs with %i bad lines: 20 of them are reported, in order',
      (badCount) => {
        const random = makeRandom(2000 + badCount)
        for (let i = 0; i < 20; i++) {
          const { source, bad } = make(random, badCount)
          const got = errorsOf(source).map((e) => `${e.line} ${e.code}`)
          expect(got).toHaveLength(20)
          // Each reported error is one of the bad lines, and they come in the order of the lines.
          expect(bad.filter((entry) => got.includes(entry))).toEqual(got)
        }
      },
    )
  })
})

/* ═══════════════════════════════ 7. Sizes ═══════════════════════════════ */

describe('7. Sizes', () => {
  interface SizeRow {
    code: string
    bytes: number
    before: string[]
  }

  const row = (code: string, bytes: number, before: string[] = []): SizeRow => ({
    code,
    bytes,
    before,
  })

  describe('the reference values of the contract', () => {
    const REFERENCE: SizeRow[] = [
      row('push rbx', 1), // 53
      row('push r12', 2), // 41 54
      row('pop rbp', 1), // 5D
      row('mov rbp, rsp', 3), // 48 89 E5
      row('mov eax, ebx', 2), // 89 D8
      row('mov eax, 0', 5), // B8 imm32
      row('mov rax, 5', 7), // 48 C7 C0 imm32
      row('mov rax, 0x1122334455667788', 10), // 48 B8 imm64
      row('mov al, 7', 2), // B0 07
      row('mov sil, 7', 3), // 40 B6 07
      row('mov ax, 7', 4), // 66 B8 imm16
      row('mov r8d, 7', 6), // 41 B8 imm32
      row('sub rsp, 16', 4), // 48 83 EC 10
      row('add rax, rbx', 3), // 48 01 D8
      row('add eax, 5', 3), // 83 C0 05
      row('add eax, 1000', 5), // 05 imm32
      row('cmp rax, 10', 4), // 48 83 F8 0A
      row('lea rdi, message[rip]', 7, RODATA), // 48 8D 3D disp32
      row('lea rdi, 8[rsp]', 5), // 48 8D 7C 24 08
      row('lea rax, [rbp-8]', 4), // 48 8D 45 F8
      row('mov eax, [rbp-4]', 3), // 8B 45 FC
      row('mov rax, [rbp-8]', 4), // 48 8B 45 F8
      row('mov [rbp-8], rax', 4), // 48 89 45 F8
      row('mov rax, [rsp]', 4), // 48 8B 04 24
      row('mov rax, [rax]', 3), // 48 8B 00
      row('mov dword ptr [rbp-4], 5', 7), // C7 45 FC imm32
      row('mov qword ptr [rbp-8], 5', 8), // 48 C7 45 F8 imm32
      row('mov byte ptr [rbp-1], 5', 4), // C6 45 FF 05
      row('mov rax, [rdi+rcx*8]', 4), // 48 8B 04 CF
      row('inc rax', 3), // 48 FF C0
      row('dec ecx', 2), // FF C9
      row('imul rax, rbx', 4), // 48 0F AF C3
      row('imul eax, ebx', 3), // 0F AF C3
      row('movzx eax, al', 3), // 0F B6 C0
      row('movsx rax, al', 4), // 48 0F BE C0
      row('test rax, rax', 3), // 48 85 C0
      row('xor eax, eax', 2), // 31 C0
      row('call printf@PLT', 5), // E8 rel32
      row('ret', 1), // C3
      // Values given in the text of section 5 of the contract.
      row('cmp al, 5', 2), // 3C 05
      row('add rax, 1000', 6), // 48 05 imm32
      row('test al, 1', 2), // A8 01
      row('test eax, 1', 5), // A9 imm32
      row('inc eax', 2), // FF C0
      row('inc al', 2), // FE C0
      row('call main', 5), // E8 rel32
      row('nop', 1), // 90
      row('leave', 1), // C9
      row('endbr64', 4), // F3 0F 1E FA
    ]

    it.each(REFERENCE)('`$code` is $bytes bytes', ({ code, bytes, before }) => {
      expect(one(code, before).size).toBe(bytes)
    })
  })

  describe('more sizes worked out from the rules', () => {
    const DERIVED: SizeRow[] = [
      // push and pop
      row('push rbp', 1), // 55
      row('push r8', 2), // 41 50
      row('push r15', 2), // 41 57
      row('pop rbx', 1), // 5B
      row('pop r12', 2), // 41 5C
      row('pop r15', 2), // 41 5F
      row('push 5', 2), // 6A 05
      row('push -1', 2), // 6A FF
      row('push 127', 2),
      row('push -128', 2),
      row('push 128', 5), // 68 imm32
      row('push -129', 5),
      row('push 1000', 5),
      // mov register, register
      row('mov rax, rdi', 3), // 48 89 F8
      row('mov al, bl', 2), // 88 D8
      row('mov ah, bl', 2), // 88 DC
      row('mov ax, bx', 3), // 66 89 D8
      row('mov r8, rax', 3), // 49 89 C0
      row('mov eax, r8d', 3), // 44 89 C0
      row('mov sil, al', 3), // 40 88 C6
      row('mov r9b, al', 3), // 41 88 C1
      row('mov r10w, ax', 4), // 66 41 89 C2
      // mov register, number
      row('mov eax, -1', 5),
      row('mov ecx, 0xffffffff', 5),
      row('mov ah, 5', 2), // B4 05
      row('mov r9b, 7', 3), // 41 B1 07
      row('mov bx, 0xffff', 4), // 66 BB imm16
      row('mov r8w, 7', 5), // 66 41 B8 imm16
      row('mov r8, 5', 7), // 49 C7 C0 imm32
      row('mov r10, 0x1122334455667788', 10), // 49 BA imm64
      row('mov rax, -1', 7), // 48 C7 C0 FF FF FF FF
      row('mov rax, 0x7fffffff', 7),
      row('mov rax, -2147483648', 7),
      row('mov rax, 0x80000000', 10), // does not fit signed 32 bits
      row('mov rax, -2147483649', 10),
      row('mov rax, 0x100000000', 10),
      // mov with memory
      row('mov [rbp-4], edi', 3), // 89 7D FC
      row('mov eax, dword ptr [rbp-4]', 3),
      row('mov rax, [rbx+8]', 4), // 48 8B 43 08
      row('mov rax, [rbx+rcx*8+16]', 5), // 48 8B 44 CB 10
      row('mov eax, [r12]', 4), // 41 8B 04 24 (r12 base needs SIB)
      row('mov eax, [r13]', 4), // 41 8B 45 00 (r13 base needs a displacement)
      row('mov eax, [r8]', 3), // 41 8B 00
      row('mov al, [rax]', 2), // 8A 00
      row('mov ax, [rax]', 3), // 66 8B 00
      row('mov rax, [rbp]', 4), // 48 8B 45 00 (rbp base needs a displacement)
      row('mov rax, [rsp+8]', 5), // 48 8B 44 24 08
      row('mov [rsp], rax', 4), // 48 89 04 24
      row('mov eax, [rsp+0x100]', 7), // 8B 84 24 disp32
      row('mov rax, [rax+127]', 4), // disp8
      row('mov rax, [rax+128]', 7), // disp32
      row('mov rax, [rax-128]', 4), // disp8
      row('mov rax, [rax-129]', 7), // disp32
      row('mov rax, [rbp-128]', 4),
      row('mov rax, [rbp-136]', 7),
      row('mov rax, -8[rbp]', 4),
      row('mov rax, count[rbp]', 4, EQUS),
      row('mov rax, message[rip]', 7, RODATA), // 48 8B 05 disp32
      row('mov eax, message[rip]', 6, RODATA), // 8B 05 disp32
      row('mov al, message[rip]', 6, RODATA), // 8A 05 disp32
      row('mov rax, array[rax*8]', 8, DATA), // 48 8B 04 C5 disp32
      row('mov rax, [8*rcx]', 8), // 48 8B 04 CD disp32
      row('mov eax, counter', 7, DATA), // 8B 04 25 disp32
      row('mov rax, counter', 8, DATA), // 48 8B 04 25 disp32
      row('mov counter, eax', 7, DATA), // 89 04 25 disp32
      row('mov eax, [rax+r9*4]', 4), // 42 8B 04 88
      row('mov rax, [r13+8]', 4), // 49 8B 45 08
      row('mov [r8], eax', 3), // 41 89 00
      row('mov rax, [r13+rcx]', 5), // 49 8B 44 0D 00
      // mov memory, number
      row('mov word ptr [rbp-2], 5', 6), // 66 C7 45 FE imm16
      row('mov qword ptr [rsp], 0', 8), // 48 C7 04 24 imm32
      row('mov dword ptr [rax], 1', 6), // C7 00 imm32
      row('mov byte ptr [rax], 0', 3), // C6 00 00
      row('mov qword ptr [rax], -1', 7), // 48 C7 00 imm32
      row('mov dword ptr [rsp+4], 0', 8), // C7 44 24 04 imm32
      row('mov dword ptr message[rip], 5', 10, RODATA), // C7 05 disp32 imm32
      row('mov dword ptr counter, 5', 11, DATA), // C7 04 25 disp32 imm32
      // add sub cmp and or xor: register, register
      row('add eax, ebx', 2), // 01 D8
      row('sub rax, rcx', 3), // 48 29 C8
      row('cmp eax, ebx', 2),
      row('and al, bl', 2), // 20 D8
      row('or ax, bx', 3), // 66 09 D8
      row('xor rax, rax', 3), // 48 31 C0
      row('xor r8d, r8d', 3), // 45 31 C0
      row('add r8, rax', 3), // 49 01 C0
      row('cmp r12, r13', 3), // 4D 39 EC
      row('add sil, al', 3), // 40 00 C6
      // add sub cmp and or xor: number
      row('sub rsp, 8', 4),
      row('add rsp, 16', 4),
      row('sub rsp, 32', 4),
      row('sub rsp, 127', 4),
      row('sub rsp, 128', 7), // 48 81 EC imm32
      row('sub rsp, 1000', 7),
      row('and rsp, -16', 4), // 48 83 E4 F0
      row('cmp eax, 0', 3), // 83 F8 00
      row('cmp eax, -1', 3),
      row('cmp eax, 1000', 5), // 3D imm32
      row('cmp ecx, 1000', 6), // 81 F9 imm32
      row('cmp rcx, 10', 4),
      row('add al, 5', 2), // 04 05
      row('add bl, 5', 3), // 80 C3 05
      row('add ah, 1', 3), // 80 C4 01
      row('add ax, 5', 4), // 66 83 C0 05
      row('add ax, 1000', 4), // 66 05 imm16
      row('add bx, 1000', 5), // 66 81 C3 imm16
      row('add ebx, 1000', 6), // 81 C3 imm32
      row('add rbx, 1000', 7), // 48 81 C3 imm32
      row('add rax, 127', 4), // 48 83 C0 7F
      row('add rax, 128', 6), // 48 05 imm32
      row('add eax, 127', 3),
      row('add eax, 128', 5),
      row('add eax, -128', 3),
      row('add eax, -129', 5),
      row('sub eax, 1', 3),
      row('and eax, 15', 3), // 83 E0 0F
      row('and eax, 0xff', 5), // 25 imm32 (255 does not fit a signed byte)
      row('or al, 0x80', 2), // 0C 80
      row('xor al, 1', 2), // 34 01
      row('cmp ax, 1000', 4), // 66 3D imm16
      row('cmp bx, 5', 4), // 66 83 FB 05
      row('cmp cl, 5', 3), // 80 F9 05
      row('cmp rax, 1000', 6), // 48 3D imm32
      row('cmp r8, 5', 4), // 49 83 F8 05
      row('cmp r8d, 5', 4), // 41 83 F8 05
      row('add r8b, 5', 4), // 41 80 C0 05
      row('cmp sil, 5', 4), // 40 80 FE 05
      // add sub cmp and or xor: memory
      row('add rax, [rbx]', 3), // 48 03 03
      row('add [rbx], rax', 3), // 48 01 03
      row('cmp eax, [rbp-4]', 3), // 3B 45 FC
      row('xor [rbp-4], eax', 3), // 31 45 FC
      row('cmp dword ptr [rbp-4], 10', 4), // 83 7D FC 0A
      row('cmp dword ptr [rbp-4], 1000', 7), // 81 7D FC imm32
      row('add dword ptr [rbp-4], 1', 4), // 83 45 FC 01
      row('add qword ptr [rbp-8], 1', 5), // 48 83 45 F8 01
      row('cmp qword ptr [rbp-8], 0', 5),
      row('cmp qword ptr [rbp-8], 1000', 8), // 48 81 7D F8 imm32
      row('cmp byte ptr [rax], 0', 3), // 80 38 00
      row('cmp word ptr [rax], 5', 4), // 66 83 38 05
      row('cmp word ptr [rax], 1000', 5), // 66 81 38 imm16
      row('sub qword ptr [rsp], 1', 5), // 48 83 2C 24 01
      // test
      row('test eax, eax', 2), // 85 C0
      row('test al, al', 2), // 84 C0
      row('test rax, rbx', 3),
      row('test ebx, 1', 6), // F7 C3 imm32
      row('test bl, 1', 3), // F6 C3 01
      row('test ax, 1', 4), // 66 A9 imm16
      row('test bx, 1', 5), // 66 F7 C3 imm16
      row('test rax, 1', 6), // 48 A9 imm32
      row('test rbx, 1', 7), // 48 F7 C3 imm32
      row('test byte ptr [rax], 1', 3), // F6 00 01
      row('test dword ptr [rbp-4], 1', 7), // F7 45 FC imm32
      row('test [rax], ebx', 2), // 85 18
      row('test eax, [rbx]', 2), // 85 03
      // inc and dec
      row('inc ax', 3), // 66 FF C0
      row('inc r8', 3), // 49 FF C0
      row('inc r8d', 3), // 41 FF C0
      row('inc sil', 3), // 40 FE C6
      row('dec rcx', 3),
      row('dec al', 2),
      row('dec dword ptr [rbp-4]', 3), // FF 4D FC
      row('dec qword ptr [rbp-8]', 4), // 48 FF 4D F8
      row('inc qword ptr [rax]', 3), // 48 FF 00
      row('inc byte ptr [rax]', 2), // FE 00
      row('inc word ptr [rax]', 3), // 66 FF 00
      row('inc dword ptr [rsp]', 3), // FF 04 24
      // imul
      row('imul ax, bx', 4), // 66 0F AF C3
      row('imul r8, rax', 4), // 4C 0F AF C0
      row('imul eax, [rbp-4]', 4), // 0F AF 45 FC
      row('imul eax, dword ptr [rbp-4]', 4),
      row('imul rax, [rbp-8]', 5), // 48 0F AF 45 F8
      row('imul eax, 5', 3), // 6B C0 05
      row('imul rax, 5', 4), // 48 6B C0 05
      row('imul ax, 5', 4), // 66 6B C0 05
      row('imul eax, 1000', 6), // 69 C0 imm32
      row('imul rax, 1000', 7), // 48 69 C0 imm32
      row('imul ax, 1000', 5), // 66 69 C0 imm16
      // movzx and movsx
      row('movzx eax, bx', 3), // 0F B7 C3
      row('movzx ax, bl', 4), // 66 0F B6 C3
      row('movzx rax, bl', 4), // 48 0F B6 C3
      row('movzx r8d, al', 4), // 44 0F B6 C0
      row('movzx eax, sil', 4), // 40 0F B6 C6
      row('movzx eax, byte ptr [rbp-1]', 4), // 0F B6 45 FF
      row('movzx eax, word ptr [rbp-2]', 4), // 0F B7 45 FE
      row('movsx eax, bl', 3), // 0F BE C3
      row('movsx eax, bx', 3), // 0F BF C3
      row('movsx ax, bl', 4), // 66 0F BE C3
      row('movsx rax, bx', 4), // 48 0F BF C3
      row('movsx rax, eax', 3), // 48 63 C0 (one opcode byte)
      row('movsxd rax, ebx', 3), // 48 63 C3
      row('movsx eax, word ptr [rax]', 3), // 0F BF 00
      row('movsx rax, byte ptr [rbp-1]', 5), // 48 0F BE 45 FF
      row('movsx rax, dword ptr [rbp-4]', 4), // 48 63 45 FC
      row('movsxd rax, dword ptr [rbp-4]', 4),
      // lea
      row('lea eax, [rbx]', 2), // 8D 03
      row('lea ax, [rbx]', 3), // 66 8D 03
      row('lea r8, [rbx]', 3), // 4C 8D 03
      row('lea rax, [rbx+8]', 4), // 48 8D 43 08
      row('lea rax, [rbx+rcx*4]', 4), // 48 8D 04 8B
      row('lea rax, [rax+rax*2]', 4), // 48 8D 04 40
      row('lea rax, [rdi+rsi]', 4), // 48 8D 04 37
      row('lea eax, [rdi+rsi]', 3), // 8D 04 37
      row('lea rdx, [rbp-16]', 4), // 48 8D 55 F0
      row('lea rax, [rbp-200]', 7), // 48 8D 85 disp32
      row('lea rax, [rsp]', 4), // 48 8D 04 24
      row('lea rsi, [rsp+4]', 5), // 48 8D 74 24 04
      row('lea rax, [r12+8]', 5), // 49 8D 44 24 08
      row('lea rax, [r8+r9]', 4), // 4B 8D 04 08
      row('lea rax, [rbp+rcx]', 5), // 48 8D 44 0D 00
      row('lea rax, [rcx*8]', 8), // 48 8D 04 CD disp32
      row('lea rax, array[rip]', 7, DATA),
      // the rest
      row('call puts', 5),
      row('call exit@PLT', 5),
      row('jmp main', 2), // EB rel8
      row('je main', 2), // 74 rel8
    ]

    it.each(DERIVED)('`$code` is $bytes bytes', ({ code, bytes, before }) => {
      expect(one(code, before).size).toBe(bytes)
    })
  })

  describe('sizes of lines from everyday programs', () => {
    const EVERYDAY: SizeRow[] = [
      // locals, the way gcc writes them
      row('mov dword ptr -4[rbp], 0', 7), // C7 45 FC imm32
      row('mov eax, dword ptr -4[rbp]', 3), // 8B 45 FC
      row('cmp dword ptr [rbp-4], 9', 4), // 83 7D FC 09
      row('mov [rbp-8], rdi', 4), // 48 89 7D F8
      row('mov rdi, [rbp-8]', 4), // 48 8B 7D F8
      row('cmp qword ptr [rbp-8], 1', 5), // 48 83 7D F8 01
      row('imul rax, [rbp-8]', 5), // 48 0F AF 45 F8
      row('mov [rbp], rax', 4), // 48 89 45 00
      row('inc byte ptr [rbp-1]', 3), // FE 45 FF
      row('dec word ptr [rbp-2]', 4), // 66 FF 4D FE
      // arguments and results
      row('mov rdi, rax', 3), // 48 89 C7
      row('mov esi, eax', 2), // 89 C6
      row('mov edi, 0', 5), // BF imm32
      row('xor edi, edi', 2), // 31 FF
      row('dec rdi', 3), // 48 FF CF
      // the stack pointer
      row('sub rsp, -128', 4), // 48 83 EC 80
      row('add rsp, 0x80', 7), // 48 81 C4 imm32 (128 does not fit a signed byte)
      row('mov rax, [rsp+rcx*8]', 4), // 48 8B 04 CC
      row('cmp qword ptr [rsp+8], -1', 6), // 48 83 7C 24 08 FF
      row('test byte ptr [rsp], 1', 4), // F6 04 24 01
      row('movsx rax, word ptr [rsp]', 5), // 48 0F BF 04 24
      // labels as memory
      row('lea rdi, message', 8, RODATA), // 48 8D 3C 25 disp32
      row('lea rax, main[rip]', 7), // 48 8D 05 disp32
      row('mov eax, [counter]', 7, DATA), // 8B 04 25 disp32
      row('mov rax, [counter+4]', 8, DATA), // 48 8B 04 25 disp32
      row('inc dword ptr counter[rip]', 6, DATA), // FF 05 disp32
      row('add qword ptr counter[rip], 1', 8, DATA), // 48 83 05 disp32 01
      row('cmp byte ptr message[rip], 0', 7, RODATA), // 80 3D disp32 00
      // strings and arrays
      row('cmp byte ptr [rdi+rcx], 0', 4), // 80 3C 0F 00
      row('movzx eax, byte ptr [rdi+rcx]', 4), // 0F B6 04 0F
      row('mov eax, [rbp+rax*4-4]', 4), // 8B 44 85 FC
      row('mov rax, [rbx*8+rax]', 4), // 48 8B 04 D8
      row('mov rax, [16+rax]', 4), // 48 8B 40 10
      // characters
      row("mov al, 'A'", 2), // B0 41
      row("cmp al, 'a'", 2), // 3C 61
      row("mov rax, 'A'", 7), // 48 C7 C0 imm32
      // r8 to r15
      row('mov rax, [r12+rax*2]', 4), // 49 8B 04 44
      row('mov rax, [r13+r14*8+0x80]', 8), // 4B 8B 84 F5 disp32
      row('mov byte ptr [r13], 1', 5), // 41 C6 45 00 01
      row('mov eax, [r13+r12]', 5), // 43 8B 44 25 00
      row('mov eax, [r12+r13]', 4), // 43 8B 04 2C
      row('lea r15, [r14+r13*8-8]', 5), // 4F 8D 7C EE F8
      row('movzx r8, byte ptr [r9]', 4), // 4D 0F B6 01
      row('inc qword ptr [r12]', 4), // 49 FF 04 24
      row('mov r15, -1', 7), // 49 C7 C7 imm32
      row('mov r15d, -1', 6), // 41 BF imm32
      row('and r12, -16', 4), // 49 83 E4 F0
      row('cmp r13b, 0', 4), // 41 80 FD 00
      row('imul r8d, r9d', 4), // 45 0F AF C1
      row('test r8b, r8b', 3), // 45 84 C0
      row('test r8d, 1', 7), // 41 F7 C0 imm32
      // the low bytes that need a REX prefix
      row('mov bpl, 1', 3), // 40 B5 01
      row('test sil, 1', 4), // 40 F6 C6 01
      // the edges of the short number form of `imul`
      row('imul eax, 127', 3), // 6B C0 7F
      row('imul eax, 128', 6), // 69 C0 imm32
      row('imul eax, -128', 3), // 6B C0 80
      row('imul eax, -129', 6), // 69 C0 imm32
      // `test` and `mov` with a number have no short form
      row('test qword ptr [rax], 1', 7), // 48 F7 00 imm32
      row('test word ptr [rax], 1', 5), // 66 F7 00 imm16
      row('mov word ptr [rax], 1', 5), // 66 C7 00 imm16
    ]

    it.each(EVERYDAY)('`$code` is $bytes bytes', ({ code, bytes, before }) => {
      expect(one(code, before).size).toBe(bytes)
    })
  })

  describe('short and long jumps', () => {
    const BASE = 0x401126n

    it.each<[string, number, number]>([
      ['jmp', 0, 2],
      ['jmp', 1, 2],
      ['jmp', 127, 2],
      ['jmp', 128, 5],
      ['jmp', 200, 5],
      ['je', 0, 2],
      ['je', 127, 2],
      ['je', 128, 6],
      ['jne', 127, 2],
      ['jne', 128, 6],
      ['jz', 127, 2],
      ['jz', 128, 6],
      ['jle', 500, 6],
    ])('a forward `%s` over %i bytes of code is %i bytes long', (mnemonic, gap, bytes) => {
      const program = ok(
        src(HEADER, 'main:', `    ${mnemonic} done`, ...nops(gap), 'done:', '    ret'),
      )
      const jump = at(program.instructions, 0)
      expect(jump.size).toBe(bytes)
      const done = BASE + BigInt(bytes + gap)
      expect(hex(targetAt(jump, 0).address)).toBe(hex(done))
      expect(hex(at(program.instructions, -1).address)).toBe(hex(done))
      expect(hex(program.layout.textEnd)).toBe(hex(done + 1n))
    })

    it.each<[string, number, number]>([
      ['jmp', 0, 2],
      ['jmp', 126, 2],
      ['jmp', 127, 5],
      ['jmp', 300, 5],
      ['jl', 0, 2],
      ['jl', 126, 2],
      ['jl', 127, 6],
      ['jne', 126, 2],
      ['jne', 127, 6],
      ['jnz', 126, 2],
      ['jnz', 127, 6],
      ['jg', 300, 6],
    ])('a backward `%s` over %i bytes of code is %i bytes long', (mnemonic, gap, bytes) => {
      const program = ok(
        src(HEADER, 'main:', 'top:', ...nops(gap), `    ${mnemonic} top`, '    ret'),
      )
      const jump = at(program.instructions, gap)
      expect(hex(jump.address)).toBe(hex(BASE + BigInt(gap)))
      expect(jump.size).toBe(bytes)
      expect(hex(targetAt(jump, 0).address)).toBe(hex(BASE))
      expect(hex(program.layout.textEnd)).toBe(hex(BASE + BigInt(gap + bytes + 1)))
    })

    const CONDITIONAL: Mnemonic[] = [
      'je',
      'jne',
      'jg',
      'jge',
      'jl',
      'jle',
      'ja',
      'jae',
      'jb',
      'jbe',
      'js',
      'jns',
      'jo',
      'jno',
    ]

    it.each(CONDITIONAL)(
      '`%s` is 2 bytes to a near label and 6 bytes to a far label',
      (mnemonic) => {
        const program = ok(
          src(
            HEADER,
            'main:',
            `    ${mnemonic} near`, // 2 bytes
            'near:',
            `    ${mnemonic} far`, // 6 bytes
            ...nops(130),
            'far:',
            '    ret',
          ),
        )
        const [near, far] = [at(program.instructions, 0), at(program.instructions, 1)]
        expect(near.mnemonic).toBe(mnemonic)
        expect(near.size).toBe(2)
        expect(far.size).toBe(6)
        expect(hex(targetAt(near, 0).address)).toBe(hex(BASE + 2n))
        expect(hex(targetAt(far, 0).address)).toBe(hex(BASE + 2n + 6n + 130n))
      },
    )

    it('real instructions between a jump and its target: more than 127 bytes makes it long', () => {
      // 13 instructions of 10 bytes are 130 bytes.
      const body = Array.from({ length: 13 }, () => '    mov rax, 0x1122334455667788')
      const program = ok(
        src(
          HEADER,
          'main:',
          '    jmp end', // 5 bytes: 130 bytes to skip
          '    je end', // 6 bytes: 130 bytes to skip
          ...body,
          'end:',
          '    ret',
        ),
      )
      expect(at(program.instructions, 0).size).toBe(5)
      expect(at(program.instructions, 1).size).toBe(6)
      expect(hex(symbolOf(program, 'end').address)).toBe(hex(BASE + 5n + 6n + 130n))
    })

    it('a loop with a long body needs a long jump back, a short body a short one', () => {
      const long = ok(
        src(
          HEADER,
          'main:',
          '    mov ecx, 0', // 5
          'top:',
          ...Array.from({ length: 13 }, () => '    mov rax, 0x1122334455667788'), // 130
          '    inc ecx', // 2
          '    cmp ecx, 10', // 3
          '    jl top', // 135 bytes back, plus the jump itself
          '    ret',
        ),
      )
      const jump = at(long.instructions, 16)
      expect(jump.text).toBe('jl top')
      expect(jump.size).toBe(6)
      expect(hex(targetAt(jump, 0).address)).toBe(hex(BASE + 5n))
      expect(hex(long.layout.textEnd)).toBe(hex(BASE + 5n + 130n + 2n + 3n + 6n + 1n))

      const short = ok(
        src(
          HEADER,
          'main:',
          '    mov ecx, 0',
          'top:',
          ...Array.from({ length: 12 }, () => '    mov rax, 0x1122334455667788'), // 120
          '    inc ecx', // 2
          '    cmp ecx, 10', // 3
          '    jl top', // 125 + 2 = 127 bytes back: still short
          '    ret',
        ),
      )
      expect(at(short.instructions, 15).size).toBe(2)
    })

    it('a jump that grows can push another jump out of reach', () => {
      // J2 must be long (128 bytes to skip). With a short J2, J1 would skip 125 bytes.
      // With the long J2, J1 has to skip 123 + 5 = 128 bytes, so J1 must be long too.
      const program = ok(
        src(
          HEADER,
          'main:',
          '    jmp a', // J1
          ...nops(123),
          '    jmp b', // J2
          'a:',
          ...nops(128),
          'b:',
          '    ret',
        ),
      )
      const first = at(program.instructions, 0)
      const second = at(program.instructions, 124)
      expect(second.text).toBe('jmp b')
      expect(second.size).toBe(5)
      expect(first.size).toBe(5)
      expect(hex(symbolOf(program, 'a').address)).toBe(hex(BASE + 5n + 123n + 5n))
      expect(hex(symbolOf(program, 'b').address)).toBe(hex(BASE + 5n + 123n + 5n + 128n))
      expect(hex(targetAt(first, 0).address)).toBe(hex(BASE + 133n))
      expect(hex(targetAt(second, 0).address)).toBe(hex(BASE + 261n))
    })

    it('a jump that stays in reach stays short next to a long one', () => {
      const program = ok(
        src(
          HEADER,
          'main:',
          '    jmp a', // 122 + 5 = 127 bytes to skip: short
          ...nops(122),
          '    jmp b', // 128 bytes to skip: long
          'a:',
          ...nops(128),
          'b:',
          '    ret',
        ),
      )
      expect(at(program.instructions, 0).size).toBe(2)
      expect(at(program.instructions, 123).size).toBe(5)
    })

    it('every address still adds up in a program with short and long jumps', () => {
      const program = ok(
        src(
          HEADER,
          'main:',
          '    je far',
          '    jmp near',
          'near:',
          ...nops(140),
          'far:',
          '    jne main',
          '    jmp far',
          '    ret',
        ),
      )
      let expected = BASE
      for (const ins of program.instructions) {
        expect(hex(ins.address)).toBe(hex(expected))
        expected += BigInt(ins.size)
      }
      expect(hex(program.layout.textEnd)).toBe(hex(expected))
      expect(program.instructions.filter((i) => i.mnemonic !== 'nop').map((i) => i.size)).toEqual([
        6, // je far: 2 + 140 bytes to skip
        2, // jmp near: next instruction
        6, // jne main: far back
        2, // jmp far: 8 bytes back
        1, // ret
      ])
    })

    it('`call` is 5 bytes whether the function is near or far', () => {
      const program = ok(
        src(
          HEADER,
          'main:',
          '    call helper',
          '    call far',
          ...nops(300),
          'helper:',
          'far:',
          '    ret',
        ),
      )
      expect(at(program.instructions, 0).size).toBe(5)
      expect(at(program.instructions, 1).size).toBe(5)
    })

    /**
     * A chain of jumps. Jump number i goes over 125 bytes of `nop` and over the next jump:
     * 127 bytes while the next jump is short, 130 or 131 bytes once it is long. The last
     * jump goes over `lastGap` bytes of `nop`.
     */
    function chain(count: number, lastGap: number): string {
      const lines = [HEADER, 'main:', '    jmp after0']
      for (let i = 1; i < count; i++) {
        lines.push(...nops(125), `    ${i % 2 === 0 ? 'jmp' : 'jne'} after${i}`, `after${i - 1}:`)
      }
      lines.push(...nops(lastGap), `after${count - 1}:`, '    ret')
      return src(...lines)
    }

    it('a chain of 12 jumps: when the last one grows, every one before it has to grow', () => {
      // The last jump goes over 128 bytes, so it is long. Then the jump before it goes over
      // 125 + 5 or 125 + 6 bytes, so it is long too, and so on back to the first one.
      const program = ok(chain(12, 128))
      const jumps = program.instructions.filter((i) => i.mnemonic !== 'nop' && i.mnemonic !== 'ret')
      expect(jumps.map((i) => i.mnemonic)).toEqual(
        Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 'jmp' : 'jne')),
      )
      expect(jumps.map((i) => i.size)).toEqual(
        Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 5 : 6)),
      )
      for (const [i, jump] of jumps.entries()) {
        const target = targetAt(jump, 0)
        expect(hex(target.address)).toBe(hex(symbolOf(program, `after${i}`).address))
        // Every one of these jumps really is out of reach of a short jump.
        expect(target.address - (jump.address + BigInt(jump.size))).toBeGreaterThan(127n)
      }
      // 6 `jmp` of 5 bytes, 6 `jne` of 6 bytes, 11 * 125 + 128 bytes of `nop`, and `ret`.
      expect(hex(program.layout.textEnd)).toBe(hex(0x401126n + 30n + 36n + 1375n + 128n + 1n))
    })

    it('the same chain stays short when the last jump reaches its label', () => {
      const program = ok(chain(12, 127))
      const jumps = program.instructions.filter((i) => i.mnemonic !== 'nop' && i.mnemonic !== 'ret')
      expect(jumps.map((i) => i.size)).toEqual(Array.from({ length: 12 }, () => 2))
      for (const jump of jumps) {
        expect(targetAt(jump, 0).address - (jump.address + 2n)).toBe(127n)
      }
    })

    it.each<[string, number]>([
      ['jmp', 5],
      ['jle', 6],
    ])('100 `%s` to one label: only the last 64 reach it with a short jump', (mnemonic, long) => {
      // 63 short jumps in between are 126 bytes: in reach. 64 short jumps are 128: too far.
      const program = ok(
        src(
          HEADER,
          'main:',
          ...Array.from({ length: 100 }, () => `    ${mnemonic} end`),
          'end:',
          '    ret',
        ),
      )
      expect(program.instructions.slice(0, 100).map((i) => i.size)).toEqual([
        ...Array.from({ length: 36 }, () => long),
        ...Array.from({ length: 64 }, () => 2),
      ])
      expect(hex(symbolOf(program, 'end').address)).toBe(hex(0x401126n + BigInt(36 * long + 128)))
    })

    it('40 random programs follow the rule "start short, grow until nothing changes"', () => {
      // Lines whose sizes are reference values of the contract.
      const FILL: [text: string, bytes: number][] = [
        ['push rbx', 1],
        ['mov eax, ebx', 2],
        ['mov rbp, rsp', 3],
        ['sub rsp, 16', 4],
        ['mov eax, 0', 5],
        ['mov rax, 5', 7],
        ['mov rax, 0x1122334455667788', 10],
      ]
      const JUMPS = ['jmp', 'je', 'jne', 'jle', 'jg', 'jb', 'jae', 'jz', 'jnz', 'js']
      interface Piece {
        text: string
        bytes: number
        /** For a jump: the size of its long form (0 for other lines), and its target. */
        long: number
        target: number
      }

      /**
       * The rule of the contract, worked out here: every jump starts short, and a jump that
       * does not reach its label grows, until nothing changes. Label `L<i>` is in front of
       * piece i, and `L<pieces.length>` is at the end. Returns where each label is.
       */
      function settle(pieces: Piece[]): number[] {
        for (const piece of pieces) if (piece.long > 0) piece.bytes = 2
        for (;;) {
          const starts = [0]
          for (const piece of pieces) starts.push(at(starts, -1) + piece.bytes)
          let changed = false
          pieces.forEach((piece, i) => {
            if (piece.long === 0 || piece.bytes !== 2) return
            const distance = at(starts, piece.target) - (at(starts, i) + 2)
            if (distance < -128 || distance > 127) {
              piece.bytes = piece.long
              changed = true
            }
          })
          if (!changed) return starts
        }
      }

      const failures: string[] = []
      /** How many jumps sit exactly on an edge: just in reach, or just out of reach. */
      const edges = { forwardShort: 0, forwardLong: 0, backwardShort: 0, backwardLong: 0 }
      for (let seed = 1; seed <= 40; seed++) {
        const random = makeRandom(seed)
        // Mostly `nop`, so that there is a label at nearly every distance from a jump.
        const pieces: Piece[] = []
        const slots = between(random, 150, 400)
        for (let i = 0; i < slots; i++) {
          const kind = random()
          if (kind < 0.06) {
            const mnemonic = pick(random, JUMPS)
            const target = between(random, 0, slots)
            pieces.push({ text: mnemonic, bytes: 2, long: mnemonic === 'jmp' ? 5 : 6, target })
          } else if (kind < 0.1) {
            const [text, bytes] = pick(random, FILL)
            pieces.push({ text, bytes, long: 0, target: -1 })
          } else {
            pieces.push({ text: 'nop', bytes: 1, long: 0, target: -1 })
          }
        }
        // Move most jumps to a label that is exactly as far away as a short jump reaches, or
        // one byte more, in the program as it is at that moment.
        let starts = settle(pieces)
        pieces.forEach((piece, i) => {
          if (piece.long === 0 || random() < 0.2) return
          const forward = random() < 0.5
          const address = forward
            ? at(starts, i + 1) + between(random, 127, 128) // bytes between the jump and the label
            : at(starts, i) - between(random, 126, 127) // a short jump adds its own 2 bytes
          const label = starts.findIndex((start) => start >= address)
          piece.target = label === -1 ? pieces.length : label
          starts = settle(pieces)
        })
        pieces.forEach((piece, i) => {
          if (piece.long === 0) return
          const distance = at(starts, piece.target) - (at(starts, i) + piece.bytes)
          if (piece.bytes === 2 && distance === 127) edges.forwardShort++
          if (piece.bytes === 2 && distance === -128) edges.backwardShort++
          // A long jump that is one byte out of reach of the short form.
          if (piece.bytes > 2 && distance === 128) edges.forwardLong++
          if (piece.bytes > 2 && distance === -(127 + piece.bytes)) edges.backwardLong++
        })

        const lines = [HEADER, 'main:']
        pieces.forEach((piece, i) => {
          lines.push(
            `L${i}:`,
            `    ${piece.long > 0 ? `${piece.text} L${piece.target}` : piece.text}`,
          )
        })
        lines.push(`L${pieces.length}:`, '    ret')
        const result = assemble(src(...lines))
        if (!result.ok) {
          failures.push(`seed ${seed} was rejected: ${show(result.diagnostics)}`)
          continue
        }
        const { instructions, symbols } = result.program
        const wrong = pieces.findIndex((piece, i) => instructions[i]?.size !== piece.bytes)
        if (wrong !== -1) {
          const piece = at(pieces, wrong)
          failures.push(
            `seed ${seed}: piece ${wrong} (\`${piece.text} L${piece.target}\`) is ` +
              `${instructions[wrong]?.size} bytes, but the rule gives ${piece.bytes}`,
          )
          continue
        }
        const labels = starts.map((_, i) => symbols.get(`L${i}`)?.address)
        if (show(labels) !== show(starts.map((start) => 0x401126n + BigInt(start)))) {
          failures.push(`seed ${seed}: a label is not at the address of its instruction`)
        }
      }
      expect(failures).toEqual([])
      // The test itself: these programs have at least ten jumps on each of the four edges.
      expect(Math.min(...Object.values(edges)), show(edges)).toBeGreaterThanOrEqual(10)
    })
  })
})

/* ════════════════════════ 8. Mnemonic spellings ════════════════════════ */

describe('8. Mnemonic spellings', () => {
  const FOLDED: [written: string, canonical: Mnemonic][] = [
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
  ]

  it.each(FOLDED)('`%s` is stored as `%s` and keeps what was written', (written, canonical) => {
    const ins = one(`${written} main`)
    expect(ins.mnemonic).toBe(canonical)
    expect(ins.written).toBe(written)
    expect(ins.text).toBe(`${written} main`)
    expect(ins.opSize).toBeNull()
    expect(ins.size).toBe(2)
    expect(targetAt(ins, 0).name).toBe('main')
  })

  it.each(FOLDED)('upper-case `%s` is stored the same way', (written, canonical) => {
    const ins = one(`${written.toUpperCase()} main`)
    expect(ins.mnemonic).toBe(canonical)
    expect(ins.written).toBe(written)
    expect(ins.text).toBe(`${written} main`)
  })

  it('`movsxd` is stored as `movsx`', () => {
    const ins = one('movsxd rax, ebx')
    expect(ins.mnemonic).toBe('movsx')
    expect(ins.written).toBe('movsxd')
    expect(ins.text).toBe('movsxd rax, ebx')
    expect(ins.opSize).toBe(64)
  })

  it('`endbr64` is stored as `nop`, 4 bytes long', () => {
    const ins = one('endbr64')
    expect(ins.mnemonic).toBe('nop')
    expect(ins.written).toBe('endbr64')
    expect(ins.text).toBe('endbr64')
    expect(ins.size).toBe(4)
    expect(ins.operands).toEqual([])
    expect(ins.opSize).toBeNull()
  })

  it('`ENDBR64` in upper case', () => {
    const ins = one('ENDBR64')
    expect(ins.mnemonic).toBe('nop')
    expect(ins.written).toBe('endbr64')
  })

  const EXAMPLE: Record<Mnemonic, string> = {
    mov: 'mov eax, ebx',
    movzx: 'movzx eax, bl',
    movsx: 'movsx eax, bl',
    lea: 'lea rax, [rbx]',
    push: 'push rax',
    pop: 'pop rax',
    add: 'add eax, ebx',
    sub: 'sub eax, ebx',
    inc: 'inc eax',
    dec: 'dec eax',
    imul: 'imul eax, ebx',
    cmp: 'cmp eax, ebx',
    test: 'test eax, ebx',
    and: 'and eax, ebx',
    or: 'or eax, ebx',
    xor: 'xor eax, ebx',
    jmp: 'jmp main',
    je: 'je main',
    jne: 'jne main',
    jg: 'jg main',
    jge: 'jge main',
    jl: 'jl main',
    jle: 'jle main',
    ja: 'ja main',
    jae: 'jae main',
    jb: 'jb main',
    jbe: 'jbe main',
    js: 'js main',
    jns: 'jns main',
    jo: 'jo main',
    jno: 'jno main',
    call: 'call main',
    ret: 'ret',
    nop: 'nop',
    leave: 'leave',
  }

  it.each([...MNEMONICS])('the canonical mnemonic `%s` is stored as written', (mnemonic) => {
    const ins = one(EXAMPLE[mnemonic])
    expect(ins.mnemonic).toBe(mnemonic)
    expect(ins.written).toBe(mnemonic)
    expect(ins.text).toBe(EXAMPLE[mnemonic])
  })

  it.each([...MNEMONICS])('`%s` in upper case, with upper-case registers', (mnemonic) => {
    const lower = EXAMPLE[mnemonic]
    const ins = one(lower.toUpperCase().replace('MAIN', 'main'))
    expect(ins.mnemonic).toBe(mnemonic)
    expect(ins.written).toBe(mnemonic)
    expect(ins.text).toBe(lower)
  })

  it.each(['Mov eax, ebx', 'mOv EaX, eBx', 'MOV eax, EBX'])('mixed case: `%s`', (statement) => {
    const ins = one(statement)
    expect(ins.mnemonic).toBe('mov')
    expect(ins.written).toBe('mov')
    expect(regAt(ins, 0).reg.name).toBe('eax')
    expect(regAt(ins, 1).reg.name).toBe('ebx')
    expect(ins.text).toBe('mov eax, ebx')
  })

  describe('`Instruction.text` is the tidy form', () => {
    it.each<[string, string]>([
      ['MOV   EAX,DWORD PTR [RBP-4]', 'mov eax, dword ptr [rbp-4]'],
      ['mov eax,ebx', 'mov eax, ebx'],
      ['mov    eax   ,   ebx', 'mov eax, ebx'],
      ['mov\teax,\tebx', 'mov eax, ebx'],
      ['mov eax, 5   # five', 'mov eax, 5'],
      ['PUSH   RBX', 'push rbx'],
      ['ret   ', 'ret'],
      ['RET', 'ret'],
      ['Leave', 'leave'],
      ['add rsp,16', 'add rsp, 16'],
      ['JMP   main', 'jmp main'],
      ['jz   main  # back', 'jz main'],
      ['lea  rdi ,  [rbp-8]', 'lea rdi, [rbp-8]'],
      ['cmp   DWORD PTR [rbp-4],10', 'cmp dword ptr [rbp-4], 10'],
      ['SUB RSP,16', 'sub rsp, 16'],
      ['inc   QWORD PTR [rax]', 'inc qword ptr [rax]'],
    ])('`%s` becomes `%s`', (statement, text) => {
      expect(one(statement).text).toBe(text)
    })

    it('the text has no label and no comment', () => {
      const program = ok(src(HEADER, 'main:   mov   eax,1     # start', 'Done: RET # end'))
      expect(program.instructions.map((i) => i.text)).toEqual(['mov eax, 1', 'ret'])
    })

    it('a label in the text keeps its letter case', () => {
      const program = ok(src(HEADER, 'main:', 'MyLoop:', '    nop', '    JMP MyLoop'))
      expect(at(program.instructions, 1).text).toBe('jmp MyLoop')
    })

    it('a `.equ` name in the text stays as written', () => {
      expect(one('lea rdi, message[rip]', RODATA).text).toBe('lea rdi, message[rip]')
      expect(one('mov rax, count[rbp]', EQUS).text).toBe('mov rax, count[rbp]')
    })
  })

  describe('letter case and spacing never change the instruction', () => {
    /** Lines in their tidy form: lower case, one space, `, ` between the operands. */
    const TIDY = [
      'mov eax, dword ptr [rbp-4]',
      'mov qword ptr [rbp-8], 5',
      'mov word ptr [rax], 7',
      'mov rax, [r13+r14*8+128]',
      'mov ah, bl',
      'mov sil, 7',
      'lea rdi, [rax+rbx*8+16]',
      'lea rax, [rcx*8]',
      'movzx eax, byte ptr [rdi+rcx]',
      'movsx rax, dword ptr [rbp-4]',
      'add rsp, 16',
      'and rsp, -16',
      'cmp byte ptr [rax], 0',
      'imul rax, [rbp-8]',
      'test al, 1',
      'inc dword ptr [rbp-4]',
      'dec qword ptr [rsp]',
      'push r12',
      'pop rbp',
      'xor r8d, r8d',
    ]

    /** Everything about an instruction except the texts. */
    function withoutText(ins: Instruction): string {
      return show({ ...ins, text: '', operands: ins.operands.map((o) => ({ ...o, text: '' })) })
    }

    it.each(TIDY)('`%s` in upper case, with tabs and extra spaces', (tidy) => {
      const messy = tidy.toUpperCase().replace(' ', '\t  ').replaceAll(', ', '  ,\t')
      const untidy = one(`${messy}  \t`)
      expect(untidy.text).toBe(tidy)
      expect(withoutText(untidy)).toBe(withoutText(one(tidy)))
    })

    it.each(TIDY)('`%s` on the line of its label, with a comment behind it', (tidy) => {
      const program = ok(src(HEADER, `main:${tidy}# ${tidy}`, '    ret'))
      const ins = at(program.instructions, 0)
      expect(ins.text).toBe(tidy)
      expect(ins.line).toBe(2)
      expect(withoutText({ ...ins, line: 3 })).toBe(withoutText(one(tidy)))
    })
  })
})

/* ═══════════════════════════ 9. External calls ═══════════════════════════ */

describe('9. External calls', () => {
  const NAMES = ['printf', 'scanf', 'puts', 'putchar', 'exit'] as const

  it.each(NAMES)('`call %s@PLT` is a call to the library', (name) => {
    const program = ok(around(`call ${name}@PLT`))
    const call = at(program.instructions, 0)
    expect(call.mnemonic).toBe('call')
    expect(call.size).toBe(5)
    expect(call.opSize).toBeNull()
    expect(targetAt(call, 0)).toMatchObject({
      name,
      address: LIBRARY_FUNCTIONS[name],
      external: true,
    })
    expect(symbolOf(program, name)).toMatchObject({
      name,
      address: LIBRARY_FUNCTIONS[name],
      kind: 'external',
      line: null,
    })
    expect(program.warnings).toEqual([])
  })

  it.each(NAMES)('`call %s` without `@PLT` is the same', (name) => {
    const program = ok(around(`call ${name}`))
    expect(targetAt(at(program.instructions, 0), 0)).toMatchObject({
      name,
      address: LIBRARY_FUNCTIONS[name],
      external: true,
    })
    expect(symbolOf(program, name).kind).toBe('external')
  })

  it('`CALL printf@PLT` in upper case', () => {
    const call = one('CALL printf@PLT')
    expect(call.mnemonic).toBe('call')
    expect(targetAt(call, 0)).toMatchObject({ name: 'printf', external: true })
  })

  it.each(['call __isoc99_scanf@PLT', 'call __isoc99_scanf'])('`%s` is `scanf`', (statement) => {
    const program = ok(around(statement))
    const target = targetAt(at(program.instructions, 0), 0)
    expect(target.external).toBe(true)
    expect(hex(target.address)).toBe(hex(LIBRARY_FUNCTIONS.scanf))
    const externals = [...program.symbols.values()].filter((s) => s.kind === 'external')
    expect(externals).toHaveLength(1)
    expect(at(externals, 0)).toMatchObject({ address: LIBRARY_FUNCTIONS.scanf, line: null })
  })

  it('the library addresses are the ones in `LIBRARY_FUNCTIONS`', () => {
    expect(hex(targetAt(one('call printf@PLT'), 0).address)).toBe('0x7ffff7c606f0')
    expect(hex(targetAt(one('call puts@PLT'), 0).address)).toBe('0x7ffff7c80e50')
  })

  it('only the library functions that are used become symbols', () => {
    const program = ok(
      src(
        HEADER,
        'main:',
        '    call printf@PLT',
        '    call printf@PLT',
        '    call puts',
        '    ret',
      ),
    )
    expect([...program.symbols.keys()].sort()).toEqual(['main', 'printf', 'puts'])
    expect(symbolOf(program, 'main').kind).toBe('code')
  })

  it('a program without calls has no external symbols', () => {
    const program = ok(src(HEADER, 'main:', '    ret'))
    expect([...program.symbols.values()].filter((s) => s.kind === 'external')).toEqual([])
  })

  it.each(['call foo', 'call foo@PLT', 'call print', 'call Printf', 'call strlen@PLT'])(
    '`%s` is `undefined-symbol`, and the message lists the library functions',
    (statement) => {
      const error = onlyError(around(statement), 'undefined-symbol', 3)
      for (const name of NAMES) expect(error.message).toContain(name)
    },
  )

  it.each(['jmp printf', 'je puts', 'jne exit', 'jmp scanf', 'jl putchar'])(
    '`%s` is `jump-target`: a jump cannot go to a library function',
    (statement) => {
      onlyError(around(statement), 'jump-target', 3)
    },
  )

  it('a program may define its own `puts`, and `call puts` then goes to that label', () => {
    const program = ok(
      src(
        HEADER, // 1
        'puts:', // 2
        '    mov eax, 1', // 3   0x401126 (5)
        '    ret', // 4   0x40112b (1)
        'main:', // 5
        '    call puts', // 6   0x40112c (5)
        '    call puts@PLT', // 7   0x401131 (5)
        '    ret', // 8
      ),
    )
    for (const index of [2, 3]) {
      expect(targetAt(at(program.instructions, index), 0)).toMatchObject({
        name: 'puts',
        address: 0x401126n,
        external: false,
      })
    }
    expect(symbolOf(program, 'puts')).toMatchObject({ kind: 'code', address: 0x401126n, line: 2 })
    expect([...program.symbols.values()].filter((s) => s.kind === 'external')).toEqual([])
    expect(hex(program.entry)).toBe('0x40112c')
  })

  it('a jump to a label of the program that is named `printf` is legal', () => {
    const program = ok(src(HEADER, 'main:', '    jmp printf', 'printf:', '    ret'))
    expect(targetAt(at(program.instructions, 0), 0)).toMatchObject({
      name: 'printf',
      address: 0x401128n,
      external: false,
    })
  })

  it('a call to a label of the program is not external', () => {
    const program = ok(
      src(HEADER, 'main:', '    call helper', '    ret', 'helper:', '    mov eax, 7', '    ret'),
    )
    const call = at(program.instructions, 0)
    expect(targetAt(call, 0)).toMatchObject({
      name: 'helper',
      address: 0x40112cn,
      external: false,
    })
    expect(call.size).toBe(5)
    expect(symbolOf(program, 'helper')).toMatchObject({ kind: 'code', line: 5 })
  })

  it('library calls and own functions together', () => {
    const program = ok(
      src(
        HEADER, // 1
        '.section .rodata', // 2
        'format: .string "%d\\n"', // 3
        '.text', // 4
        'main:', // 5
        '    lea rdi, format[rip]', // 6   0x401126 (7)
        '    mov esi, 42', // 7   0x40112d (5)
        '    mov eax, 0', // 8   0x401132 (5)
        '    call printf@PLT', // 9   0x401137 (5)
        '    mov edi, 0', // 10  0x40113c (5)
        '    call exit@PLT', // 11  0x401141 (5)
      ),
    )
    expect(program.instructions.map((i) => hex(i.address))).toEqual([
      '0x401126',
      '0x40112d',
      '0x401132',
      '0x401137',
      '0x40113c',
      '0x401141',
    ])
    expect([...program.symbols.keys()].sort()).toEqual(['exit', 'format', 'main', 'printf'])
    expect(targetAt(at(program.instructions, 5), 0)).toMatchObject({
      name: 'exit',
      address: LIBRARY_FUNCTIONS.exit,
      external: true,
    })
  })
})

/* ═══════════════════════════ 10. Whole programs ═══════════════════════════ */

describe('10. Whole programs', () => {
  it('Hello World with a prologue, an epilogue and `message[rip]`', () => {
    const source = src(
      '    .intel_syntax noprefix', // 1
      '    .section .rodata', // 2
      'message:', // 3
      '    .string "Hello, world!\\n"', // 4
      '    .text', // 5
      '    .globl main', // 6
      'main:', // 7
      '    push rbp', // 8   0x401126  1 byte
      '    mov rbp, rsp', // 9   0x401127  3
      '    lea rdi, message[rip]', // 10  0x40112a  7
      '    mov eax, 0', // 11  0x401131  5
      '    call printf@PLT', // 12  0x401136  5
      '    mov eax, 0', // 13  0x40113b  5
      '    pop rbp', // 14  0x401140  1
      '    ret', // 15  0x401141  1
    )
    const result = assemble(source)
    expect(result.diagnostics, show(result.diagnostics)).toEqual([])
    if (!result.ok) throw new Error('expected ok')
    const program = result.program

    expect(program.instructions).toHaveLength(8)
    expect(
      program.instructions.map((i) => `${i.line} ${hex(i.address)} ${i.size} ${i.text}`),
    ).toEqual([
      '8 0x401126 1 push rbp',
      '9 0x401127 3 mov rbp, rsp',
      '10 0x40112a 7 lea rdi, message[rip]',
      '11 0x401131 5 mov eax, 0',
      '12 0x401136 5 call printf@PLT',
      '13 0x40113b 5 mov eax, 0',
      '14 0x401140 1 pop rbp',
      '15 0x401141 1 ret',
    ])
    expect(hex(program.entry)).toBe('0x401126')
    expect(program.entryLabel).toBe('main')
    expect(program.layout).toMatchObject({
      textBase: 0x401126n,
      textEnd: 0x401142n,
      rodataBase: 0x402010n,
      rodataEnd: 0x40201fn,
      dataBase: 0x404030n,
      dataEnd: 0x404030n,
    })

    expect(program.data).toHaveLength(1)
    expect(at(program.data, 0)).toMatchObject({
      label: 'message',
      line: 4,
      section: 'rodata',
      address: 0x402010n,
      directive: '.string',
      elementSize: 1,
      text: 'Hello, world!\n',
    })
    expect(at(program.data, 0).bytes).toEqual([
      ...Array.from('Hello, world!\n', (c) => c.charCodeAt(0)),
      0,
    ])

    const lea = at(program.instructions, 2)
    expect(regAt(lea, 0).reg.name).toBe('rdi')
    expect(shape(memAt(lea, 1))).toEqual({
      ...PLAIN_MEMORY,
      base: 'rip',
      symbol: 'message',
      symbolAddress: 0x402010n,
    })
    expect(targetAt(at(program.instructions, 4), 0)).toMatchObject({
      name: 'printf',
      address: LIBRARY_FUNCTIONS.printf,
      external: true,
    })

    expect([...program.symbols.keys()].sort()).toEqual(['main', 'message', 'printf'])
    expect(symbolOf(program, 'main')).toMatchObject({ kind: 'code', address: 0x401126n, line: 7 })
    expect(symbolOf(program, 'message')).toMatchObject({
      kind: 'data',
      address: 0x402010n,
      line: 3,
    })
    expect(program.constants.size).toBe(0)
    expect(program.addressToIndex.get(0x401136n)).toBe(4)
    expect(program.lineToIndex.get(12)).toBe(4)
    expect(program.source).toBe(source)
  })

  it('a counting loop with `cmp` and `jle`', () => {
    const result = assemble(
      src(
        '.intel_syntax noprefix', // 1
        '.text', // 2
        '.globl main', // 3
        '', // 4
        '# add the numbers 1 to 10', // 5
        'main:', // 6
        '    mov eax, 0          # the sum', // 7   0x401126  5 bytes
        '    mov ecx, 1          # the counter', // 8   0x40112b  5
        'loop:', // 9
        '    add eax, ecx', // 10  0x401130  2
        '    inc ecx', // 11  0x401132  2
        '    cmp ecx, 10', // 12  0x401134  3
        '    jle loop', // 13  0x401137  2
        '    ret', // 14  0x401139  1
      ),
    )
    expect(result.diagnostics, show(result.diagnostics)).toEqual([])
    if (!result.ok) throw new Error('expected ok')
    const program = result.program

    expect(program.instructions).toHaveLength(7)
    expect(
      program.instructions.map((i) => `${i.line} ${hex(i.address)} ${i.size} ${i.text}`),
    ).toEqual([
      '7 0x401126 5 mov eax, 0',
      '8 0x40112b 5 mov ecx, 1',
      '10 0x401130 2 add eax, ecx',
      '11 0x401132 2 inc ecx',
      '12 0x401134 3 cmp ecx, 10',
      '13 0x401137 2 jle loop',
      '14 0x401139 1 ret',
    ])
    expect(program.instructions.map((i) => i.opSize)).toEqual([32, 32, 32, 32, 32, null, null])
    expect(hex(program.layout.textEnd)).toBe('0x40113a')
    expect(hex(program.entry)).toBe('0x401126')
    expect(program.entryLabel).toBe('main')

    const jump = at(program.instructions, 5)
    expect(jump.mnemonic).toBe('jle')
    expect(targetAt(jump, 0)).toMatchObject({ name: 'loop', address: 0x401130n, external: false })
    expect(symbolOf(program, 'loop')).toMatchObject({ kind: 'code', address: 0x401130n, line: 9 })
    expect(program.data).toEqual([])
    expect(program.lineToIndex.get(13)).toBe(5)
    expect(program.lineToIndex.has(9)).toBe(false)
  })

  it('a function with locals from `.equ` and `sub rsp, 16`', () => {
    const result = assemble(
      src(
        '.intel_syntax noprefix', // 1
        '.equ first, -8', // 2
        '.equ second, -16', // 3
        '.text', // 4
        '.globl main', // 5
        'add_two:', // 6
        '    push rbp', // 7   0x401126  1 byte
        '    mov rbp, rsp', // 8   0x401127  3
        '    sub rsp, 16', // 9   0x40112a  4
        '    mov first[rbp], rdi', // 10  0x40112e  4
        '    mov second[rbp], rsi', // 11  0x401132  4
        '    mov rax, first[rbp]', // 12  0x401136  4
        '    add rax, second[rbp]', // 13  0x40113a  4
        '    leave', // 14  0x40113e  1
        '    ret', // 15  0x40113f  1
        'main:', // 16
        '    push rbp', // 17  0x401140  1
        '    mov rbp, rsp', // 18  0x401141  3
        '    mov edi, 3', // 19  0x401144  5
        '    mov esi, 4', // 20  0x401149  5
        '    call add_two', // 21  0x40114e  5
        '    pop rbp', // 22  0x401153  1
        '    ret', // 23  0x401154  1
      ),
    )
    expect(result.diagnostics, show(result.diagnostics)).toEqual([])
    if (!result.ok) throw new Error('expected ok')
    const program = result.program

    expect(program.instructions).toHaveLength(16)
    expect(program.instructions.map((i) => `${i.line} ${hex(i.address)} ${i.size}`)).toEqual([
      '7 0x401126 1',
      '8 0x401127 3',
      '9 0x40112a 4',
      '10 0x40112e 4',
      '11 0x401132 4',
      '12 0x401136 4',
      '13 0x40113a 4',
      '14 0x40113e 1',
      '15 0x40113f 1',
      '17 0x401140 1',
      '18 0x401141 3',
      '19 0x401144 5',
      '20 0x401149 5',
      '21 0x40114e 5',
      '22 0x401153 1',
      '23 0x401154 1',
    ])
    expect(hex(program.layout.textEnd)).toBe('0x401155')

    // `main` is not the first instruction.
    expect(hex(program.entry)).toBe('0x401140')
    expect(program.entryLabel).toBe('main')

    expect(program.constants.get('first')).toBe(-8n)
    expect(program.constants.get('second')).toBe(-16n)
    expect(program.constants.size).toBe(2)

    const store = at(program.instructions, 3)
    expect(shape(memAt(store, 0))).toEqual({
      ...PLAIN_MEMORY,
      base: 'rbp',
      disp: -8n,
      equNames: ['first'],
    })
    expect(regAt(store, 1).reg.name).toBe('rdi')
    expect(store.opSize).toBe(64)
    const add = at(program.instructions, 6)
    expect(shape(memAt(add, 1))).toEqual({
      ...PLAIN_MEMORY,
      base: 'rbp',
      disp: -16n,
      equNames: ['second'],
    })
    expect(at(program.instructions, 7).mnemonic).toBe('leave')

    const call = at(program.instructions, 13)
    expect(targetAt(call, 0)).toMatchObject({
      name: 'add_two',
      address: 0x401126n,
      external: false,
    })
    expect([...program.symbols.keys()].sort()).toEqual(['add_two', 'main'])
    expect(symbolOf(program, 'add_two')).toMatchObject({ kind: 'code', line: 6 })
    expect(symbolOf(program, 'main')).toMatchObject({ kind: 'code', address: 0x401140n, line: 16 })
  })

  it('output of `gcc -S -masm=intel`, with all its extra directives', () => {
    const result = assemble(
      src(
        '\t.file\t"hello.c"', // 1
        '\t.intel_syntax noprefix', // 2
        '\t.text', // 3
        '\t.section\t.rodata', // 4
        '.LC0:', // 5
        '\t.string\t"Hello, world!"', // 6
        '\t.text', // 7
        '\t.globl\tmain', // 8
        '\t.type\tmain, @function', // 9
        'main:', // 10
        '.LFB0:', // 11
        '\t.cfi_startproc', // 12
        '\tendbr64', // 13  0x401126  4 bytes
        '\tpush\trbp', // 14  0x40112a  1
        '\t.cfi_def_cfa_offset 16', // 15
        '\t.cfi_offset 6, -16', // 16
        '\tmov\trbp, rsp', // 17  0x40112b  3
        '\t.cfi_def_cfa_register 6', // 18
        '\tlea\trax, .LC0[rip]', // 19  0x40112e  7
        '\tmov\trdi, rax', // 20  0x401135  3
        '\tcall\tputs@PLT', // 21  0x401138  5
        '\tmov\teax, 0', // 22  0x40113d  5
        '\tpop\trbp', // 23  0x401142  1
        '\t.cfi_def_cfa 7, 8', // 24
        '\tret', // 25  0x401143  1
        '\t.cfi_endproc', // 26
        '.LFE0:', // 27
        '\t.size\tmain, .-main', // 28
        '\t.ident\t"GCC: (Ubuntu 13.2.0-23ubuntu4) 13.2.0"', // 29
        '\t.section\t.note.GNU-stack,"",@progbits', // 30
      ),
    )
    expect(result.diagnostics, show(result.diagnostics)).toEqual([])
    if (!result.ok) throw new Error('expected ok')
    const program = result.program

    expect(
      program.instructions.map((i) => `${i.line} ${hex(i.address)} ${i.size} ${i.text}`),
    ).toEqual([
      '13 0x401126 4 endbr64',
      '14 0x40112a 1 push rbp',
      '17 0x40112b 3 mov rbp, rsp',
      '19 0x40112e 7 lea rax, .LC0[rip]',
      '20 0x401135 3 mov rdi, rax',
      '21 0x401138 5 call puts@PLT',
      '22 0x40113d 5 mov eax, 0',
      '23 0x401142 1 pop rbp',
      '25 0x401143 1 ret',
    ])
    expect(at(program.instructions, 0).mnemonic).toBe('nop')
    expect(hex(program.layout.textEnd)).toBe('0x401144')
    expect(hex(program.entry)).toBe('0x401126')
    expect(program.entryLabel).toBe('main')

    expect(symbolOf(program, '.LFB0')).toMatchObject({ kind: 'code', address: 0x401126n })
    expect(symbolOf(program, '.LFE0')).toMatchObject({ kind: 'code', address: 0x401144n })
    expect(symbolOf(program, '.LC0')).toMatchObject({ kind: 'data', address: 0x402010n, line: 5 })
    expect(symbolOf(program, 'puts')).toMatchObject({ kind: 'external', line: null })

    expect(program.data).toHaveLength(1)
    expect(at(program.data, 0)).toMatchObject({
      label: '.LC0',
      section: 'rodata',
      address: 0x402010n,
      text: 'Hello, world!',
    })
    expect(hex(program.layout.rodataEnd)).toBe('0x40201e')
    expect(hex(memAt(at(program.instructions, 3), 1).symbolAddress)).toBe('0x402010')
  })

  it('a program with read-only text, a writable counter and `scanf`', () => {
    const result = assemble(
      src(
        '.intel_syntax noprefix', // 1
        '.section .rodata', // 2
        'ask:    .string "Number: "', // 3   0x402010  9 bytes
        'format: .string "%d"', // 4   0x402019  3 bytes
        '.data', // 5
        'number: .long 0', // 6   0x404030  4 bytes
        'total:  .quad 100', // 7   0x404034  8 bytes
        '.text', // 8
        '.globl main', // 9
        'main:', // 10
        '    sub rsp, 8', // 11  0x401126  4 bytes
        '    lea rdi, ask[rip]', // 12  0x40112a  7
        '    mov eax, 0', // 13  0x401131  5
        '    call printf@PLT', // 14  0x401136  5
        '    lea rdi, format[rip]', // 15  0x40113b  7
        '    lea rsi, number[rip]', // 16  0x401142  7
        '    mov eax, 0', // 17  0x401149  5
        '    call __isoc99_scanf@PLT', // 18  0x40114e  5
        '    mov eax, number[rip]', // 19  0x401153  6
        '    add total[rip], rax', // 20  0x401159  7
        '    add rsp, 8', // 21  0x401160  4
        '    ret', // 22  0x401164  1
      ),
    )
    expect(result.diagnostics, show(result.diagnostics)).toEqual([])
    if (!result.ok) throw new Error('expected ok')
    const program = result.program

    expect(program.instructions.map((i) => `${hex(i.address)} ${i.size}`)).toEqual([
      '0x401126 4',
      '0x40112a 7',
      '0x401131 5',
      '0x401136 5',
      '0x40113b 7',
      '0x401142 7',
      '0x401149 5',
      '0x40114e 5',
      '0x401153 6',
      '0x401159 7',
      '0x401160 4',
      '0x401164 1',
    ])
    expect(program.layout).toMatchObject({
      textEnd: 0x401165n,
      rodataEnd: 0x40201cn,
      dataEnd: 0x40403cn,
    })
    expect(
      program.data.map((item) => `${item.label} ${item.section} ${hex(item.address)}`),
    ).toEqual([
      'ask rodata 0x402010',
      'format rodata 0x402019',
      'number data 0x404030',
      'total data 0x404034',
    ])
    expect(dataOf(program, 'total').bytes).toEqual([100, 0, 0, 0, 0, 0, 0, 0])
    expect(hex(memAt(at(program.instructions, 4), 1).symbolAddress)).toBe('0x402019')
    expect(hex(memAt(at(program.instructions, 9), 0).symbolAddress)).toBe('0x404034')
    expect(targetAt(at(program.instructions, 7), 0)).toMatchObject({
      address: LIBRARY_FUNCTIONS.scanf,
      external: true,
    })
  })

  it('a `for` loop as `gcc -S -masm=intel -O0` writes it, with `.L2`, `.L3` and `-4[rbp]`', () => {
    const result = assemble(
      src(
        '\t.file\t"loop.c"', // 1
        '\t.intel_syntax noprefix', // 2
        '\t.text', // 3
        '\t.section\t.rodata', // 4
        '.LC0:', // 5
        '\t.string\t"%d\\n"', // 6   0x402010  4 bytes
        '\t.text', // 7
        '\t.globl\tmain', // 8
        '\t.type\tmain, @function', // 9
        'main:', // 10
        '.LFB0:', // 11
        '\t.cfi_startproc', // 12
        '\tendbr64', // 13  0x401126  4 bytes
        '\tpush\trbp', // 14  0x40112a  1
        '\t.cfi_def_cfa_offset 16', // 15
        '\t.cfi_offset 6, -16', // 16
        '\tmov\trbp, rsp', // 17  0x40112b  3
        '\t.cfi_def_cfa_register 6', // 18
        '\tsub\trsp, 16', // 19  0x40112e  4
        '\tmov\tDWORD PTR -4[rbp], 0', // 20  0x401132  7
        '\tjmp\t.L2', // 21  0x401139  2
        '.L3:', // 22
        '\tmov\teax, DWORD PTR -4[rbp]', // 23  0x40113b  3
        '\tmov\tesi, eax', // 24  0x40113e  2
        '\tlea\trax, .LC0[rip]', // 25  0x401140  7
        '\tmov\trdi, rax', // 26  0x401147  3
        '\tmov\teax, 0', // 27  0x40114a  5
        '\tcall\tprintf@PLT', // 28  0x40114f  5
        '\tadd\tDWORD PTR -4[rbp], 1', // 29  0x401154  4
        '.L2:', // 30
        '\tcmp\tDWORD PTR -4[rbp], 9', // 31  0x401158  4
        '\tjle\t.L3', // 32  0x40115c  2
        '\tmov\teax, 0', // 33  0x40115e  5
        '\tleave', // 34  0x401163  1
        '\t.cfi_def_cfa 7, 8', // 35
        '\tret', // 36  0x401164  1
        '\t.cfi_endproc', // 37
        '.LFE0:', // 38
        '\t.size\tmain, .-main', // 39
        '\t.ident\t"GCC: (Ubuntu 13.2.0-23ubuntu4) 13.2.0"', // 40
        '\t.section\t.note.GNU-stack,"",@progbits', // 41
      ),
    )
    expect(result.diagnostics, show(result.diagnostics)).toEqual([])
    if (!result.ok) throw new Error('expected ok')
    const program = result.program

    expect(
      program.instructions.map((i) => `${i.line} ${hex(i.address)} ${i.size} ${i.text}`),
    ).toEqual([
      '13 0x401126 4 endbr64',
      '14 0x40112a 1 push rbp',
      '17 0x40112b 3 mov rbp, rsp',
      '19 0x40112e 4 sub rsp, 16',
      '20 0x401132 7 mov dword ptr -4[rbp], 0',
      '21 0x401139 2 jmp .L2',
      '23 0x40113b 3 mov eax, dword ptr -4[rbp]',
      '24 0x40113e 2 mov esi, eax',
      '25 0x401140 7 lea rax, .LC0[rip]',
      '26 0x401147 3 mov rdi, rax',
      '27 0x40114a 5 mov eax, 0',
      '28 0x40114f 5 call printf@PLT',
      '29 0x401154 4 add dword ptr -4[rbp], 1',
      '31 0x401158 4 cmp dword ptr -4[rbp], 9',
      '32 0x40115c 2 jle .L3',
      '33 0x40115e 5 mov eax, 0',
      '34 0x401163 1 leave',
      '36 0x401164 1 ret',
    ])
    expect(hex(program.layout.textEnd)).toBe('0x401165')
    expect(hex(program.layout.rodataEnd)).toBe('0x402014')
    expect(hex(program.entry)).toBe('0x401126')
    expect(program.entryLabel).toBe('main')

    // The jump into the loop test, and the jump back to the loop body.
    expect(targetAt(at(program.instructions, 5), 0)).toMatchObject({
      name: '.L2',
      address: 0x401158n,
      external: false,
    })
    expect(targetAt(at(program.instructions, 14), 0)).toMatchObject({
      name: '.L3',
      address: 0x40113bn,
      external: false,
    })
    expect(symbolOf(program, '.L3')).toMatchObject({ kind: 'code', address: 0x40113bn, line: 22 })
    expect(symbolOf(program, '.L2')).toMatchObject({ kind: 'code', address: 0x401158n, line: 30 })
    expect(symbolOf(program, '.LFE0')).toMatchObject({ kind: 'code', address: 0x401165n })

    // The local variable at rbp-4, written three ways by gcc.
    for (const [index, position] of [
      [4, 0],
      [6, 1],
      [12, 0],
      [13, 0],
    ] as const) {
      const ins = at(program.instructions, index)
      expect(shape(memAt(ins, position))).toEqual({
        ...PLAIN_MEMORY,
        size: 32,
        base: 'rbp',
        disp: -4n,
      })
      expect(ins.opSize).toBe(32)
    }
    expect(at(program.data, 0)).toMatchObject({
      label: '.LC0',
      text: '%d\n',
      bytes: [37, 100, 10, 0],
    })
    expect([...program.symbols.keys()].sort()).toEqual(
      ['.L2', '.L3', '.LC0', '.LFB0', '.LFE0', 'main', 'printf'].sort(),
    )
  })

  it('a recursive function: `call` to an own label, `imul` with memory, two short jumps', () => {
    const result = assemble(
      src(
        '.intel_syntax noprefix', // 1
        '.section .rodata', // 2
        'format: .string "%ld\\n"', // 3   0x402010  5 bytes
        '.text', // 4
        '.globl main', // 5
        'fact:', // 6
        '    push rbp', // 7   0x401126  1 byte
        '    mov rbp, rsp', // 8   0x401127  3
        '    sub rsp, 16', // 9   0x40112a  4
        '    mov [rbp-8], rdi', // 10  0x40112e  4
        '    cmp qword ptr [rbp-8], 1', // 11  0x401132  5
        '    jg recurse', // 12  0x401137  2
        '    mov eax, 1', // 13  0x401139  5
        '    jmp done', // 14  0x40113e  2
        'recurse:', // 15
        '    mov rdi, [rbp-8]', // 16  0x401140  4
        '    dec rdi', // 17  0x401144  3
        '    call fact', // 18  0x401147  5
        '    imul rax, [rbp-8]', // 19  0x40114c  5
        'done:', // 20
        '    leave', // 21  0x401151  1
        '    ret', // 22  0x401152  1
        'main:', // 23
        '    push rbp', // 24  0x401153  1
        '    mov rbp, rsp', // 25  0x401154  3
        '    mov edi, 5', // 26  0x401157  5
        '    call fact', // 27  0x40115c  5
        '    lea rdi, format[rip]', // 28  0x401161  7
        '    mov rsi, rax', // 29  0x401168  3
        '    mov eax, 0', // 30  0x40116b  5
        '    call printf@PLT', // 31  0x401170  5
        '    mov eax, 0', // 32  0x401175  5
        '    pop rbp', // 33  0x40117a  1
        '    ret', // 34  0x40117b  1
      ),
    )
    expect(result.diagnostics, show(result.diagnostics)).toEqual([])
    if (!result.ok) throw new Error('expected ok')
    const program = result.program

    expect(program.instructions).toHaveLength(25)
    expect(program.instructions.map((i) => `${i.line} ${hex(i.address)} ${i.size}`)).toEqual([
      '7 0x401126 1',
      '8 0x401127 3',
      '9 0x40112a 4',
      '10 0x40112e 4',
      '11 0x401132 5',
      '12 0x401137 2',
      '13 0x401139 5',
      '14 0x40113e 2',
      '16 0x401140 4',
      '17 0x401144 3',
      '18 0x401147 5',
      '19 0x40114c 5',
      '21 0x401151 1',
      '22 0x401152 1',
      '24 0x401153 1',
      '25 0x401154 3',
      '26 0x401157 5',
      '27 0x40115c 5',
      '28 0x401161 7',
      '29 0x401168 3',
      '30 0x40116b 5',
      '31 0x401170 5',
      '32 0x401175 5',
      '33 0x40117a 1',
      '34 0x40117b 1',
    ])
    expect(program.layout).toMatchObject({
      textBase: 0x401126n,
      textEnd: 0x40117cn,
      rodataEnd: 0x402015n,
      dataEnd: 0x404030n,
    })
    expect(hex(program.entry)).toBe('0x401153')
    expect(program.entryLabel).toBe('main')

    expect(symbolOf(program, 'fact')).toMatchObject({ kind: 'code', address: 0x401126n, line: 6 })
    expect(symbolOf(program, 'recurse')).toMatchObject({ kind: 'code', address: 0x401140n })
    expect(symbolOf(program, 'done')).toMatchObject({ kind: 'code', address: 0x401151n })
    expect(symbolOf(program, 'format')).toMatchObject({ kind: 'data', address: 0x402010n })
    expect(symbolOf(program, 'printf')).toMatchObject({ kind: 'external', line: null })

    // The call inside `fact` and the call in `main` go to the same label.
    for (const index of [10, 17]) {
      expect(targetAt(at(program.instructions, index), 0)).toMatchObject({
        name: 'fact',
        address: 0x401126n,
        external: false,
      })
    }
    expect(hex(targetAt(at(program.instructions, 5), 0).address)).toBe('0x401140')
    expect(hex(targetAt(at(program.instructions, 7), 0).address)).toBe('0x401151')
    expect(program.instructions.map((i) => i.opSize)).toEqual([
      ...[64, 64, 64, 64, 64, null, 32, null],
      ...[64, 64, null, 64, null, null],
      ...[64, 64, 32, null, 64, 64, 32, null, 32, 64, null],
    ])
    expect(program.addressToIndex.get(0x401153n)).toBe(14)
    expect(program.lineToIndex.get(27)).toBe(17)
  })
})

/* ════════════════════════════ 11. Never throws ════════════════════════════ */

describe('11. Never throws', () => {
  /** Everything the contract promises about any result, whatever the input was. */
  function expectWellFormed(source: string, result: AssembleResult): void {
    const lineCount = source.split(/\r\n|\n|\r/).length
    const lines = result.diagnostics.map((d) => d.line)
    expect(lines, 'diagnostics are sorted by line').toEqual([...lines].sort((a, b) => a - b))
    for (const d of result.diagnostics) {
      expect(['error', 'warning']).toContain(d.severity)
      expect(Number.isInteger(d.line) && d.line >= 0 && d.line <= lineCount, `line ${d.line}`).toBe(
        true,
      )
      expect(typeof d.code).toBe('string')
      expect(typeof d.message).toBe('string')
      expect(d.message.trim().length).toBeGreaterThan(0)
      if (d.line > 0) {
        expect(d.message.startsWith(`Line ${d.line}: `), d.message).toBe(true)
      }
    }
    const errors = result.diagnostics.filter((d) => d.severity === 'error')
    if (result.ok) {
      expect(errors).toEqual([])
      expectSoundProgram(result.program, result.diagnostics)
    } else {
      expect(result.program).toBeNull()
      expect(errors.length).toBeGreaterThanOrEqual(1)
      expect(errors.length).toBeLessThanOrEqual(20)
      expect(new Set(errors.map((e) => e.line)).size, 'one error per line').toBe(errors.length)
    }
  }

  /** Runs `assemble`, and reports the input when it throws or returns a broken result. */
  function check(source: string): AssembleResult {
    const label = JSON.stringify(source.length > 300 ? `${source.slice(0, 300)}…` : source)
    let result: AssembleResult
    try {
      result = assemble(source)
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'a thrown value'
      throw new Error(`assemble() threw for the input ${label}\n${reason}`, { cause: error })
    }
    try {
      expectWellFormed(source, result)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'a thrown value'
      throw new Error(
        `assemble() returned a broken result for the input ${label}\n${reason}\n${show(result.diagnostics)}`,
        { cause: error },
      )
    }
    return result
  }

  describe('empty input', () => {
    it.each<[string, string]>([
      ['an empty string', ''],
      ['one space', ' '],
      ['only spaces, tabs and line ends', ' \t \n\n\r\n   \t\n'],
      ['one line end', '\n'],
      ['only comments', '# a comment\n# another one\n   # and one more'],
      ['a comment without a line end', '#'],
    ])('%s gives `empty-program` on line 0 and does not throw', (_name, source) => {
      const result = check(source)
      expect(result.ok).toBe(false)
      expect(
        result.diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.line]),
      ).toEqual([['empty-program', 0]])
    })
  })

  describe('very long input', () => {
    it('a comment of 10 000 characters', () => {
      const result = check(src(HEADER, 'main:', `    # ${'x'.repeat(10_000)}`, '    ret'))
      expect(result.ok).toBe(true)
      expect(result.diagnostics).toEqual([])
    })

    it('a string of 10 000 characters', () => {
      const result = check(src(HEADER, `text: .string "${'a'.repeat(10_000)}"`, 'main:', '    ret'))
      if (!result.ok) throw new Error(`expected ok: ${show(result.diagnostics)}`)
      expect(at(result.program.data, 0).bytes).toHaveLength(10_001)
      expect(hex(result.program.layout.rodataEnd)).toBe(hex(0x402010n + 10_001n))
    })

    it('a line of 10 000 spaces before an instruction', () => {
      const result = check(src(HEADER, 'main:', `${' '.repeat(10_000)}ret`))
      expect(result.ok).toBe(true)
    })

    it.each<[string, string]>([
      ['a number with 10 000 digits', `mov eax, ${'1'.repeat(10_000)}`],
      ['a word of 10 000 letters', 'a'.repeat(10_000)],
      ['a label of 10 000 letters', `${'a'.repeat(10_000)}:`],
      ['10 000 opening brackets', '['.repeat(10_000)],
      ['10 000 opening brackets in an operand', `mov eax, ${'['.repeat(10_000)}`],
      ['10 000 opening parentheses', `mov eax, ${'('.repeat(10_000)}`],
      [
        '5 000 nested parentheses around a number',
        `mov eax, ${'('.repeat(5_000)}1${')'.repeat(5_000)}`,
      ],
      ['10 000 minus signs', `mov eax, ${'-'.repeat(10_000)}5`],
      ['a sum of 5 000 numbers', `mov eax, ${Array.from({ length: 5_000 }, () => '1').join('+')}`],
      ['5 000 commas', `mov ${','.repeat(5_000)}`],
      ['5 000 operands', `mov ${Array.from({ length: 5_000 }, () => 'eax').join(', ')}`],
      ['5 000 labels on one line', 'a: '.repeat(5_000)],
      ['10 000 quotes', '"'.repeat(10_000)],
      ['10 000 backslashes in a string', `.string "${'\\'.repeat(10_000)}`],
      ['a line of 10 000 semicolons', ';'.repeat(10_000)],
      ['10 000 hash signs', '#'.repeat(10_000)],
      [
        'a memory operand with 2 000 terms',
        `mov rax, [${Array.from({ length: 2_000 }, () => 'rax').join('+')}]`,
      ],
      [
        '10 000 tabs between the parts of an instruction',
        `mov${'\t'.repeat(10_000)}eax,${'\t'.repeat(10_000)}1`,
      ],
      ['a hex number with 10 000 digits', `mov rax, 0x${'a'.repeat(10_000)}`],
      [
        'a product of 5 000 numbers',
        `mov rax, ${Array.from({ length: 5_000 }, () => '2').join('*')}`,
      ],
      ['a string with 10 000 escapes', `.string "${'\\n'.repeat(10_000)}"`],
      [
        'a `.byte` line with 10 000 values',
        `.byte ${Array.from({ length: 10_000 }, () => '1').join(',')}`,
      ],
      [
        '10 000 strings in one directive',
        `.string ${Array.from({ length: 10_000 }, () => '"a"').join(',')}`,
      ],
      ['10 000 single quotes', "'".repeat(10_000)],
      ['10 000 colons', ':'.repeat(10_000)],
      ['10 000 times `byte ptr`', `mov eax, ${'byte ptr '.repeat(10_000)}[rax]`],
      ['10 000 times `offset`', `mov eax, ${'offset '.repeat(10_000)}main`],
      [
        '100 000 nested parentheses around a number',
        `mov eax, ${'('.repeat(100_000)}1${')'.repeat(100_000)}`,
      ],
      ['100 000 opening brackets', `mov eax, ${'['.repeat(100_000)}`],
      ['1 000 000 spaces', ' '.repeat(1_000_000)],
    ])('%s on one line', (_name, line) => {
      check(src(HEADER, 'main:', `    ${line}`, '    ret'))
      check(line)
    })

    it('a program of 5 000 instructions', () => {
      const result = check(src(HEADER, 'main:', ...nops(4_999), '    ret'))
      if (!result.ok) throw new Error(`expected ok: ${show(result.diagnostics)}`)
      expect(result.program.instructions).toHaveLength(5_000)
      expect(hex(result.program.layout.textEnd)).toBe(hex(0x401126n + 5_000n))
      expect(result.program.addressToIndex.size).toBe(5_000)
      expect(result.program.lineToIndex.get(5_002)).toBe(4_999)
    })

    it('20 000 empty lines', () => {
      const result = check('\n'.repeat(20_000))
      expect(result.ok).toBe(false)
    })

    it('1 000 bad lines give at most 20 errors', () => {
      const result = check(Array.from({ length: 1_000 }, () => 'mov [rax], [rbx]').join('\n'))
      expect(result.ok).toBe(false)
      expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(20)
    })

    it.each([10, 1_000, 20_000])(
      'a chain of %i constants, each one defined by the name on the line before',
      (count) => {
        const lines = ['.equ c0, 7']
        for (let i = 1; i < count; i++) lines.push(`.equ c${i}, c${i - 1}`)
        const result = check(
          src(HEADER, ...lines, 'main:', `    mov eax, c${count - 1}`, '    ret'),
        )
        if (!result.ok) throw new Error(`expected ok: ${show(result.diagnostics)}`)
        expect(immAt(at(result.program.instructions, 0), 1).value).toBe(7n)
        expect(result.program.constants.size).toBe(count)
      },
    )

    it.each([1_000, 20_000])(
      'a chain of %i constants, each one defined by the name on the next line, does not throw',
      (count) => {
        const lines: string[] = []
        for (let i = 0; i < count - 1; i++) lines.push(`.equ c${i}, c${i + 1}`)
        lines.push(`.equ c${count - 1}, 7`)
        check(src(HEADER, ...lines, 'main:', '    mov eax, c0', '    ret'))
      },
    )

    it.each([
      '.zero 4294967296',
      '.zero 1000000000000',
      '.space 99999999999',
      '.skip 0x7fffffffffffffff',
      '.zero 99999999999999999999999999',
    ])('`%s` does not throw and does not fill the memory', (line) => {
      check(src(HEADER, '.data', `buffer: ${line}`, '.text', 'main:', '    ret'))
    })
  })

  describe('constants that have no value', () => {
    it.each<[string, string[]]>([
      ['a constant that is defined by itself', ['.equ a, a+1']],
      ['two constants that are defined by each other', ['.equ a, b', '.equ b, a']],
      ['three constants in a circle', ['.equ a, b+1', '.equ b, c+1', '.equ c, a+1']],
      ['`name = name`', ['a = a']],
    ])('%s: the program is rejected, and nothing is thrown', (_name, lines) => {
      const result = check(src(HEADER, ...lines, 'main:', '    mov eax, a', '    ret'))
      expect(result.ok).toBe(false)
    })
  })

  describe('odd input', () => {
    it.each([
      '[[[[',
      ']]]]',
      '"',
      "'",
      '`',
      ',,,,',
      'mov ,',
      'mov eax,',
      'mov , eax',
      'mov eax,,ebx',
      ': : :',
      ':',
      '::',
      'main::',
      ': mov eax, 1',
      '.',
      '..',
      '...',
      '=',
      '= 5',
      'x =',
      'x = = 5',
      '.equ',
      '.equ ,',
      '.equ , 5',
      '.string "',
      '.string "\\',
      '.string \\"',
      '.string "a" "b"',
      '.string "a",',
      '.string ,"a"',
      '.quad',
      '.quad ,',
      '.byte 1,,2',
      '.zero -1',
      '.zero 99999999999999999999',
      '.section',
      '.section ,',
      "'\\",
      "mov al, '",
      "mov al, ''",
      "mov al, 'ab'",
      "mov al, '\\",
      "mov al, '\\q'",
      '@PLT',
      'call @PLT',
      'call printf@',
      'call printf@plt@PLT',
      'call @',
      '[',
      ']',
      'mov eax, [',
      'mov eax, ]',
      'mov eax, []',
      'mov eax, [[rax]]',
      'mov eax, [rax+]',
      'mov eax, [+rax]',
      'mov eax, [*8]',
      'mov eax, [rax*]',
      'mov eax, [rax**2]',
      'mov eax, [rax*2*2]',
      'mov eax, [rax][rbx]',
      'mov eax, [-]',
      'mov eax, [rax-]',
      'mov eax, rax[rbx]',
      'mov eax, 5[5]',
      'offset',
      'mov eax, offset',
      'mov eax, offset flat:',
      'mov eax, offset offset',
      'mov eax, offset 5',
      'mov eax, flat:main',
      'byte ptr',
      'mov eax, dword ptr',
      'mov eax, dword',
      'mov eax, ptr [rax]',
      'mov eax, dword ptr ptr [rax]',
      'mov eax, dword ptr dword ptr [rax]',
      'mov eax, dword ptr 5',
      'mov eax, dword ptr ebx',
      'ptr',
      '-',
      '+',
      '*',
      '()',
      'mov eax, -',
      'mov eax, 1+',
      'mov eax, *2',
      'mov eax, 1 2',
      'mov eax, ()',
      'mov eax, (1',
      'mov eax, 1)',
      'mov eax ebx',
      'mov eax; ebx',
      '%',
      '$',
      '%%',
      '$$',
      '#',
      ';',
      '//',
      '/*',
      '*/',
      '\\',
      '\\n',
      '!@#$%^&*()',
      '<<<>>>',
      '{}',
      '|||',
      '~~~',
      'rax',
      'rax:',
      'rax, rbx',
      'eax = 5',
      'rax = rbx',
      'main: main: main:',
      'main = 5',
      'ret ret ret',
      'ret, ret',
      'mov mov mov',
      'mov mov, mov',
      'jmp jmp',
      'call call',
      'jmp 99999999999999999999999999999999',
      'mov rax, 99999999999999999999999999999999',
      'mov rax, -99999999999999999999999999999999',
      'mov rax, 0x' + 'f'.repeat(100),
      'mov rax, 0b' + '1'.repeat(200),
      'mov rax, [rbp-99999999999999999999999999999999]',
      'mov rax, [rax*99999999999999999999]',
      'sub rsp, 1e5',
      'mov eax, 1.5',
      'mov eax, .5',
      'mov eax, 0x1.8p3',
      'mov eax, 1_000',
      'mov eax, NaN',
      'mov eax, Infinity',
      'mov eax, null',
      'mov eax, undefined',
      'mov eax, true',
      'mov eax, __proto__',
      'mov eax, constructor',
      '__proto__:',
      'constructor: ret',
      '.equ __proto__, 1',
      '.equ constructor, 1',
      '.__proto__',
      '.constructor',
      'hasOwnProperty eax',
    ])('`%s` does not throw', (line) => {
      check(line)
      check(src(HEADER, 'main:', `    ${line}`, '    ret'))
      check(src(HEADER, '.data', line, '.text', 'main:', '    ret'))
    })

    it.each<[string, string]>([
      ['a NUL character alone', '\0'],
      ['NUL characters around an instruction', '\0mov eax, 1\0\n\0ret\0'],
      ['a NUL character inside a name', 'ma\0in:\n    ret\n'],
      ['a NUL character inside a string', '.string "a\0b"\nmain:\n    ret\n'],
      ['a NUL character inside a number', 'main:\n    mov eax, 1\u00002\n'],
      ['control characters', '\u0001\u0002\u0003\u001b[31m\u007f'],
      ['a form feed and a vertical tab', 'main:\f\v ret\n'],
      ['a byte order mark at the start', '\ufeff.intel_syntax noprefix\nmain:\n    ret\n'],
      ['a no-break space as indentation', 'main:\n\u00a0\u00a0ret\n'],
      ['a line separator character', 'main:\u2028    ret\u2029'],
      ['an emoji alone', '😀'],
      ['an emoji as an instruction', '😀 eax, 1'],
      ['an emoji as an operand', 'main:\n    mov eax, 😀\n    ret\n'],
      ['an emoji as a label', '😀:\n    ret\n'],
      ['an emoji in a comment', 'main:\n    ret   # 😀 done\n'],
      ['an emoji in a character literal', "main:\n    mov eax, '😀'\n"],
      ['half of a surrogate pair', 'main:\n    mov eax, \ud83d\n    ret\n'],
      ['half of a surrogate pair in a string', '.string "\ud83d"\nmain:\n    ret\n'],
      ['letters with accents as a label', 'café:\n    ret\n'],
      ['full-width letters', 'ｍｏｖ ｅａｘ, １'],
      ['right-to-left text', 'main:\n    mov eax, 1 # تعليق\n    ret\n'],
      ['combining marks', 'móv eax, 1'],
      ['only carriage returns', '\r\r\r'],
      ['a carriage return in the middle of a line', 'main:\n    mov eax,\r 1\n    ret\n'],
      ['mixed line ends', 'main:\r\n    nop\n    nop\r    ret\r\n'],
      ['HTML', '<script>alert(1)</script>'],
      ['JSON', '{"a": [1, 2, {"b": null}]}'],
      ['C code', 'int main(void) { return 0; }'],
      ['a shell command', 'gcc -S -masm=intel hello.c && ./a.out'],
      ['AT&T code', 'movq %rsp, %rbp\nsubq $16, %rsp\nmovl $0, -4(%rbp)\n'],
      ['NASM code', 'section .text\nglobal _start\n_start:\n    mov rax, 60\n    syscall\n'],
      ['ARM code', 'main:\n    stp x29, x30, [sp, #-16]!\n    ldr w0, =0x10\n    bl printf\n'],
      ['a format string as a line', '%s%s%s%n%d'],
      ['a template', '${line} {{x}} <%= y %>'],
    ])('%s does not throw', (_name, source) => {
      check(source)
    })

    it('a program with a byte order mark still reports its errors on the right lines', () => {
      const result = check('\ufeff.intel_syntax noprefix\nmain:\n    mov [rax], [rbx]\n    ret\n')
      expect(
        result.diagnostics.filter((d) => d.code === 'memory-to-memory').map((d) => d.line),
      ).toEqual([3])
    })
  })

  describe('pseudo-random input (fixed seed)', () => {
    const CHARACTERS = [
      ...'abcdefghijklmnopqrstuvwxyzABCDEFXYZ0123456789',
      ...'      \t\n\n\n\r,,::..##;/*+-[]()"\'\\%$@=_!?<>{}|&^~`',
      '\0',
      '\u0001',
      '\u007f',
      'é',
      'ß',
      '日',
      '😀',
      '\u2028',
      '\u00a0',
      '\ufeff',
    ]

    const TOKENS = [
      ...'mov add sub lea push pop cmp jmp je jle call ret inc dec imul movzx movsx test xor'.split(
        ' ',
      ),
      ...'and or nop leave endbr64 shl movq MOV Jmp'.split(' '),
      ...'rax eax ax al ah rbx rcx rbp rsp rip r8 r8d r15b sil rex RAX'.split(' '),
      ...'0 1 -8 16 0x10 0xZZ 010 255 256 0b101 99999999999999999999999 4294967296'.split(' '),
      "'A'",
      "'\\n'",
      "'",
      "''",
      ...', , , , : [ ] [ ] + - * ( ) # ; // " @PLT %rax $5 = ,'.split(' '),
      '"hi"',
      '"a\\n"',
      '"a\\q"',
      '"%d\\n"',
      ...'byte word dword qword ptr PTR offset flat OFFSET FLAT:'.split(' '),
      ...'.text .data .string .asciz .equ .set .quad .long .byte .zero .section .rodata .globl'.split(
        ' ',
      ),
      '.intel_syntax noprefix',
      '.foo',
      ...'main main: loop: loop msg msg: count size printf printf@PLT puts done done:'.split(' '),
    ]

    const SEEDS = [
      src(
        HEADER,
        '.section .rodata',
        'message: .string "Hello, world!\\n"',
        '.text',
        '.globl main',
        'main:',
        '    push rbp',
        '    mov rbp, rsp',
        '    lea rdi, message[rip]',
        '    mov eax, 0',
        '    call printf@PLT',
        '    mov eax, 0',
        '    pop rbp',
        '    ret',
      ),
      src(
        HEADER,
        '.equ count, -8',
        'main:',
        '    push rbp',
        '    mov rbp, rsp',
        '    sub rsp, 16',
        '    mov qword ptr count[rbp], 0',
        'loop:',
        '    inc qword ptr count[rbp]',
        '    cmp qword ptr count[rbp], 10',
        '    jle loop',
        '    mov rax, [rbp+rcx*8-16]',
        '    movzx eax, byte ptr [rdi+rcx]',
        '    leave',
        '    ret',
      ),
      src(
        HEADER,
        '.data',
        'array: .quad 1, 2, 3',
        "letters: .byte 'a', 'b'",
        '.text',
        'main:',
        '    mov rax, array[rax*8]',
        '    mov rdi, OFFSET FLAT:array',
        "    cmp al, 'x'",
        '    jne main',
        '    ret',
      ),
    ]

    it('250 strings of random characters never throw', () => {
      const random = makeRandom(20260514)
      for (let i = 0; i < 250; i++) {
        const length = Math.floor(random() * 80)
        let text = ''
        for (let j = 0; j < length; j++) text += pick(random, CHARACTERS)
        check(text)
      }
    })

    it('250 strings of random assembly words never throw', () => {
      const random = makeRandom(8086)
      for (let i = 0; i < 250; i++) {
        const lineCount = 1 + Math.floor(random() * 10)
        const lines: string[] = []
        for (let j = 0; j < lineCount; j++) {
          const wordCount = Math.floor(random() * 8)
          let line = ''
          for (let k = 0; k < wordCount; k++) {
            line += pick(random, TOKENS) + (random() < 0.8 ? ' ' : '')
          }
          lines.push(line)
        }
        check(lines.join('\n'))
      }
    })

    it('300 real programs with random damage never throw', () => {
      const random = makeRandom(64)
      for (let i = 0; i < 300; i++) {
        let text = pick(random, SEEDS)
        const edits = 1 + Math.floor(random() * 5)
        for (let j = 0; j < edits; j++) {
          const position = Math.floor(random() * (text.length + 1))
          const kind = Math.floor(random() * 5)
          if (kind === 0) {
            text = text.slice(0, position) + text.slice(position + 1)
          } else if (kind === 1) {
            text = text.slice(0, position) + pick(random, CHARACTERS) + text.slice(position)
          } else if (kind === 2) {
            text = text.slice(0, position) + pick(random, CHARACTERS) + text.slice(position + 1)
          } else if (kind === 3) {
            text = text.slice(0, position) + pick(random, TOKENS) + text.slice(position)
          } else {
            text = text.slice(0, position)
          }
        }
        check(text)
      }
    })

    it('200 random lists of operands after every mnemonic never throw', () => {
      const random = makeRandom(1978)
      const operands = [
        ...'rax eax ax al ah r8 r8b sil rsp rip 0 1 -1 255 256 0x80000000 0xffffffffffffffff'.split(
          ' ',
        ),
        ...'[rax] [rbp-8] [rsp] [eax] [rax+rbx*8] [rax*3] [rip] [] main printf nowhere'.split(' '),
        'byte ptr [rax]',
        'qword ptr [rbp-8]',
        'dword ptr',
        'offset main',
        "'A'",
        '',
      ]
      for (let i = 0; i < 200; i++) {
        const mnemonic = pick(random, MNEMONICS)
        const count = Math.floor(random() * 4)
        const list = Array.from({ length: count }, () => pick(random, operands))
        check(src(HEADER, 'main:', `    ${mnemonic} ${list.join(', ')}`, '    ret'))
      }
    })
  })
})
