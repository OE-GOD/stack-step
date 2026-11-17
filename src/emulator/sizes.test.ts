import { describe, expect, it } from 'vitest'
import rawFixture from './__fixtures__/encoding-sizes.json'
import { assemble } from './assembler'
import { reg } from './registers'
import { fitsSignedByte, instructionSize, memoryBytes, NEAR_JUMP_SIZE } from './sizes'
import { MNEMONICS, type Instruction, type MemOperand, type Operand } from './types'

/* ───────────────────────── the clang fixture ───────────────────────── */

interface MeasuredLine {
  asm: string
  /** Encoded length that clang gave this line (0 for a label). */
  bytes: number
  /** The line stands for this many copies of itself. */
  repeat?: number
  /** clang needed another spelling for the same instruction. */
  assembledAs?: string
}

interface SizeFixture {
  about: string
  assembler: string
  target: string
  /** Lines every single instruction may use (data labels and constants). */
  preamble: string[]
  singles: MeasuredLine[]
  programs: { name: string; lines: MeasuredLine[] }[]
}

const fixture: SizeFixture = rawFixture

/** Assemble source that must have no mistakes. */
function instructionsOf(source: string): Instruction[] {
  const result = assemble(source)
  if (!result.ok) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'))
  }
  return result.program.instructions
}

/** The size the emulator gives one instruction (assembled after the fixture's preamble). */
function sizeOf(asm: string): number {
  return instructionsOf([...fixture.preamble, 'main:', asm, 'ret'].join('\n'))[0].size
}

describe('the fixture made with clang', () => {
  it('was made by a real assembler for x86-64', () => {
    expect(fixture.assembler).toMatch(/clang/)
    expect(fixture.target).toMatch(/x86_64/)
  })

  it('covers at least 150 single instruction forms, each only once', () => {
    expect(fixture.singles.length).toBeGreaterThanOrEqual(150)
    expect(new Set(fixture.singles.map((single) => single.asm)).size).toBe(fixture.singles.length)
  })

  it('covers every instruction and every other spelling the emulator accepts', () => {
    const lines = [...fixture.singles, ...fixture.programs.flatMap((program) => program.lines)].map(
      (line) => line.asm.split(' ')[0],
    )
    const used = new Set(lines)
    const spellings = [
      ...MNEMONICS,
      ...['jz', 'jnz', 'jnle', 'jnl', 'jnge', 'jng', 'jnbe', 'jnb', 'jnc', 'jnae', 'jc', 'jna'],
      ...['movsxd', 'endbr64'],
    ]
    expect(spellings.filter((name) => !used.has(name))).toEqual([])
  })

  it('covers every shape of memory operand', () => {
    const text = fixture.singles.map((single) => single.asm).join('\n')
    for (const shape of [
      '[rax]', // no displacement
      '[rbp-8]', // 8-bit displacement
      '[rbp-1000]', // 32-bit displacement
      '[rsp]', // rsp base (needs SIB)
      '[rbp]', // rbp base (needs a displacement)
      '[r12]', // like rsp
      '[r13]', // like rbp
      '[rdi+rcx*8]', // index and scale
      '[rbx*8]', // index without base
      'message[rip]', // rip-relative
      'mov eax, counter', // absolute
      '[0x1000]', // absolute number
    ]) {
      expect(text, shape).toContain(shape)
    }
  })

  it('has near and far jumps, forward and backward', () => {
    const jumps = fixture.programs
      .flatMap((program) => program.lines)
      .filter((line) => line.asm.startsWith('j'))
    expect(new Set(jumps.map((line) => line.bytes))).toEqual(new Set([2, 5, 6]))
  })
})

describe('single instructions: the emulator agrees with clang', () => {
  it.each(fixture.singles)('$asm = $bytes', ({ asm, bytes }) => {
    expect(sizeOf(asm)).toBe(bytes)
  })
})

describe('whole programs: the emulator agrees with clang', () => {
  it.each(fixture.programs)('$name', ({ lines }) => {
    const source: string[] = []
    const expected: number[] = []
    for (const line of lines) {
      for (let copy = 0; copy < (line.repeat ?? 1); copy++) {
        source.push(line.asm)
        expected.push(line.bytes)
      }
    }
    const result = assemble(source.join('\n'))
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join('\n'))
    const { instructions, lineToIndex, layout } = result.program
    const sizes = source.map((_, i) => {
      const index = lineToIndex.get(i + 1)
      return index === undefined ? 0 : instructions[index].size
    })
    expect(sizes).toEqual(expected)
    // The sizes add up to the length of the code.
    const total = expected.reduce((sum, size) => sum + size, 0)
    expect(layout.textEnd - layout.textBase).toBe(BigInt(total))
  })
})

/* ───────────────── the reference values of the contract ───────────────── */

describe('reference values', () => {
  it.each([
    ['push rbx', 1],
    ['push r12', 2],
    ['pop rbp', 1],
    ['mov rbp, rsp', 3],
    ['mov eax, ebx', 2],
    ['mov eax, 0', 5],
    ['mov rax, 5', 7],
    ['mov rax, 0x1122334455667788', 10],
    ['mov al, 7', 2],
    ['mov sil, 7', 3],
    ['mov ax, 7', 4],
    ['mov r8d, 7', 6],
    ['sub rsp, 16', 4],
    ['add rax, rbx', 3],
    ['add eax, 5', 3],
    ['add eax, 1000', 5],
    ['add rax, 1000', 6],
    ['cmp al, 5', 2],
    ['cmp rax, 10', 4],
    ['lea rdi, message[rip]', 7],
    ['lea rdi, 8[rsp]', 5],
    ['lea rax, [rbp-8]', 4],
    ['mov eax, [rbp-4]', 3],
    ['mov rax, [rbp-8]', 4],
    ['mov [rbp-8], rax', 4],
    ['mov rax, [rsp]', 4],
    ['mov rax, [rax]', 3],
    ['mov dword ptr [rbp-4], 5', 7],
    ['mov qword ptr [rbp-8], 5', 8],
    ['mov byte ptr [rbp-1], 5', 4],
    ['mov rax, [rdi+rcx*8]', 4],
    ['inc rax', 3],
    ['inc eax', 2],
    ['inc al', 2],
    ['dec ecx', 2],
    ['imul rax, rbx', 4],
    ['imul eax, ebx', 3],
    ['movzx eax, al', 3],
    ['movsx rax, al', 4],
    ['test rax, rax', 3],
    ['test al, 1', 2],
    ['test eax, 1', 5],
    ['xor eax, eax', 2],
    ['call printf@PLT', 5],
    ['ret', 1],
    ['nop', 1],
    ['leave', 1],
    ['endbr64', 4],
  ])('%s = %i', (asm, bytes) => {
    expect(sizeOf(asm)).toBe(bytes)
  })

  it('spelling and letter case do not change the size', () => {
    expect(sizeOf('MOV   EAX,DWORD PTR [RBP-4]')).toBe(sizeOf('mov eax, dword ptr [rbp-4]'))
    expect(sizeOf('mov rax, -8[rbp]')).toBe(sizeOf('mov rax, [rbp-8]'))
    expect(sizeOf('mov rax, count[rbp]')).toBe(sizeOf('mov rax, [rbp-8]'))
    expect(sizeOf('movsx rax, ebx')).toBe(sizeOf('movsxd rax, ebx'))
    expect(sizeOf('mov rax, OFFSET FLAT:message')).toBe(sizeOf('mov rax, offset message'))
  })
})

/* ─────────────────────────── the parts ─────────────────────────── */

describe('parts of an instruction', () => {
  const memory = (parts: Partial<MemOperand>): MemOperand => ({
    kind: 'mem',
    size: null,
    base: null,
    index: null,
    scale: 1,
    disp: 0n,
    symbol: null,
    symbolAddress: 0n,
    equNames: [],
    text: '',
    ...parts,
  })

  it.each([
    ['[rax]', { base: 'rax' }, 0],
    ['[rax+8]', { base: 'rax', disp: 8n }, 1],
    ['[rax+127]', { base: 'rax', disp: 127n }, 1],
    ['[rax-128]', { base: 'rax', disp: -128n }, 1],
    ['[rax+128]', { base: 'rax', disp: 128n }, 4],
    ['[rax-129]', { base: 'rax', disp: -129n }, 4],
    ['[rbp]', { base: 'rbp' }, 1],
    ['[r13]', { base: 'r13' }, 1],
    ['[rsp]', { base: 'rsp' }, 1],
    ['[r12]', { base: 'r12' }, 1],
    ['[rsp+8]', { base: 'rsp', disp: 8n }, 2],
    ['[rsp+1000]', { base: 'rsp', disp: 1000n }, 5],
    ['[rax+rbx]', { base: 'rax', index: 'rbx' }, 1],
    ['[rax+rbx*8+16]', { base: 'rax', index: 'rbx', scale: 8, disp: 16n }, 2],
    ['[rbp+rax*8]', { base: 'rbp', index: 'rax', scale: 8 }, 2],
    ['[rbx*8]', { index: 'rbx', scale: 8 }, 5],
    ['[0x1000]', { disp: 0x1000n }, 5],
    ['message[rip]', { base: 'rip', symbol: 'message' }, 4],
    ['counter', { symbol: 'counter' }, 5],
    ['table[rbx]', { base: 'rbx', symbol: 'table' }, 4],
    ['table[rsp]', { base: 'rsp', symbol: 'table' }, 5],
  ] as [string, Partial<MemOperand>, number][])(
    'memory %s adds %i bytes',
    (_text, parts, bytes) => {
      expect(memoryBytes(memory(parts))).toBe(bytes)
    },
  )

  it.each([
    [-129n, false],
    [-128n, true],
    [0n, true],
    [127n, true],
    [128n, false],
  ])('fitsSignedByte(%s) is %s', (value, expected) => {
    expect(fitsSignedByte(value)).toBe(expected)
  })

  const target: Operand = {
    kind: 'target',
    name: 'done',
    address: 0n,
    external: false,
    text: 'done',
  }

  it('gives jumps their near and far sizes', () => {
    expect(NEAR_JUMP_SIZE).toBe(2)
    expect(instructionSize('jmp', 'jmp', [target], null)).toBe(2)
    expect(instructionSize('jmp', 'jmp', [target], null, { longJump: true })).toBe(5)
    expect(instructionSize('jne', 'jnz', [target], null)).toBe(2)
    expect(instructionSize('jne', 'jnz', [target], null, { longJump: true })).toBe(6)
    expect(instructionSize('call', 'call', [target], null, { longJump: true })).toBe(5)
  })

  it('keeps 4 bytes for a number that is the address of a label', () => {
    const rax: Operand = { kind: 'reg', reg: reg('rax'), text: 'rax' }
    const small: Operand = { kind: 'imm', value: 5n, symbol: 'five', text: 'five' }
    const isLabel = (name: string): boolean => name === 'five'
    // As an `.equ` constant the number 5 takes one byte; as an address it takes four.
    expect(instructionSize('push', 'push', [small], 64)).toBe(2)
    expect(instructionSize('push', 'push', [small], 64, { isLabel })).toBe(5)
    expect(instructionSize('add', 'add', [rax, small], 64)).toBe(4)
    expect(instructionSize('add', 'add', [rax, small], 64, { isLabel })).toBe(7)
    expect(instructionSize('imul', 'imul', [rax, small], 64)).toBe(4)
    expect(instructionSize('imul', 'imul', [rax, small], 64, { isLabel })).toBe(7)
  })

  it('never throws for a shape that is not valid', () => {
    for (const mnemonic of MNEMONICS) {
      expect(instructionSize(mnemonic, mnemonic, [], null)).toBeGreaterThan(0)
      expect(instructionSize(mnemonic, mnemonic, [target, target], 8)).toBeGreaterThan(0)
    }
  })
})
