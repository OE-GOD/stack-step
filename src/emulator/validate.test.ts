import { describe, expect, it } from 'vitest'
import { parseLine, resolveOperands, type SymbolEnv } from './parser'
import { reg } from './registers'
import {
  LIBRARY_FUNCTIONS,
  MNEMONICS,
  type AssembleCode,
  type Diagnostic,
  type Mnemonic,
  type Operand,
  type OperandSize,
} from './types'
import {
  expectedOperandCount,
  fitsBits,
  fitsSignExtended32,
  isBranch,
  isConditionalJump,
  operandCountProblem,
  validateInstruction,
  type ValidationResult,
} from './validate'

/* ───────────────────────────── helpers ───────────────────────────── */

const CONSTANTS: Record<string, bigint> = { count: -8n, big: 1000n, huge: 0x1_0000_0000n }
const ENV: SymbolEnv = {
  constant: (name) => (Object.hasOwn(CONSTANTS, name) ? CONSTANTS[name] : undefined),
  label: (name) => {
    if (name === 'message') return { kind: 'data', address: 0x402010n }
    if (name === 'done') return { kind: 'code', address: 0x401140n }
    return undefined
  },
  names: () => ['count', 'big', 'huge', 'message', 'done'],
}

/** Read one instruction line and check it against the operand rules. */
function check(text: string, line = 1): ValidationResult {
  const parsed = parseLine(text, line)
  if (parsed.error !== null) throw new Error(`${text}: ${parsed.error.message}`)
  const statement = parsed.statement
  if (statement?.kind !== 'instruction') throw new Error(`not an instruction: ${text}`)
  const resolved = resolveOperands(statement, ENV, line)
  if (!resolved.ok) throw new Error(`${text}: ${resolved.diagnostic.message}`)
  return validateInstruction(line, statement.mnemonic, statement.written, resolved.operands)
}

/** The width of a line that must follow the rules. */
function sizeOf(text: string): OperandSize | null {
  const result = check(text)
  if (!result.ok) throw new Error(`${text}: ${result.diagnostic.message}`)
  return result.opSize
}

/** The broken rule of a line that must break one. */
function problemOf(text: string, line = 1): Diagnostic {
  const result = check(text, line)
  if (result.ok) throw new Error(`no problem in: ${text}`)
  return result.diagnostic
}

const RAX: Operand = { kind: 'reg', reg: reg('rax'), text: 'rax' }
const FIVE: Operand = { kind: 'imm', value: 5n, symbol: null, text: '5' }

type Legal = [text: string, opSize: OperandSize | null]
type Illegal = [text: string, code: AssembleCode]

/* ──────────────────────── rule 1: operand count ──────────────────────── */

describe('rule 1: the number of operands', () => {
  it.each(MNEMONICS.map((mnemonic) => [mnemonic]))('%s has a known count', (mnemonic) => {
    const count = expectedOperandCount(mnemonic)
    const two = [
      'mov',
      'movzx',
      'movsx',
      'lea',
      'add',
      'sub',
      'imul',
      'cmp',
      'test',
      'and',
      'or',
      'xor',
    ]
    const none = ['ret', 'nop', 'leave']
    expect(count).toBe(two.includes(mnemonic) ? 2 : none.includes(mnemonic) ? 0 : 1)
    expect(operandCountProblem(1, mnemonic, mnemonic, count)).toBeNull()
  })

  it.each([
    ['mov', 0],
    ['mov', 1],
    ['mov', 3],
    ['push', 0],
    ['push', 2],
    ['ret', 1],
    ['jmp', 0],
    ['jmp', 2],
    ['call', 2],
    ['imul', 0],
    ['imul', 4],
  ] as [Mnemonic, number][])('%s with %i operands is `operand-count`', (mnemonic, found) => {
    expect(operandCountProblem(4, mnemonic, mnemonic, found)).toMatchObject({
      severity: 'error',
      code: 'operand-count',
      line: 4,
    })
  })

  it.each([1, 3])('imul with %i operands is `invalid-operands` (only 2 are supported)', (found) => {
    expect(operandCountProblem(2, 'imul', 'imul', found)).toEqual({
      severity: 'error',
      code: 'invalid-operands',
      line: 2,
      message: `Line 2: this emulator supports only the 2-operand form of \`imul\`, like \`imul rax, rbx\`. This line has ${found}.`,
    })
  })

  it('checks the count before every other rule', () => {
    const result = validateInstruction(3, 'mov', 'mov', [FIVE])
    expect(result).toMatchObject({ ok: false, diagnostic: { code: 'operand-count', line: 3 } })
  })

  it('shows the shape with the spelling that was typed', () => {
    expect(operandCountProblem(1, 'je', 'jz', 0)?.message).toBe(
      'Line 1: `jz` needs 1 operand (the part after `jz`): `jz label`. This line has none.',
    )
  })

  it('sorts the instructions into kinds', () => {
    const jumps = MNEMONICS.filter(isConditionalJump)
    expect(jumps).toEqual([
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
    ])
    expect(MNEMONICS.filter(isBranch)).toEqual(['jmp', ...jumps, 'call'])
  })
})

/* ───────────────────────── rule 2: high bytes ───────────────────────── */

describe('rule 2: ah/bh/ch/dh with a register that needs REX', () => {
  it.each([
    'mov ah, r8b',
    'mov r9b, bh',
    'mov ch, sil',
    'mov dil, dh',
    'add ah, spl',
    'cmp bpl, ah',
    'mov ah, [r8]',
    'mov [rax+r9], ah',
    'mov [r15+rax*2], bh',
    'movzx r8d, ah',
    'test ah, r10b',
  ])('refuses %j', (text) => {
    expect(problemOf(text)).toMatchObject({ code: 'high-byte-rex', line: 1 })
  })

  it.each([
    'mov ah, bl',
    'mov ah, bh',
    'mov ah, [rax]',
    'mov al, r8b',
    'mov sil, dil',
    'movzx eax, ah',
  ])('allows %j', (text) => {
    expect(check(text).ok).toBe(true)
  })

  it('names both registers', () => {
    expect(problemOf('mov ah, r8b').message).toBe(
      "Line 1: `ah` and `r8b` can't be in the same instruction. x86-64 machine code has no way to write that. Use a different register for one of them.",
    )
  })

  it('comes before the size rules', () => {
    expect(problemOf('mov ah, r8').code).toBe('high-byte-rex')
  })

  it('also refuses a high byte with a 64-bit destination (it needs REX too)', () => {
    expect(problemOf('movzx rax, ah')).toMatchObject({
      code: 'high-byte-rex',
      message:
        "Line 1: `ah` can't be used with a 64-bit register. x86-64 machine code has no way to write that. Write `movzx eax, ah` instead.",
    })
    expect(problemOf('movsx rbx, ch')).toMatchObject({
      code: 'high-byte-rex',
      message:
        "Line 1: `ch` can't be used with a 64-bit register. x86-64 machine code has no way to write that. Copy `ch` into a different 8-bit register first, like `cl`.",
    })
  })
})

/* ─────────────────────── rule 3: each instruction ─────────────────────── */

describe('mov add sub cmp and or xor test', () => {
  const NAMES = ['mov', 'add', 'sub', 'cmp', 'and', 'or', 'xor', 'test']

  describe.each(NAMES)('%s', (name) => {
    it.each([
      [`${name} rax, rbx`, 64],
      [`${name} eax, ebx`, 32],
      [`${name} ax, bx`, 16],
      [`${name} al, bl`, 8],
      [`${name} ah, bl`, 8],
      [`${name} r8, r9`, 64],
      [`${name} rax, [rbp-8]`, 64],
      [`${name} eax, [rbp-8]`, 32],
      [`${name} al, [rbp-8]`, 8],
      [`${name} eax, dword ptr [rbp-8]`, 32],
      [`${name} [rbp-8], rax`, 64],
      [`${name} [rbp-8], ax`, 16],
      [`${name} qword ptr [rbp-8], rax`, 64],
      [`${name} rax, 5`, 64],
      [`${name} eax, -1`, 32],
      [`${name} al, 255`, 8],
      [`${name} al, -128`, 8],
      [`${name} ax, 65535`, 16],
      [`${name} eax, 4294967295`, 32],
      [`${name} eax, -2147483648`, 32],
      [`${name} rax, 2147483647`, 64],
      [`${name} rax, -2147483648`, 64],
      [`${name} rax, 0xffffffffffffffff`, 64],
      [`${name} rax, 0xffffffff80000000`, 64],
      [`${name} byte ptr [rax], 5`, 8],
      [`${name} word ptr [rax], 5`, 16],
      [`${name} dword ptr [rax], 5`, 32],
      [`${name} qword ptr [rax], 5`, 64],
      [`${name} qword ptr [rax], -1`, 64],
      [`${name} eax, count`, 32],
      [`${name} rax, message`, 64],
    ] as Legal[])('allows %j', (text, opSize) => {
      expect(sizeOf(text)).toBe(opSize)
    })

    it.each([
      [`${name} 5, rax`, 'immediate-destination'],
      [`${name} 5, [rax]`, 'immediate-destination'],
      [`${name} 5, 6`, 'immediate-destination'],
      [`${name} [rax], [rbx]`, 'memory-to-memory'],
      [`${name} qword ptr [rax], qword ptr [rbx]`, 'memory-to-memory'],
      [`${name} message, [rbx]`, 'memory-to-memory'],
      [`${name} eax, bx`, 'size-mismatch'],
      [`${name} rax, ebx`, 'size-mismatch'],
      [`${name} al, bx`, 'size-mismatch'],
      [`${name} eax, qword ptr [rbp-8]`, 'size-mismatch'],
      [`${name} byte ptr [rbp-8], eax`, 'size-mismatch'],
      [`${name} [rbp-8], 5`, 'missing-size'],
      [`${name} message, 5`, 'missing-size'],
      [`${name} al, 256`, 'immediate-too-large'],
      [`${name} al, -129`, 'immediate-too-large'],
      [`${name} ax, 65536`, 'immediate-too-large'],
      [`${name} eax, 4294967296`, 'immediate-too-large'],
      [`${name} eax, -2147483649`, 'immediate-too-large'],
      [`${name} byte ptr [rax], 256`, 'immediate-too-large'],
      [`${name} qword ptr [rax], 0x100000000`, 'immediate-too-large'],
      [`${name} qword ptr [rax], 0x80000000`, 'immediate-too-large'],
      [`${name} rax, 18446744073709551616`, 'immediate-too-large'],
      [`${name} al, big`, 'immediate-too-large'],
      [`${name} al, offset message`, 'immediate-too-large'],
    ] as Illegal[])('refuses %j with %s', (text, code) => {
      expect(problemOf(text, 7)).toMatchObject({ severity: 'error', code, line: 7 })
    })
  })

  it('lets mov put any 64-bit number into a 64-bit register', () => {
    for (const number of ['0x100000000', '0x1122334455667788', '-9223372036854775808', 'huge']) {
      expect(sizeOf(`mov rax, ${number}`)).toBe(64)
    }
    expect(problemOf('mov rax, -9223372036854775809').code).toBe('immediate-too-large')
  })

  it.each(['add', 'sub', 'cmp', 'and', 'or', 'xor', 'test'])(
    '%s takes at most 32 bits for a 64-bit register',
    (name) => {
      for (const number of ['0x100000000', '0x80000000', '-2147483649', 'huge']) {
        expect(problemOf(`${name} rax, ${number}`).code).toBe('immediate-too-large')
      }
    },
  )

  it('allows test register, memory', () => {
    expect(sizeOf('test eax, [rbp-4]')).toBe(32)
    expect(sizeOf('test [rbp-4], eax')).toBe(32)
  })

  it('says the fixed sentence for mov memory, memory', () => {
    expect(problemOf('mov [rax], [rbx]', 7)).toEqual({
      severity: 'error',
      code: 'memory-to-memory',
      line: 7,
      message: "Line 7: you can't move memory into memory. Load it into a register first.",
    })
  })

  it.each([
    [
      'add [rax], [rbx]',
      "Line 1: `add` can't use two memory operands (two parts in brackets). Copy one of them into a register first.",
    ],
    [
      'mov 5, rax',
      "Line 1: a number can't be the destination. Put the register or memory first: `mov rax, 5`.",
    ],
    [
      'add 5, [rbp-8]',
      "Line 1: a number can't be the destination. Put the register or memory first: `add dword ptr [rbp-8], 5`.",
    ],
    [
      'cmp 5, rax',
      "Line 1: a number can't be the first operand of `cmp`. Put the register or memory first: `cmp rax, 5`.",
    ],
    [
      'test 1, al',
      "Line 1: a number can't be the first operand of `test`. Put the register or memory first: `test al, 1`.",
    ],
    [
      'mov eax, bx',
      'Line 1: `eax` is 32 bits but `bx` is 16 bits. Both sides of `mov` must be the same size. To copy a smaller value into a bigger register, use `movzx` or `movsx`.',
    ],
    [
      'mov eax, qword ptr [rbp-8]',
      'Line 1: `eax` is 32 bits but `qword ptr [rbp-8]` is 64 bits. Both sides of `mov` must be the same size.',
    ],
    [
      'sub byte ptr [rbp-8], eax',
      'Line 1: `byte ptr [rbp-8]` is 8 bits but `eax` is 32 bits. Both sides of `sub` must be the same size.',
    ],
    [
      'mov [rbp-8], 5',
      'Line 1: this line does not say how many bytes to write to `[rbp-8]`. Add `byte ptr` (1 byte), `word ptr` (2), `dword ptr` (4) or `qword ptr` (8) in front, like `mov dword ptr [rbp-8], 5`.',
    ],
    [
      'add [rax], 1',
      'Line 1: this line does not say how many bytes to change at `[rax]`. Add `byte ptr` (1 byte), `word ptr` (2), `dword ptr` (4) or `qword ptr` (8) in front, like `add dword ptr [rax], 1`.',
    ],
    [
      'cmp [rbp-8], 0',
      'Line 1: this line does not say how many bytes to compare at `[rbp-8]`. Add `byte ptr` (1 byte), `word ptr` (2), `dword ptr` (4) or `qword ptr` (8) in front, like `cmp dword ptr [rbp-8], 0`.',
    ],
    [
      'mov al, 256',
      'Line 1: `256` does not fit in `al`. `al` holds 8 bits, so the number must be between -128 and 255.',
    ],
    [
      'mov word ptr [rax], 70000',
      'Line 1: `70000` does not fit in `word ptr [rax]`. `word ptr [rax]` holds 16 bits, so the number must be between -32768 and 65535.',
    ],
    [
      'mov al, big',
      'Line 1: `big` is 1000. It does not fit in `al`. `al` holds 8 bits, so the number must be between -128 and 255.',
    ],
    [
      'mov al, offset message',
      'Line 1: `offset message` is the address 0x402010. It does not fit in `al`. `al` holds 8 bits, so the number must be between -128 and 255.',
    ],
    [
      'add rax, 0x100000000',
      'Line 1: `0x100000000` is too big for `add`. Here the number must be between -2147483648 and 2147483647. Copy it into a register first with `mov`.',
    ],
    [
      'mov qword ptr [rax], 0x100000000',
      'Line 1: `0x100000000` is too big to copy into 64-bit memory in one step. Copy it into a register first, then copy the register into memory.',
    ],
    [
      'mov rax, 99999999999999999999',
      "Line 1: `99999999999999999999` does not fit in 64 bits. A register can't hold a number this big.",
    ],
  ])('explains %j', (text, message) => {
    expect(problemOf(text).message).toBe(message)
  })
})

describe('inc and dec', () => {
  it.each([
    ['inc rax', 64],
    ['inc eax', 32],
    ['inc ax', 16],
    ['inc al', 8],
    ['inc ah', 8],
    ['dec r8d', 32],
    ['inc byte ptr [rax]', 8],
    ['inc word ptr [rax]', 16],
    ['dec dword ptr [rbp-4]', 32],
    ['dec qword ptr [rsp]', 64],
    ['inc dword ptr message[rip]', 32],
  ] as Legal[])('allows %j', (text, opSize) => {
    expect(sizeOf(text)).toBe(opSize)
  })

  it.each([
    ['inc [rax]', 'missing-size'],
    ['dec [rbp-8]', 'missing-size'],
    ['inc message', 'missing-size'],
    ['inc 5', 'immediate-destination'],
    ['dec count', 'immediate-destination'],
  ] as Illegal[])('refuses %j with %s', (text, code) => {
    expect(problemOf(text, 2)).toMatchObject({ code, line: 2 })
  })

  it('explains what to add', () => {
    expect(problemOf('inc [rax]').message).toBe(
      'Line 1: this line does not say how many bytes to change at `[rax]`. Add `byte ptr` (1 byte), `word ptr` (2), `dword ptr` (4) or `qword ptr` (8) in front, like `inc dword ptr [rax]`.',
    )
    expect(problemOf('inc 5')).toEqual({
      severity: 'error',
      code: 'immediate-destination',
      line: 1,
      message: "Line 1: `inc` can't change a number. Give it a register or memory, like `inc rax`.",
    })
  })
})

describe('imul', () => {
  it.each([
    ['imul rax, rbx', 64],
    ['imul eax, ebx', 32],
    ['imul ax, bx', 16],
    ['imul rax, [rbp-8]', 64],
    ['imul eax, dword ptr [rbp-4]', 32],
    ['imul eax, 5', 32],
    ['imul rax, -1', 64],
    ['imul ax, 65535', 16],
    ['imul rax, 2147483647', 64],
    ['imul eax, count', 32],
  ] as Legal[])('allows %j', (text, opSize) => {
    expect(sizeOf(text)).toBe(opSize)
  })

  it.each([
    ['imul al, bl', 'invalid-operands'],
    ['imul al, 5', 'invalid-operands'],
    ['imul [rax], rbx', 'invalid-operands'],
    ['imul qword ptr [rax], 5', 'invalid-operands'],
    ['imul 5, rax', 'immediate-destination'],
    ['imul 5, [rax]', 'immediate-destination'],
    ['imul rax, ebx', 'size-mismatch'],
    ['imul eax, bl', 'size-mismatch'],
    ['imul eax, qword ptr [rbp-8]', 'size-mismatch'],
    ['imul rax, 0x100000000', 'immediate-too-large'],
    ['imul ax, 65536', 'immediate-too-large'],
    ['imul eax, huge', 'immediate-too-large'],
  ] as Illegal[])('refuses %j with %s', (text, code) => {
    expect(problemOf(text)).toMatchObject({ code, line: 1 })
  })

  it('explains the destination rule', () => {
    expect(problemOf('imul al, bl').message).toBe(
      'Line 1: the destination of `imul` must be a register of 16, 32 or 64 bits, like `imul eax, ebx`.',
    )
    expect(problemOf('imul 5, rbx').message).toBe(
      "Line 1: a number can't be the destination of `imul`. Put a register first, like `imul rbx, 5`.",
    )
    expect(problemOf('imul 5, [rbx]').message).toBe(
      "Line 1: a number can't be the destination of `imul`. Put a register first, like `imul rax, 5`.",
    )
  })
})

describe('movzx and movsx', () => {
  it.each([
    ['movzx eax, al', 32],
    ['movzx eax, ax', 32],
    ['movzx rax, al', 64],
    ['movzx rax, bx', 64],
    ['movzx ax, bl', 16],
    ['movzx eax, byte ptr [rax]', 32],
    ['movzx rax, word ptr [rax]', 64],
    ['movzx r8d, sil', 32],
    ['movsx eax, al', 32],
    ['movsx rax, al', 64],
    ['movsx rax, ax', 64],
    ['movsx ax, al', 16],
    ['movsx rax, ebx', 64],
    ['movsxd rax, ebx', 64],
    ['movsx rax, dword ptr [rbp-4]', 64],
    ['movsx eax, word ptr [rbp-2]', 32],
  ] as Legal[])('allows %j', (text, opSize) => {
    expect(sizeOf(text)).toBe(opSize)
  })

  it.each([
    ['movzx eax, ebx', 'size-mismatch'],
    ['movzx ax, bx', 'size-mismatch'],
    ['movzx al, bl', 'size-mismatch'],
    ['movzx eax, rbx', 'size-mismatch'],
    ['movzx ax, eax', 'size-mismatch'],
    ['movzx eax, dword ptr [rax]', 'size-mismatch'],
    ['movzx rax, qword ptr [rax]', 'size-mismatch'],
    ['movsx eax, ebx', 'size-mismatch'],
    ['movsx rax, rbx', 'size-mismatch'],
    ['movsx ax, word ptr [rax]', 'size-mismatch'],
    ['movzx eax, [rax]', 'missing-size'],
    ['movsx rax, [rbp-4]', 'missing-size'],
    ['movzx eax, message', 'missing-size'],
    ['movzx rax, ebx', 'invalid-operands'],
    ['movzx rax, dword ptr [rax]', 'invalid-operands'],
    ['movzx eax, 5', 'invalid-operands'],
    ['movzx [rax], al', 'invalid-operands'],
    ['movsx dword ptr [rax], al', 'invalid-operands'],
    ['movsx eax, count', 'invalid-operands'],
    ['movzx 5, al', 'immediate-destination'],
    ['movsx 5, 6', 'immediate-destination'],
  ] as Illegal[])('refuses %j with %s', (text, code) => {
    expect(problemOf(text)).toMatchObject({ code, line: 1 })
  })

  it.each([
    [
      'movzx eax, ebx',
      'Line 1: `movzx` copies a smaller value into a bigger register. `ebx` (32 bits) is not smaller than `eax` (32 bits), so write `mov eax, ebx`.',
    ],
    [
      'movzx al, bl',
      'Line 1: `movzx` copies a smaller value into a bigger register. `bl` (8 bits) is not smaller than `al` (8 bits), so write `movzx eax, bl`.',
    ],
    [
      'movsx ax, word ptr [rbp-2]',
      'Line 1: `movsx` copies a smaller value into a bigger register. `word ptr [rbp-2]` (16 bits) is not smaller than `ax` (16 bits), so write `movsx eax, word ptr [rbp-2]`.',
    ],
    [
      'movsx eax, ebx',
      'Line 1: `movsx` copies a smaller value into a bigger register. `ebx` (32 bits) is not smaller than `eax` (32 bits), so write `movsx rax, ebx`.',
    ],
    [
      'movsx rax, rbx',
      'Line 1: `movsx` copies a smaller value into a bigger register. `rbx` (64 bits) is not smaller than `rax` (64 bits), so write `mov rax, rbx`.',
    ],
    [
      'movzx eax, [rax]',
      'Line 1: this line does not say how many bytes to read from `[rax]`. Add `byte ptr` (1 byte) or `word ptr` (2 bytes) in front, like `movzx eax, byte ptr [rax]`.',
    ],
    [
      'movzx rax, ebx',
      "Line 1: `movzx` can't take a 32-bit source. Writing a 32-bit register already clears the upper half, so use `mov eax, ebx`.",
    ],
    [
      'movzx r9, dword ptr [rbp-4]',
      "Line 1: `movzx` can't take a 32-bit source. Writing a 32-bit register already clears the upper half, so use `mov r9d, dword ptr [rbp-4]`.",
    ],
    [
      'movsx eax, 5',
      'Line 1: `movsx` needs a register, then a smaller register or memory, like `movsx eax, al`.',
    ],
    [
      'movzx 5, al',
      "Line 1: a number can't be the destination of `movzx`. Put a register first, like `movzx eax, al`.",
    ],
  ])('explains %j', (text, message) => {
    expect(problemOf(text).message).toBe(message)
  })
})

describe('lea', () => {
  it.each([
    ['lea rax, [rbp-8]', 64],
    ['lea eax, [rdi+rsi]', 32],
    ['lea ax, [rbx]', 16],
    ['lea rdi, message[rip]', 64],
    ['lea rax, message', 64],
    ['lea rax, qword ptr [rbp-8]', 64],
    ['lea rax, [rax+rax*4]', 64],
  ] as Legal[])('allows %j', (text, opSize) => {
    expect(sizeOf(text)).toBe(opSize)
  })

  it.each([
    'lea rax, rbx',
    'lea rax, 5',
    'lea al, [rbx]',
    'lea [rax], rbx',
    'lea 5, [rax]',
    'lea rax, count',
  ])('refuses %j with invalid-operands', (text) => {
    expect(problemOf(text)).toEqual({
      severity: 'error',
      code: 'invalid-operands',
      line: 1,
      message:
        'Line 1: `lea` needs a register of 16, 32 or 64 bits, then a memory operand, like `lea rax, [rbp-8]`.',
    })
  })
})

describe('push and pop', () => {
  it.each([
    ['push rax', 64],
    ['push r12', 64],
    ['push 5', 64],
    ['push -1', 64],
    ['push 2147483647', 64],
    ['push -2147483648', 64],
    ['push 0xffffffffffffffff', 64],
    ['push count', 64],
    ['push offset message', 64],
    ['pop rbp', 64],
    ['pop r15', 64],
  ] as Legal[])('allows %j', (text, opSize) => {
    expect(sizeOf(text)).toBe(opSize)
  })

  it.each([
    [
      'push eax',
      'Line 1: `push` needs a 64-bit register (like `rax`) or a number. `eax` is only 32 bits.',
    ],
    [
      // x86-64 can push a 16-bit register; only this emulator can't, so the message says so.
      'push ax',
      'Line 1: `push ax` is a real x86 instruction, but this emulator only uses 64-bit registers with `push`. Write `push rax`.',
    ],
    [
      'push al',
      'Line 1: `push` needs a 64-bit register (like `rax`) or a number. `al` is only 8 bits.',
    ],
    [
      'push [rbx]',
      "Line 1: this emulator can't push memory. Copy it into a register first: `mov rax, [rbx]`, then `push rax`.",
    ],
    [
      // The example never uses a register of the address itself.
      'push qword ptr [rax+rcx*8]',
      "Line 1: this emulator can't push memory. Copy it into a register first: `mov rdx, qword ptr [rax+rcx*8]`, then `push rdx`.",
    ],
    [
      'push 0x100000000',
      'Line 1: `push` can only take a number between -2147483648 and 2147483647, and `0x100000000` is not. Copy it into a register first: `mov rax, 0x100000000`, then `push rax`.',
    ],
    [
      'push 2147483648',
      'Line 1: `push` can only take a number between -2147483648 and 2147483647, and `2147483648` is not. Copy it into a register first: `mov rax, 2147483648`, then `push rax`.',
    ],
    ['pop eax', 'Line 1: `pop` needs a 64-bit register, like `rax`. `eax` is only 32 bits.'],
    [
      'pop r9w',
      'Line 1: `pop r9w` is a real x86 instruction, but this emulator only uses 64-bit registers with `pop`. Write `pop r9`.',
    ],
    [
      'pop 5',
      "Line 1: `pop` needs a 64-bit register, like `rax`. A number can't take the popped value.",
    ],
    [
      'pop [rax]',
      "Line 1: this emulator can't pop into memory. Pop into a register first: `pop rcx`, then `mov [rax], rcx`.",
    ],
    [
      'pop qword ptr [rsp]',
      "Line 1: this emulator can't pop into memory. Pop into a register first: `pop rax`, then `mov qword ptr [rsp], rax`.",
    ],
  ])('refuses %j', (text, message) => {
    expect(problemOf(text)).toEqual({
      severity: 'error',
      code: 'push-pop-operand',
      line: 1,
      message,
    })
  })
})

describe('jmp, the conditional jumps, call, ret, nop, leave', () => {
  it.each([
    'jmp done',
    'je done',
    'jnz done',
    'jg done',
    'call done',
    'call printf@PLT',
    'ret',
    'nop',
    'leave',
    'endbr64',
  ])('allows %j and gives it no width', (text) => {
    expect(sizeOf(text)).toBeNull()
  })

  it.each([
    ['jmp', 'register', RAX],
    ['je', 'number', FIVE],
    ['call', 'register', RAX],
  ] as [Mnemonic, string, Operand][])(
    'refuses %s with a %s as its operand',
    (mnemonic, _kind, operand) => {
      expect(validateInstruction(9, mnemonic, mnemonic, [operand])).toMatchObject({
        ok: false,
        diagnostic: { code: 'jump-target', line: 9 },
      })
    },
  )

  it('refuses a label where a register, memory or a number must be', () => {
    const label: Operand = {
      kind: 'target',
      name: 'done',
      address: 0x401140n,
      external: false,
      text: 'done',
    }
    expect(validateInstruction(1, 'mov', 'mov', [RAX, label])).toEqual({
      ok: false,
      diagnostic: {
        severity: 'error',
        code: 'invalid-operands',
        line: 1,
        message:
          "Line 1: `mov` can't use these operands. It is written as `mov destination, source`.",
      },
    })
    for (const mnemonic of ['inc', 'imul', 'movzx', 'lea', 'push', 'pop'] as const) {
      const operands =
        mnemonic === 'inc' || mnemonic === 'push' || mnemonic === 'pop' ? [label] : [label, label]
      expect(validateInstruction(1, mnemonic, mnemonic, operands).ok).toBe(false)
    }
  })

  it('refuses a jump (not a call) into the library', () => {
    const printf: Operand = {
      kind: 'target',
      name: 'printf',
      address: LIBRARY_FUNCTIONS.printf,
      external: true,
      text: 'printf',
    }
    expect(validateInstruction(1, 'call', 'call', [printf])).toEqual({ ok: true, opSize: null })
    expect(validateInstruction(1, 'jmp', 'jmp', [printf])).toMatchObject({
      ok: false,
      diagnostic: {
        code: 'jump-target',
        message:
          'Line 1: `printf` is a library function. Run it with `call printf@PLT`, not with `jmp`.',
      },
    })
  })
})

/* ─────────────────────────── number ranges ─────────────────────────── */

describe('number ranges', () => {
  it.each([
    [8, -128n, 255n],
    [16, -32768n, 65535n],
    [32, -2147483648n, 4294967295n],
    [64, -(2n ** 63n), 2n ** 64n - 1n],
  ] as [OperandSize, bigint, bigint][])('%i bits hold %s … %s', (size, low, high) => {
    expect(fitsBits(low, size)).toBe(true)
    expect(fitsBits(high, size)).toBe(true)
    expect(fitsBits(0n, size)).toBe(true)
    expect(fitsBits(low - 1n, size)).toBe(false)
    expect(fitsBits(high + 1n, size)).toBe(false)
  })

  it.each([
    [0n, true],
    [2147483647n, true],
    [2147483648n, false],
    [-2147483648n, true],
    [-2147483649n, false],
    [0xffff_ffffn, false],
    [0xffff_ffff_7fff_ffffn, false],
    [0xffff_ffff_8000_0000n, true],
    [0xffff_ffff_ffff_fff0n, true],
    [2n ** 64n, false],
  ])('fitsSignExtended32(%s) is %s', (value, expected) => {
    expect(fitsSignExtended32(value)).toBe(expected)
  })
})
