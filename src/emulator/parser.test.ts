import { describe, expect, it } from 'vitest'
import { lexLine } from './lexer'
import {
  canonicalMnemonic,
  editDistance,
  evaluateConstant,
  libraryFunction,
  looksLikeRegister,
  parseExpression,
  parseLine,
  resolveOperands,
  suggestMnemonics,
  suggestRegisters,
  tidyText,
  utf8Bytes,
  type LabelInfo,
  type Statement,
  type SymbolEnv,
} from './parser'
import { reg } from './registers'
import {
  LIBRARY_FUNCTIONS,
  MNEMONICS,
  type AssembleCode,
  type Diagnostic,
  type MemOperand,
  type Operand,
} from './types'

/* ───────────────────────────── helpers ───────────────────────────── */

/** The character code of one character. */
function charCode(ch: string): number {
  return ch.charCodeAt(0)
}

function makeEnv(constants: Record<string, bigint>, labels: Record<string, LabelInfo>): SymbolEnv {
  return {
    constant: (name) => (Object.hasOwn(constants, name) ? constants[name] : undefined),
    label: (name) => (Object.hasOwn(labels, name) ? labels[name] : undefined),
    names: () => [...Object.keys(constants), ...Object.keys(labels)],
  }
}

/** A small world of names for the operand tests. */
const ENV = makeEnv(
  { count: -8n, size: 8n, big: 1000n },
  {
    message: { kind: 'data', address: 0x402010n },
    array: { kind: 'data', address: 0x404030n },
    counter: { kind: 'data', address: 0x404048n },
    main: { kind: 'code', address: 0x401126n },
    done: { kind: 'code', address: 0x401140n },
  },
)

/** The statement on a line that must have no mistake. */
function statementOf(text: string): Statement {
  const parsed = parseLine(text, 1)
  expect(parsed.error, text).toBeNull()
  if (parsed.statement === null) throw new Error(`no statement in: ${text}`)
  return parsed.statement
}

/** The mistake on a line that must have one. */
function errorOf(text: string, line = 1): Diagnostic {
  const parsed = parseLine(text, line)
  if (parsed.error === null) throw new Error(`no error in: ${text}`)
  return parsed.error
}

/** Resolve the operands of one instruction line: the operands, or the mistake. */
function resolve(text: string, env: SymbolEnv = ENV): Operand[] | Diagnostic {
  const statement = statementOf(text)
  if (statement.kind !== 'instruction') throw new Error(`not an instruction: ${text}`)
  const resolved = resolveOperands(statement, env, 1)
  return resolved.ok ? resolved.operands : resolved.diagnostic
}

function operandsOf(text: string, env: SymbolEnv = ENV): Operand[] {
  const result = resolve(text, env)
  if (!Array.isArray(result)) throw new Error(`${text}: ${result.message}`)
  return result
}

function operandError(text: string, env: SymbolEnv = ENV): Diagnostic {
  const result = resolve(text, env)
  if (Array.isArray(result)) throw new Error(`no error in: ${text}`)
  return result
}

/** The memory operand that is the source of `mov rax, <text>`. */
function memoryOf(text: string): MemOperand {
  const operand = operandsOf(`mov rax, ${text}`)[1]
  if (operand.kind !== 'mem') throw new Error(`not memory: ${text}`)
  return operand
}

const NO_MEMORY = {
  kind: 'mem',
  size: null,
  base: null,
  index: null,
  scale: 1,
  disp: 0n,
  symbol: null,
  symbolAddress: 0n,
  equNames: [],
} as const

/* ───────────────────────────── parseLine ───────────────────────────── */

describe('parseLine: labels', () => {
  it('reads a label alone', () => {
    expect(parseLine('main:', 3)).toEqual({
      line: 3,
      labels: ['main'],
      statement: null,
      error: null,
      warning: null,
      brokenEqu: null,
    })
  })

  it('reads several labels and the statement after them', () => {
    const parsed = parseLine('a: b: .L3: ret # done', 1)
    expect(parsed.labels).toEqual(['a', 'b', '.L3'])
    expect(parsed.statement).toMatchObject({ kind: 'instruction', mnemonic: 'ret' })
  })

  it('keeps the letter case of labels', () => {
    expect(parseLine('Main: MAIN:', 1).labels).toEqual(['Main', 'MAIN'])
  })

  // The contract: a label may have the name of an instruction (`loop:`, `test:`, `add:`).
  // Only register names and the size words are refused, because they would be ambiguous
  // in an operand. `ptr`, `offset` and `flat` are keywords only where they act as one.
  it.each([
    ...['loop', 'exit', 'printf', 'int', 'flat', '_start', '$tmp'],
    ...['mov', 'RET', 'jz', 'endbr64', 'add', 'test', 'call', 'push', 'ptr', 'offset', 'eip'],
  ])('allows %s as a label', (name) => {
    expect(parseLine(`${name}:`, 1)).toMatchObject({ labels: [name], error: null })
  })

  it('reads `test: test eax, eax` as a label and an instruction', () => {
    const parsed = parseLine('test: test eax, eax', 1)
    expect(parsed).toMatchObject({ labels: ['test'], error: null })
    expect(parsed.statement).toMatchObject({ kind: 'instruction', mnemonic: 'test' })
  })

  it.each([
    ['rax:', 'register name'],
    ['EAX:', 'register name'],
    ['r8d:', 'register name'],
    ['rip:', 'register name'],
    ['byte:', 'size word, as in `byte ptr`'],
    ['DWORD:', 'size word, as in `dword ptr`'],
    ['qword:', 'size word, as in `qword ptr`'],
    ['1loop:', 'starts with a digit'],
    ['1:', 'starts with a digit'],
    [': ret', 'no label name'],
  ])('refuses the label in %j', (text, words) => {
    const error = errorOf(text)
    expect(error.code).toBe('bad-label')
    expect(error.message).toContain(words)
  })

  it('suggests a name for a label with a wrong character', () => {
    const error = errorOf('my-label: ret')
    expect(error.code).toBe('bad-label')
    expect(error.message).toBe(
      'Line 1: `my-label` is not a label name gcc accepts. Use only letters, digits and `_`, like `my_label`.',
    )
  })

  it('keeps the good labels and the statement of a line with a bad label', () => {
    const parsed = parseLine('ok: rax: ret', 1)
    expect(parsed.labels).toEqual(['ok'])
    expect(parsed.error?.code).toBe('bad-label')
    expect(parsed.statement).toMatchObject({ kind: 'instruction', mnemonic: 'ret' })
  })

  it('reads nothing on an empty line or a comment line', () => {
    for (const text of ['', '   ', '# comment', '\t# comment ; with marks']) {
      expect(parseLine(text, 1)).toMatchObject({ labels: [], statement: null, error: null })
    }
  })
})

describe('parseLine: directives', () => {
  it('accepts .intel_syntax noprefix in any letter case', () => {
    expect(statementOf('.intel_syntax noprefix')).toEqual({ kind: 'intel-syntax' })
    expect(statementOf('.INTEL_SYNTAX NoPrefix')).toEqual({ kind: 'intel-syntax' })
  })

  it.each(['.intel_syntax', '.intel_syntax prefix', '.intel_syntax noprefix, x'])(
    'refuses %j',
    (text) => {
      expect(errorOf(text).code).toBe('bad-directive')
    },
  )

  it.each([
    ['.text', 'text', '.text'],
    ['.data', 'data', '.data'],
    ['.rodata', 'rodata', '.rodata'],
    ['.bss', 'data', '.bss'],
    ['.TEXT', 'text', '.text'],
    ['.section .text', 'text', '.text'],
    ['.section .text.startup,"ax",@progbits', 'text', '.text.startup'],
    ['.section .rodata', 'rodata', '.rodata'],
    ['.section .rodata.str1.1,"aMS",@progbits,1', 'rodata', '.rodata.str1.1'],
    ['.section .data', 'data', '.data'],
    ['.section .data.rel.ro', 'data', '.data.rel.ro'],
    ['.section .bss', 'data', '.bss'],
    ['.section ".rodata"', 'rodata', '.rodata'],
    ['.section .note.GNU-stack,"",@progbits', 'note', '.note.GNU'],
  ])('reads the section of %j', (text, section, name) => {
    expect(statementOf(text)).toEqual({ kind: 'section', section, name, known: true })
  })

  it('treats an unknown section as read-only data and marks it unknown', () => {
    expect(statementOf('.section .weird')).toEqual({
      kind: 'section',
      section: 'rodata',
      name: '.weird',
      known: false,
    })
  })

  it('refuses .section with no name', () => {
    expect(errorOf('.section').code).toBe('bad-directive')
  })

  it.each([
    '.globl main',
    '.global main',
    '.GLOBL main',
    '.type main, @function',
    '.type main, %function',
    '.file "hello.c"',
    '.ident "GCC: (GNU) 13.2.0"',
    '.size main, .-main',
    '.align 8',
    '.p2align 4,,15',
    '.balign 16',
    '.cfi_startproc',
    '.cfi_def_cfa_offset 16',
    '.cfi_offset 6, -16',
    '.loc 1 5 0',
    '.weak foo',
    '.local bar',
    '.addrsig',
    '.addrsig_sym main',
  ])('ignores %j', (text) => {
    expect(statementOf(text)).toEqual({ kind: 'ignored' })
  })

  it.each([
    ['.comm buf, 64, 32', '.comm', 'buf: .zero 64'],
    ['.COMM counter,8,8', '.comm', 'counter: .zero 8'],
    ['.lcomm buffer, 16', '.lcomm', 'buffer: .zero 16'],
    ['.comm', '.comm', 'buf: .zero 16'],
  ])('reads %j as a variable this emulator does not support', (text, written, fix) => {
    expect(statementOf(text)).toEqual({ kind: 'common-symbol', written, fix })
  })

  it('refuses .globl with no name', () => {
    expect(errorOf('.globl').message).toBe('Line 1: `.globl` needs a name, like `.globl main`.')
  })

  it('reports an unknown directive as a statement, not as an error', () => {
    expect(statementOf('.Foo 1, 2')).toEqual({
      kind: 'unknown-directive',
      name: '.Foo',
      suggestions: [],
    })
  })

  it.each([
    ['.sting "Hello"', ['.string']],
    ['.STRNG "Hello"', ['.string']],
    ['.glob main', ['.globl']],
    ['.txt', ['.text']],
    ['.dat', ['.data']],
    ['.quda 1', ['.quad']],
    ['.asci "x"', ['.asciz', '.ascii']],
    ['.asciiz "x"', ['.asciz']],
    ['.qword 1', ['.quad']],
    ['.dword 1', ['.long']],
    ['.db 1', ['.byte']],
    ['.frobnicate', []],
    ['.sect .data', []],
    ['.end', []],
    ['.if 1', []],
    ['.double 1.5', []],
  ])('guesses what the unknown directive in %j was meant to be', (text, suggestions) => {
    expect(statementOf(text)).toMatchObject({ kind: 'unknown-directive', suggestions })
  })

  it.each([
    ['.string "Hi"', '.string', true, ['Hi'], [[72, 105]]],
    ['.asciz "Hi"', '.asciz', true, ['Hi'], [[72, 105]]],
    ['.ascii "Hi"', '.ascii', false, ['Hi'], [[72, 105]]],
    ['.STRING "Hi"', '.string', true, ['Hi'], [[72, 105]]],
    ['.string "a", "b"', '.string', true, ['a', 'b'], [[97], [98]]],
    ['.string ""', '.string', true, [''], [[]]],
    [
      '.string "tab\\there\\n"',
      '.string',
      true,
      ['tab\there\n'],
      [[...'tab\there\n'].map(charCode)],
    ],
    ['.string "caf\\303\\251"', '.string', true, ['café'], [[99, 97, 102, 0xc3, 0xa9]]],
  ])('reads %j', (text, directive, terminated, strings, bytes) => {
    expect(statementOf(text)).toEqual({ kind: 'strings', directive, terminated, strings, bytes })
  })

  it.each([
    ['.string', 'bad-directive'],
    ['.string hello', 'bad-directive'],
    ['.string 5', 'bad-directive'],
    ['.string "a" "b"', 'bad-directive'],
    ['.string "a",', 'bad-directive'],
    [".string 'hello'", 'bad-directive'],
    ['.string "abc', 'bad-string'],
    ['.string "a\\qb"', 'bad-string'],
    ['.string \u201chi\u201d', 'bad-string'],
    ['.ascii "ok", "bad', 'bad-string'],
  ] as [string, AssembleCode][])('refuses %j with %s', (text, code) => {
    expect(errorOf(text).code).toBe(code)
  })

  it.each([
    ['.quad 1', 8],
    ['.long 1', 4],
    ['.int 1', 4],
    ['.word 1', 2],
    ['.short 1', 2],
    ['.byte 1', 1],
  ])('reads %j with %i bytes per value', (text, elementSize) => {
    const statement = statementOf(text)
    expect(statement).toMatchObject({
      kind: 'values',
      directive: text.split(' ')[0],
      elementSize,
    })
  })

  it('reads several values and keeps their text', () => {
    const statement = statementOf(".byte 1, 0x10, 'A', count+1, -1")
    if (statement.kind !== 'values') throw new Error('not values')
    expect(statement.values.map((value) => value.text)).toEqual([
      '1',
      '0x10',
      "'A'",
      'count+1',
      '-1',
    ])
  })

  it.each([
    ['.quad', 'bad-directive'],
    ['.quad 1,', 'bad-directive'],
    ['.quad , 1', 'bad-directive'],
    ['.quad "text"', 'bad-directive'],
    ['.quad 5 +', 'bad-directive'],
    ['.quad 010', 'bad-number'],
    ['.long 1f - 0f', 'bad-number'],
    ['.byte $5', 'att-syntax'],
  ] as [string, AssembleCode][])('refuses %j with %s', (text, code) => {
    expect(errorOf(text).code).toBe(code)
  })

  it.each(['.zero 16', '.space 16', '.skip 16', '.zero count*2'])('reads %j', (text) => {
    expect(statementOf(text)).toMatchObject({ kind: 'fill', directive: text.split(' ')[0] })
  })

  it.each(['.zero', '.zero 1, 2', '.space'])('refuses %j', (text) => {
    expect(errorOf(text).code).toBe('bad-directive')
  })

  it.each([
    ['.equ count, 8', 'count'],
    ['.set count, 8', 'count'],
    ['count = 8', 'count'],
    ['count=8', 'count'],
    ['.EQU Count, -8', 'Count'],
    // Like labels, constants may have the name of an instruction or of `ptr`/`offset`.
    ['.equ mov, 5', 'mov'],
    ['add = 2', 'add'],
    ['.equ offset, 8', 'offset'],
    ['ptr = 16', 'ptr'],
  ])('reads the constant in %j', (text, name) => {
    expect(statementOf(text)).toMatchObject({ kind: 'equ', name })
  })

  it.each([
    ['.equ count', 'Line 1: `.equ` needs a name and a value, like `.equ count, 8`.'],
    ['.equ count,', 'Line 1: `.equ` needs a name and a value, like `.equ count, 8`.'],
    ['.set , 5', 'Line 1: `.set` needs a name and a value, like `.set count, 8`.'],
    ['.equ 5, 5', 'Line 1: `.equ` needs a name and a value, like `.equ count, 8`.'],
    ['.equ count 8', 'Line 1: `.equ` needs a name and a value, like `.equ count, 8`.'],
    ['count =', 'Line 1: `=` needs a name and a value, like `count = 8`.'],
    [
      '.equ rax, 5',
      "Line 1: `rax` is a register name, so it can't be the name of a constant. Choose a different name, like `count`.",
    ],
    [
      '.equ byte, 1',
      "Line 1: `byte` is a size word, as in `byte ptr`, so it can't be the name of a constant. Choose a different name, like `count`.",
    ],
    [
      'QWORD = 8',
      "Line 1: `QWORD` is a size word, as in `qword ptr`, so it can't be the name of a constant. Choose a different name, like `count`.",
    ],
    ['rax = 5', 'Line 1: `rax = 5` does not put a number in a register. Write `mov rax, 5`.'],
  ])('refuses %j', (text, message) => {
    const error = errorOf(text)
    expect(error.code).toBe('bad-directive')
    expect(error.message).toBe(message)
  })

  it('remembers the name of a constant whose value is broken', () => {
    expect(parseLine('.equ count, 08', 1)).toMatchObject({ statement: null, brokenEqu: 'count' })
    expect(parseLine('count = 5 +', 1)).toMatchObject({ statement: null, brokenEqu: 'count' })
    expect(parseLine('mov rax, 08', 1).brokenEqu).toBeNull()
  })
})

describe('parseLine: instructions', () => {
  it('reads the mnemonic and the raw operands', () => {
    const statement = statementOf('mov rax, [rbp-8]')
    if (statement.kind !== 'instruction') throw new Error('not an instruction')
    expect(statement.mnemonic).toBe('mov')
    expect(statement.written).toBe('mov')
    expect(statement.operands.map((operand) => operand.text)).toEqual(['rax', '[rbp-8]'])
  })

  it('tidies the text of the operands', () => {
    const statement = statementOf('MOV   EAX,DWORD  PTR [ RBP - 4 ]')
    if (statement.kind !== 'instruction') throw new Error('not an instruction')
    expect(statement.written).toBe('mov')
    expect(statement.operands.map((operand) => operand.text)).toEqual(['eax', 'dword ptr [rbp-4]'])
  })

  it.each(MNEMONICS.map((mnemonic) => [mnemonic]))('knows the instruction %s', (mnemonic) => {
    expect(canonicalMnemonic(mnemonic)).toBe(mnemonic)
    expect(canonicalMnemonic(mnemonic.toUpperCase())).toBe(mnemonic)
  })

  it.each([
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
  ])('folds %s to %s and keeps what was typed', (written, mnemonic) => {
    const operands = mnemonic === 'nop' ? '' : mnemonic === 'movsx' ? ' rax, ebx' : ' done'
    const statement = statementOf(`${written.toUpperCase()}${operands}`)
    expect(statement).toMatchObject({ kind: 'instruction', mnemonic, written })
  })

  it('takes no operands for ret', () => {
    expect(statementOf('ret')).toMatchObject({ operands: [] })
  })

  it('does not split at a comma inside brackets or quotes', () => {
    const statement = statementOf("mov al, ','")
    if (statement.kind !== 'instruction') throw new Error('not an instruction')
    expect(statement.operands.map((operand) => operand.text)).toEqual(['al', "','"])
    const bracket = statementOf('mov eax, [rbx, rcx]')
    if (bracket.kind !== 'instruction') throw new Error('not an instruction')
    expect(bracket.operands.map((operand) => operand.text)).toEqual(['eax', '[rbx,rcx]'])
  })

  it.each([
    ['mov [rbp-8, rax', ['[rbp-8', 'rax']],
    ['add [rax, 1', ['[rax', '1']],
    ['mov [rbp-8, [rax]', ['[rbp-8', '[rax]']],
  ])('splits %j at the comma when a bracket is never closed', (text, operands) => {
    // The student wrote two operands and forgot a `]`: the count is right.
    const statement = statementOf(text)
    if (statement.kind !== 'instruction') throw new Error('not an instruction')
    expect(statement.operands.map((operand) => operand.text)).toEqual(operands)
  })

  it.each([
    [
      'mov rax',
      'Line 1: `mov` needs 2 operands (the parts after `mov`): `mov destination, source`. This line has 1.',
    ],
    [
      'mov',
      'Line 1: `mov` needs 2 operands (the parts after `mov`): `mov destination, source`. This line has none.',
    ],
    [
      'mov a, b, c',
      'Line 1: `mov` needs 2 operands (the parts after `mov`): `mov destination, source`. This line has 3.',
    ],
    [
      'mov rax,',
      'Line 1: `mov` needs 2 operands (the parts after `mov`): `mov destination, source`. This line has 1.',
    ],
    [
      'mov rax rbx',
      'Line 1: `mov` needs 2 operands (the parts after `mov`): `mov destination, source`. Put a comma between the operands.',
    ],
    [
      'mov rax 5',
      'Line 1: `mov` needs 2 operands (the parts after `mov`): `mov destination, source`. Put a comma between the operands.',
    ],
    [
      'mov rax [rbp-8]',
      'Line 1: `mov` needs 2 operands (the parts after `mov`): `mov destination, source`. Put a comma between the operands.',
    ],
    [
      'cmp rax',
      'Line 1: `cmp` needs 2 operands (the parts after `cmp`): `cmp first, second`. This line has 1.',
    ],
    [
      'lea rax',
      'Line 1: `lea` needs 2 operands (the parts after `lea`): `lea register, [address]`. This line has 1.',
    ],
    [
      'push',
      'Line 1: `push` needs 1 operand (the part after `push`): `push source`. This line has none.',
    ],
    [
      'pop rax, rbx',
      'Line 1: `pop` needs 1 operand (the part after `pop`): `pop destination`. This line has 2.',
    ],
    [
      'inc',
      'Line 1: `inc` needs 1 operand (the part after `inc`): `inc destination`. This line has none.',
    ],
    [
      'jmp',
      'Line 1: `jmp` needs 1 operand (the part after `jmp`): `jmp label`. This line has none.',
    ],
    ['jz a, b', 'Line 1: `jz` needs 1 operand (the part after `jz`): `jz label`. This line has 2.'],
    [
      'call',
      'Line 1: `call` needs 1 operand (the part after `call`): `call label`. This line has none.',
    ],
    // x86-64 has `ret 16` and `nop dword ptr [rax]`, so the message says "in this emulator".
    ['ret 8', 'Line 1: `ret` takes no operands in this emulator. Write `ret` by itself.'],
    ['nop rax', 'Line 1: `nop` takes no operands in this emulator. Write `nop` by itself.'],
    ['leave 1', 'Line 1: `leave` takes no operands. Write `leave` by itself.'],
    ['endbr64 1', 'Line 1: `endbr64` takes no operands. Write `endbr64` by itself.'],
  ])('counts the operands of %j', (text, message) => {
    const error = errorOf(text)
    expect(error.code).toBe('operand-count')
    expect(error.message).toBe(message)
  })

  it('reports an extra comma', () => {
    expect(errorOf('mov rax,, rbx')).toMatchObject({ code: 'bad-operand', line: 1 })
  })

  it.each([
    ['mvo rax, 5', 'Line 2: `mvo` is not an instruction this emulator knows. Did you mean `mov`?'],
    ['pus rax', 'Line 2: `pus` is not an instruction this emulator knows. Did you mean `push`?'],
    [
      'ad rax, 1',
      'Line 2: `ad` is not an instruction this emulator knows. Did you mean `add` or `and`?',
    ],
    ['cal printf', 'Line 2: `cal` is not an instruction this emulator knows. Did you mean `call`?'],
    ['rte', 'Line 2: `rte` is not an instruction this emulator knows. Did you mean `ret`?'],
    [
      'frobnicate rax',
      'Line 2: `frobnicate` is not an instruction this emulator knows. Check the spelling.',
    ],
    [
      'start',
      'Line 2: `start` is not an instruction this emulator knows. If it is a label, put `:` after it, like `start:`.',
    ],
    [
      'rax, 5',
      'Line 2: `rax` is a register, not an instruction. Start the line with an instruction, like `mov rax, 5`.',
    ],
    [
      'globl main',
      'Line 2: `globl` is not an instruction. Did you mean `.globl`, with a dot in front?',
    ],
    [
      'section .data',
      'Line 2: `section` is NASM syntax. In gcc assembly, write `.text` or `.data`.',
    ],
    ['msg db "hi", 0', 'Line 2: `db` is NASM syntax. In gcc assembly, write `.byte` or `.string`.'],
    [
      'extern printf',
      'Line 2: `extern` is NASM syntax. gcc assembly does not need this line. Delete it.',
    ],
    ['count equ 5', 'Line 2: `equ` is NASM syntax. In gcc assembly, write `.equ count, 5`.'],
    ['count equ', 'Line 2: `equ` is NASM syntax. In gcc assembly, write `.equ name, value`.'],
    ['buf resb 8', 'Line 2: `resb` is NASM syntax. In gcc assembly, write `buf: .zero 8`.'],
    ['buf resb', 'Line 2: `resb` is NASM syntax. In gcc assembly, write `.zero`.'],
    ['resd 3', 'Line 2: `resd` is NASM syntax. In gcc assembly, write `.zero 12`.'],
    [
      '5 + 3',
      "Line 2: a line can't start with `5`. Start it with an instruction, like `mov rax, 5`.",
    ],
    [
      '[rax]',
      "Line 2: a line can't start with `[`. Start it with an instruction, like `mov rax, 5`.",
    ],
  ])('explains the unknown instruction in %j', (text, message) => {
    const error = errorOf(text, 2)
    expect(error.code).toBe('unknown-instruction')
    expect(error.message).toBe(message)
  })

  it.each([
    'mul',
    'div',
    'idiv',
    'neg',
    'not',
    'shl',
    'shr',
    'sal',
    'sar',
    'rol',
    'ror',
    'adc',
    'sbb',
    'xchg',
    'cdq',
    'cqo',
    'cdqe',
    'cwde',
    'movabs',
    'syscall',
    'int',
    'enter',
    'loop',
    'hlt',
    'cmove',
    'cmovne',
    'cmovg',
    'cmovl',
    'cmovge',
    'cmovle',
    'cmova',
    'cmovb',
    'sete',
    'setne',
    'setg',
    'setl',
    'setge',
    'setle',
    'seta',
    'setb',
    'movs',
    'stos',
    'lods',
    'scas',
    'cmps',
    'cld',
    'std',
    'bswap',
    'bt',
  ])('says %s is real but not supported', (name) => {
    const error = errorOf(`${name} rax`)
    expect(error.code).toBe('unsupported-instruction')
    expect(error.message).toContain(`\`${name}\` is a real instruction`)
  })

  it('lists what is supported', () => {
    expect(errorOf('shl rax, 1').message).toBe(
      `Line 1: \`shl\` is a real instruction, but this emulator does not support it. It supports \`mov\`, \`movzx\`, \`movsx\`, \`lea\`, \`push\`, \`pop\`, \`add\`, \`sub\`, \`inc\`, \`dec\`, \`imul\`, \`cmp\`, \`test\`, \`and\`, \`or\`, \`xor\`, \`jmp\`, the conditional jumps like \`je\` and \`jg\`, \`call\`, \`ret\`, \`nop\` and \`leave\`.`,
    )
  })

  it.each([
    [
      'mul rbx',
      'Line 1: `mul` is a real instruction, but this emulator does not support it. To multiply, use `imul`.',
    ],
    [
      'movabs rax, 5',
      'Line 1: `movabs` is a real instruction, but this emulator does not support it. Use `mov`: it can copy any 64-bit number into a register.',
    ],
    [
      'cdqe',
      'Line 1: `cdqe` is a real instruction, but this emulator does not support it. Use `movsxd rax, eax` instead.',
    ],
    [
      'syscall',
      'Line 1: `syscall` is a real instruction, but this emulator does not support it. To print, use `call printf@PLT`. To stop, use `ret`.',
    ],
  ])('adds a tip for %j', (text, message) => {
    expect(errorOf(text)).toMatchObject({ code: 'unsupported-instruction', message })
  })

  it.each(['shlq $1, %rax', 'negl %eax', 'idivq %rbx', 'sarq $2, %rax'])(
    'says %j uses the AT&T name of an instruction that is not supported',
    (text) => {
      const error = errorOf(text)
      const written = text.split(' ')[0]
      expect(error.code).toBe('unsupported-instruction')
      expect(error.message).toContain(
        `\`${written}\` is the AT&T name of \`${written.slice(0, -1)}\`.`,
      )
    },
  )

  it.each([
    'movq',
    'movl',
    'movw',
    'movb',
    'pushq',
    'popq',
    'addq',
    'addl',
    'subq',
    'subl',
    'cmpq',
    'cmpl',
    'leaq',
    'callq',
    'retq',
    'jmpq',
    'incq',
    'incl',
    'decq',
    'decl',
    'imulq',
    'imull',
    'xorq',
    'xorl',
    'andq',
    'andl',
    'orq',
    'orl',
    'testq',
    'testl',
  ])('says %s is AT&T syntax', (name) => {
    const error = errorOf(`${name} rax`)
    const intel = name.slice(0, -1)
    expect(error.code).toBe('att-syntax')
    expect(error.message).toBe(
      `Line 1: \`${name}\` is AT&T syntax. This emulator uses Intel syntax: write \`${intel}\`, not \`${name}\`.`,
    )
  })

  it.each([
    // A whole AT&T line: shown turned around, in Intel syntax.
    ['mov %rax, %rbx', '`mov rbx, rax`'],
    ['add $-8, %rsp', '`add rsp, -8`'],
    ['mov -8(%rbp), %rax', '`mov rax, [rbp-8]`'],
    // One AT&T piece in an Intel line, or a line that cannot be turned around: the piece.
    ['mov rax, $5', '`$5`'],
    ['frob %rax', '`%rax`'],
    ['%rax', '`%rax`'],
  ])('says %j is AT&T syntax', (text, shown) => {
    const error = errorOf(text)
    expect(error.code).toBe('att-syntax')
    expect(error.message).toContain(shown)
  })

  it.each([
    ['mov rax, 010', 'bad-number'],
    ['mov rax, 12abc', 'bad-number'],
    ["mov al, 'AB'", 'bad-number'],
    ["mov al, ''", 'bad-number'],
    ["mov al, 'A", 'bad-string'],
    ["mov al, '\\q'", 'bad-string'],
    ['mov rax, !', 'bad-operand'],
    ['mov rax, `5`', 'bad-operand'],
    ['mov rax, 6 / 2', 'bad-operand'],
    ['mov rax, \u00075', 'bad-operand'],
  ] as [string, AssembleCode][])('reports the bad piece in %j as %s', (text, code) => {
    expect(errorOf(text).code).toBe(code)
  })

  it('says which control character it cannot show', () => {
    expect(errorOf('mov rax, \u00075').message).toBe(
      "Line 1: this line has a character that can't be shown (U+0007). Delete the line and type it again.",
    )
  })

  // Pasted from a slide or typed on a phone: the message names the character and shows
  // the whole line as it should be.
  it.each([
    [
      '.string \u201cHello\u201d',
      'Line 1: `\u201c` looks like `"`, but gcc can\'t read it. Type `"` instead: `.string "Hello"`.',
      'bad-string',
    ],
    [
      'mov al, \u2018A\u2019',
      "Line 1: `\u2018` looks like `'`, but gcc can't read it. Type `'` instead: `mov al, 'A'`.",
      'bad-string',
    ],
    [
      'msg: .string "Hi\u201d  # greeting',
      'Line 1: `\u201d` looks like `"`, but gcc can\'t read it. Type `"` instead: `msg: .string "Hi"`.',
      'bad-string',
    ],
    [
      'mov rax, [rbp\u20138]',
      "Line 1: `\u2013` looks like `-`, but gcc can't read it. Type `-` instead: `mov rax, [rbp-8]`.",
      'bad-operand',
    ],
    [
      'mov eax\uff0c 5',
      "Line 1: `\uff0c` looks like `,`, but gcc can't read it. Type `,` instead: `mov eax, 5`.",
      'bad-operand',
    ],
    [
      'main\uff1a',
      "Line 1: `\uff1a` looks like `:`, but gcc can't read it. Type `:` instead: `main:`.",
      'bad-operand',
    ],
    [
      '\uff4d\uff4f\uff56 \uff45\uff41\uff58, \uff11',
      "Line 1: `\uff4d` looks like `m`, but gcc can't read it. Type `m` instead: `mov eax, 1`.",
      'bad-operand',
    ],
  ] as [string, string, AssembleCode][])(
    'tells exactly what to change in %j',
    (text, message, code) => {
      expect(errorOf(text)).toEqual({ severity: 'error', code, line: 1, message })
    },
  )

  it('reads a special space as a space and warns, without an error', () => {
    const parsed = parseLine('\u00a0\u00a0mov\u00a0eax, 5', 4)
    expect(parsed.error).toBeNull()
    expect(parsed.statement).toMatchObject({ kind: 'instruction', mnemonic: 'mov' })
    expect(parsed.warning).toEqual({
      severity: 'warning',
      code: 'bad-operand',
      line: 4,
      message:
        "Line 4: this line has a special space (U+00A0) that gcc can't read. Delete the spaces on this line and type them again.",
    })
  })

  it('reads past an invisible character and warns, without an error', () => {
    const parsed = parseLine('\ufeffloop_\u200bstart: dec ecx', 1)
    expect(parsed).toMatchObject({ labels: ['loop_start'], error: null })
    expect(parsed.warning?.message).toBe(
      "Line 1: this line has an invisible character (U+FEFF) that gcc can't read. Delete the line and type it again.",
    )
  })

  it('never puts a backquote from the program inside a message', () => {
    expect(errorOf('mov rax, `5`').message).toBe(
      "Line 1: this emulator can't read the backquote character here. An operand is a register, a number or memory, like `rax`, `5` or `[rbp-8]`.",
    )
    // Backquotes in a message always come in pairs, whatever the program holds.
    for (const text of [
      'fro`b rax',
      'mov `rax`, 5',
      '`',
      'mov rax, [`',
      '.string `x`',
      'a`b: ret',
    ]) {
      const marks = errorOf(text).message.match(/`/g) ?? []
      expect(marks.length % 2, text).toBe(0)
    }
  })

  it.each([
    ['mov rax, 5 ; five', ';'],
    ['mvo rax ; typo and comment', ';'],
    ['ret // back', '//'],
    ['/* note */', '/*'],
  ])('puts the wrong comment marker first in %j', (text, marker) => {
    const error = errorOf(text)
    expect(error.code).toBe('comment-style')
    // gcc does read `/* */` comments: only this emulator does not, and the message says so.
    expect(error.message).toBe(
      marker === '/*'
        ? 'Line 1: this emulator reads only `#` comments, not `/* */`. Change `/*` to `#`.'
        : `Line 1: in gcc assembly a comment starts with \`#\`, not \`${marker}\`. Change \`${marker}\` to \`#\`.`,
    )
  })

  it('still reads the statement in front of a wrong comment marker', () => {
    const parsed = parseLine('top: .data ; my data', 1)
    expect(parsed.labels).toEqual(['top'])
    expect(parsed.statement).toMatchObject({ kind: 'section', section: 'data' })
    expect(parsed.error?.code).toBe('comment-style')
  })
})

/* ───────────────────────────── expressions ───────────────────────────── */

describe('constant expressions', () => {
  const VALUES: Record<string, bigint> = { count: -8n, size: 8n }
  const value = (text: string): bigint => {
    const expr = parseExpression(lexLine(text).tokens, 1, () => {
      throw new Error(`cannot read ${text}`)
    })
    return evaluateConstant(expr, (name) => VALUES[name] ?? 0n)
  }

  it.each([
    ['42', 42n],
    ['-8', -8n],
    ['+8', 8n],
    ['- - 8', 8n],
    ['2+3*4', 14n],
    ['2*3+4', 10n],
    ['(2+3)*4', 20n],
    ['10-2-3', 5n],
    ['10-(2-3)', 11n],
    ['-(2+3)', -5n],
    ['2*-3', -6n],
    ['count', -8n],
    ['count+8', 0n],
    ['size*2+count', 8n],
    ['-count', 8n],
    ["'A'+1", 66n],
    ['0x10+0b11', 19n],
    ['((((1))))', 1n],
  ])('works out %j', (text, expected) => {
    expect(value(text)).toBe(expected)
  })

  it.each([
    '',
    '5 +',
    '* 5',
    '(5',
    '5)',
    '5 5',
    '5 , 6',
    '"text"',
    `${'('.repeat(40)}1${')'.repeat(40)}`,
  ])('refuses %j', (text) => {
    const problems: string[] = []
    expect(() =>
      parseExpression(lexLine(text).tokens, 1, (problem) => {
        problems.push(problem.reason)
        return { severity: 'error', code: 'bad-operand', line: 1, message: 'x' }
      }),
    ).toThrow()
    expect(problems).toHaveLength(1)
  })

  it('reads a very long sum without deep recursion', () => {
    expect(value(`${'1+'.repeat(20000)}1`)).toBe(20001n)
  })
})

/* ─────────────────────────────── operands ─────────────────────────────── */

describe('operands: registers and numbers', () => {
  it('reads a register in any letter case', () => {
    expect(operandsOf('mov RAX, Ebx')).toEqual([
      { kind: 'reg', reg: reg('rax'), text: 'rax' },
      { kind: 'reg', reg: reg('ebx'), text: 'ebx' },
    ])
  })

  it.each([
    ['5', 5n, null],
    ['-8', -8n, null],
    ['+8', 8n, null],
    ['0x1F', 31n, null],
    ['0b101', 5n, null],
    ["'A'", 65n, null],
    ['2+3*4', 14n, null],
    ['count', -8n, 'count'],
    ['count+8', 0n, null],
    ['-count', 8n, null],
    ['size*2', 16n, null],
    ['offset message', 0x402010n, 'message'],
    ['OFFSET FLAT:message', 0x402010n, 'message'],
    ['offset message+4', 0x402014n, 'message'],
    ['offset main', 0x401126n, 'main'],
    ['offset count', -8n, 'count'],
  ])('reads the number %j', (text, value, symbol) => {
    const [, source] = operandsOf(`mov rax, ${text}`)
    expect(source).toEqual({
      kind: 'imm',
      value,
      symbol,
      text: text.replace('OFFSET FLAT', 'offset flat'),
    })
  })
})

describe('operands: memory', () => {
  it('[rax]', () => {
    expect(memoryOf('[rax]')).toEqual({ ...NO_MEMORY, base: 'rax', text: '[rax]' })
  })

  it('[rbp-8]', () => {
    expect(memoryOf('[rbp-8]')).toEqual({ ...NO_MEMORY, base: 'rbp', disp: -8n, text: '[rbp-8]' })
  })

  it('-8[rbp]', () => {
    expect(memoryOf('-8[rbp]')).toEqual({ ...NO_MEMORY, base: 'rbp', disp: -8n, text: '-8[rbp]' })
  })

  it('8[rsp]', () => {
    expect(memoryOf('8[rsp]')).toEqual({ ...NO_MEMORY, base: 'rsp', disp: 8n, text: '8[rsp]' })
  })

  it('count[rbp] with an .equ name', () => {
    expect(memoryOf('count[rbp]')).toEqual({
      ...NO_MEMORY,
      base: 'rbp',
      disp: -8n,
      equNames: ['count'],
      text: 'count[rbp]',
    })
  })

  it('count+8[rbp]', () => {
    expect(memoryOf('count+8[rbp]')).toEqual({
      ...NO_MEMORY,
      base: 'rbp',
      disp: 0n,
      equNames: ['count'],
      text: 'count+8[rbp]',
    })
  })

  it('[rbp+count]', () => {
    expect(memoryOf('[rbp+count]')).toMatchObject({ base: 'rbp', disp: -8n, equNames: ['count'] })
  })

  it('message[rip]', () => {
    expect(memoryOf('message[rip]')).toEqual({
      ...NO_MEMORY,
      base: 'rip',
      symbol: 'message',
      symbolAddress: 0x402010n,
      text: 'message[rip]',
    })
  })

  it('array+8[rip]', () => {
    expect(memoryOf('array+8[rip]')).toEqual({
      ...NO_MEMORY,
      base: 'rip',
      disp: 8n,
      symbol: 'array',
      symbolAddress: 0x404030n,
      text: 'array+8[rip]',
    })
  })

  it('[rip+message]', () => {
    expect(memoryOf('[rip+message]')).toMatchObject({ base: 'rip', symbol: 'message', disp: 0n })
  })

  it('[rax+rbx*8+16]', () => {
    expect(memoryOf('[rax+rbx*8+16]')).toEqual({
      ...NO_MEMORY,
      base: 'rax',
      index: 'rbx',
      scale: 8,
      disp: 16n,
      text: '[rax+rbx*8+16]',
    })
  })

  it('array[rax*8]', () => {
    expect(memoryOf('array[rax*8]')).toEqual({
      ...NO_MEMORY,
      index: 'rax',
      scale: 8,
      symbol: 'array',
      symbolAddress: 0x404030n,
      text: 'array[rax*8]',
    })
  })

  it('a bare data label is memory at its address', () => {
    expect(memoryOf('counter')).toEqual({
      ...NO_MEMORY,
      symbol: 'counter',
      symbolAddress: 0x404048n,
      text: 'counter',
    })
  })

  it('a label plus a number is memory a little further on', () => {
    expect(memoryOf('counter+4')).toMatchObject({ symbol: 'counter', disp: 4n, base: null })
  })

  it.each([
    ['byte ptr [rax]', 8],
    ['word ptr [rax]', 16],
    ['dword ptr [rax]', 32],
    ['qword ptr [rax]', 64],
    ['BYTE PTR [RAX]', 8],
    ['Word Ptr [rax]', 16],
    ['DWORD PTR [rax]', 32],
    ['QWORD PTR [rax]', 64],
  ])('reads the size of %j', (text, size) => {
    expect(memoryOf(text)).toEqual({
      ...NO_MEMORY,
      size,
      base: 'rax',
      text: `${text.toLowerCase().slice(0, -5)}[rax]`,
    })
  })

  it.each([
    ['dword ptr -4[rbp]', { size: 32, base: 'rbp', disp: -4n }],
    ['qword ptr message[rip]', { size: 64, base: 'rip', symbol: 'message' }],
    ['dword ptr counter', { size: 32, base: null, symbol: 'counter' }],
    ['[rax+rbx]', { base: 'rax', index: 'rbx', scale: 1 }],
    ['[rax+rbx*1]', { base: 'rax', index: 'rbx', scale: 1 }],
    ['[rbx*2+rax]', { base: 'rax', index: 'rbx', scale: 2 }],
    ['[4*rbx+rax]', { base: 'rax', index: 'rbx', scale: 4 }],
    ['[rax+rax]', { base: 'rax', index: 'rax', scale: 1 }],
    ['[rbx*size]', { base: null, index: 'rbx', scale: 8, equNames: [] }],
    ['[rax*1]', { base: null, index: 'rax', scale: 1 }],
    ['[rbx*8]', { base: null, index: 'rbx', scale: 8, disp: 0n }],
    ['[0+rax*4]', { base: null, index: 'rax', scale: 4, disp: 0n }],
    ['[rax+rsp]', { base: 'rsp', index: 'rax', scale: 1 }],
    ['[rsp+rax]', { base: 'rsp', index: 'rax', scale: 1 }],
    ['[rsp*1]', { base: 'rsp', index: null }],
    ['[r12+r13*2-1]', { base: 'r12', index: 'r13', scale: 2, disp: -1n }],
    ['[rbp-8+rax*4]', { base: 'rbp', index: 'rax', scale: 4, disp: -8n }],
    ['[rbp-(4+4)]', { base: 'rbp', disp: -8n }],
    ['[rbp+count*2]', { base: 'rbp', disp: -16n, equNames: ['count'] }],
    ['[8]', { base: null, index: null, disp: 8n }],
    ['[count]', { base: null, disp: -8n, equNames: ['count'] }],
    ['[counter]', { base: null, symbol: 'counter', symbolAddress: 0x404048n }],
    ['[main]', { base: null, symbol: 'main', symbolAddress: 0x401126n }],
    ['array[rbx+rcx*8]', { base: 'rbx', index: 'rcx', scale: 8, symbol: 'array' }],
    ['[ rbp - 8 ]', { base: 'rbp', disp: -8n, text: '[rbp-8]' }],
    ['message [ rip ]', { base: 'rip', symbol: 'message', text: 'message[rip]' }],
    ['[RBP-8]', { base: 'rbp', disp: -8n, text: '[rbp-8]' }],
    ['Message[rip]', undefined],
  ] as [string, Partial<MemOperand> | undefined][])('reads %j', (text, expected) => {
    if (expected === undefined) {
      // Label names are case-sensitive: `Message` is not `message`.
      expect(operandError(`mov rax, ${text}`).code).toBe('undefined-symbol')
    } else {
      expect(memoryOf(text)).toMatchObject(expected)
    }
  })

  it.each([
    [
      '[ebp-8]',
      'address-register',
      'Line 1: `ebp` is 32 bits. This emulator builds addresses only from 64-bit registers, so write `rbp` here.',
    ],
    [
      '[ax]',
      'address-register',
      'Line 1: `ax` is 16 bits. This emulator builds addresses only from 64-bit registers, so write `rax` here.',
    ],
    ['[rax+bl]', 'address-register', undefined],
    [
      '[rax+rsp*2]',
      'address-register',
      "Line 1: `rsp` can't be the multiplied register in an address, as in `[rax+rsp*2]`. Multiply a different register, like `[rax+rbx*2]`.",
    ],
    [
      '[rsp+rsp]',
      'address-register',
      'Line 1: `rsp` can be used only once in an address, and `[rsp+rsp]` uses it twice. Use a different register for the second one, like `[rsp+rax]`.',
    ],
    ['[rax*2+rbx*4]', 'address-register', undefined],
    ['[rax+rbx+rcx]', 'address-register', undefined],
    ['[rax+rbx*3]', 'bad-memory-operand', undefined],
    ['[rax*16]', 'bad-memory-operand', undefined],
    ['[rax*0]', 'bad-memory-operand', undefined],
    ['[rbp-rax]', 'bad-memory-operand', undefined],
    ['[rbp-message]', 'bad-memory-operand', undefined],
    ['[message+array]', 'bad-memory-operand', undefined],
    ['message[array]', 'bad-memory-operand', undefined],
    ['[message*2]', 'bad-memory-operand', undefined],
    ['[rax*rbx]', 'bad-memory-operand', undefined],
    ['[rip]', 'bad-memory-operand', undefined],
    ['[rip+8]', 'bad-memory-operand', undefined],
    ['message[rip+rax]', 'bad-memory-operand', undefined],
    ['message[rip*2]', 'bad-memory-operand', undefined],
    [
      '[rbp-8',
      'bad-memory-operand',
      'Line 1: `[rbp-8` is missing its closing `]`. Write `[rbp-8]`.',
    ],
    ['rbp-8]', 'bad-memory-operand', undefined],
    ['[]', 'bad-memory-operand', undefined],
    ['[rax]rbx', 'bad-memory-operand', undefined],
    ['[rax]+8', 'bad-memory-operand', undefined],
    ['[[rax]]', 'bad-memory-operand', undefined],
    ['rax[rbx]', 'bad-memory-operand', undefined],
    [
      'dword [rbp-8]',
      'bad-memory-operand',
      'Line 1: `dword` needs the word `ptr` after it. Write `dword ptr [rbp-8]`.',
    ],
    ['dword ptr', 'bad-memory-operand', undefined],
    ['dword ptr eax', 'bad-memory-operand', undefined],
    ['dword ptr 5', 'bad-memory-operand', undefined],
    ['ptr [rax]', 'bad-memory-operand', undefined],
    ['[rax+0x100000000]', 'bad-memory-operand', undefined],
    ['[nosuch]', 'undefined-symbol', undefined],
    ['nosuch[rip]', 'undefined-symbol', undefined],
    ['[rbp+nosuch]', 'undefined-symbol', undefined],
    [
      '[rbz-8]',
      'unknown-register',
      'Line 1: `rbz` is not a register. Did you mean `rbx` or `rbp`?',
    ],
    ['[eip]', 'unknown-register', undefined],
    ['[rax+', 'bad-memory-operand', undefined],
    ['[rax+]', 'bad-operand', undefined],
  ] as [string, AssembleCode, string | undefined][])(
    'refuses %j with %s',
    (text, code, message) => {
      const error = operandError(`mov rax, ${text}`)
      expect(error.code).toBe(code)
      expect(error.line).toBe(1)
      if (message !== undefined) expect(error.message).toBe(message)
    },
  )
})

describe('operands: names that are not defined', () => {
  it.each([
    ['rex', 'Line 1: `rex` is not a register. Did you mean `rax`, `rbx`, `rcx` or `rdx`?'],
    ['eex', 'Line 1: `eex` is not a register. Did you mean `eax`, `ebx`, `ecx` or `edx`?'],
    [
      'r16',
      'Line 1: `r16` is not a register. Did you mean `r10`, `r11`, `r12`, `r13`, `r14` or `r15`?',
    ],
    ['r8l', 'Line 1: `r8l` is not a register. Did you mean `r8`, `r8d`, `r8w` or `r8b`?'],
    ['eaz', 'Line 1: `eaz` is not a register. Did you mean `eax`?'],
    [
      'rip',
      "Line 1: `rip` can't be an operand by itself. Use it only inside an address with a label, like `message[rip]`.",
    ],
    [
      'eip',
      'Line 1: `eip` is not a register you can use. For the address of a label, write `label[rip]`.',
    ],
    [
      'xmm0',
      'Line 1: `xmm0` is a real register, but this emulator only has the 16 general registers, `rax` to `r15`.',
    ],
    [
      'r1',
      'Line 1: `r1` is not a register. Did you mean `r8`, `r9`, `r10`, `r11`, `r12`, `r13`, `r14` or `r15`?',
    ],
    [
      'r1000',
      'Line 1: `r1000` is not a register. The 64-bit registers are `rax`, `rbx`, `rcx`, `rdx`, `rsi`, `rdi`, `rbp`, `rsp` and `r8` to `r15`.',
    ],
  ])('says %s is not a register', (name, message) => {
    const error = operandError(`mov rax, ${name}`)
    expect(error.code).toBe('unknown-register')
    expect(error.message).toBe(message)
  })

  it.each([
    [
      'nosuch',
      'Line 1: `nosuch` is not defined. Add a label `nosuch:` or a constant like `.equ nosuch, 8`.',
    ],
    ['x', 'Line 1: `x` is not defined. Add a label `x:` or a constant like `.equ x, 8`.'],
    ['val', 'Line 1: `val` is not defined. Add a label `val:` or a constant like `.equ val, 8`.'],
    ['max', 'Line 1: `max` is not defined. Add a label `max:` or a constant like `.equ max, 8`.'],
    ['end', 'Line 1: `end` is not defined. Add a label `end:` or a constant like `.equ end, 8`.'],
    ['Count', 'Line 1: `Count` is not defined. Did you mean `count`?'],
    ['mesage', 'Line 1: `mesage` is not defined. Did you mean `message`?'],
    [
      'printf',
      'Line 1: `printf` is a library function. You can only use it with `call`, like `call printf@PLT`.',
    ],
  ])('says %s is not defined', (name, message) => {
    const error = operandError(`mov rax, ${name}`)
    expect(error.code).toBe('undefined-symbol')
    expect(error.message).toBe(message)
  })

  it('treats an undefined $name as AT&T syntax', () => {
    expect(operandError('mov rax, $total').code).toBe('att-syntax')
  })

  it.each([
    ['mov rax, rbx+8', 'bad-operand'],
    ['mov rax, "text"', 'bad-operand'],
    ['mov rax, fs:40', 'bad-operand'],
    ['mov rax, 5 5', 'bad-operand'],
    ['mov rax, 5 +', 'bad-operand'],
    ['mov rax, (5', 'bad-operand'],
    ['mov rax, offset', 'bad-operand'],
    ['mov rax, offset [rax]', 'bad-operand'],
    ['mov rax, message*2', 'bad-operand'],
    ['mov rax, message-array', 'bad-memory-operand'],
  ] as [string, AssembleCode][])('refuses %j with %s', (text, code) => {
    expect(operandError(text).code).toBe(code)
  })
})

describe('operands: jump and call targets', () => {
  it('reads a label', () => {
    expect(operandsOf('jmp done')).toEqual([
      { kind: 'target', name: 'done', address: 0x401140n, external: false, text: 'done' },
    ])
  })

  it('reads a call to a label, with or without @PLT', () => {
    expect(operandsOf('call main')[0]).toMatchObject({ name: 'main', external: false })
    expect(operandsOf('call main@PLT')[0]).toEqual({
      kind: 'target',
      name: 'main',
      address: 0x401126n,
      external: false,
      text: 'main@PLT',
    })
  })

  it.each([
    ['call printf@PLT', 'printf', 'printf@PLT'],
    ['call printf', 'printf', 'printf'],
    ['call printf@plt', 'printf', 'printf@plt'],
    ['call scanf@PLT', 'scanf', 'scanf@PLT'],
    ['call __isoc99_scanf@PLT', 'scanf', '__isoc99_scanf@PLT'],
    ['call puts@PLT', 'puts', 'puts@PLT'],
    ['call putchar', 'putchar', 'putchar'],
    ['call exit@PLT', 'exit', 'exit@PLT'],
  ] as const)('reads the library call in %j', (text, name, operandText) => {
    expect(operandsOf(text)).toEqual([
      {
        kind: 'target',
        name,
        address: LIBRARY_FUNCTIONS[name],
        external: true,
        text: operandText,
      },
    ])
  })

  it('prefers a label of the program over a library function', () => {
    const env = makeEnv({}, { printf: { kind: 'code', address: 0x401200n } })
    expect(operandsOf('call printf@PLT', env)[0]).toMatchObject({
      name: 'printf',
      address: 0x401200n,
      external: false,
    })
    expect(operandsOf('jmp printf', env)[0]).toMatchObject({ external: false })
  })

  it.each([
    ['jmp rax', 'jump-target'],
    ['jmp [rax]', 'jump-target'],
    ['jmp qword ptr [rax]', 'jump-target'],
    ['jmp 5', 'jump-target'],
    ['jmp -5', 'jump-target'],
    ['jmp count', 'jump-target'],
    ['call rax', 'jump-target'],
    ['call [rax]', 'jump-target'],
    ['call 0x401126', 'jump-target'],
    ['jmp printf', 'jump-target'],
    ['je printf@PLT', 'jump-target'],
    ['jne exit', 'jump-target'],
    ['jmp message', 'jump-target'],
    ['call counter', 'jump-target'],
    ['jmp short done', 'jump-target'],
    ['jmp nowhere', 'undefined-symbol'],
    ['je nowhere', 'undefined-symbol'],
    ['call nowhere', 'undefined-symbol'],
    ['call nowhere@PLT', 'undefined-symbol'],
    ['call printf@GOT', 'bad-operand'],
  ] as [string, AssembleCode][])('refuses %j with %s', (text, code) => {
    expect(operandError(text)).toMatchObject({ code, line: 1, severity: 'error' })
  })

  it.each([
    [
      'jmp 5',
      'Line 1: `jmp` needs a label, not a number. Put a label in front of the line you want, then use that label, like `jmp done`.',
    ],
    [
      'call 5',
      'Line 1: `call` needs a label, not a number. Put a label in front of the line you want, then use that label, like `call helper`.',
    ],
    [
      'jz rax',
      "Line 1: `jz` needs a label, like `jz done`. This emulator can't jump to an address held in a register or in memory.",
    ],
    [
      'call [rax]',
      "Line 1: `call` needs a label, like `call printf@PLT`. This emulator can't jump to an address held in a register or in memory.",
    ],
    [
      'jmp printf',
      'Line 1: `printf` is a library function. Run it with `call printf@PLT`, not with `jmp`.',
    ],
    [
      'jmp message',
      'Line 1: `message` is a label for data, not for code. `jmp` needs a label that is in front of an instruction.',
    ],
    ['jmp short done', 'Line 1: `jmp` needs one label, like `jmp done`.'],
  ])('explains the wrong target in %j', (text, message) => {
    expect(operandError(text).message).toBe(message)
  })

  it('lists the library functions when a call has no target', () => {
    expect(operandError('call nowhere').message).toBe(
      'Line 1: there is no function named `nowhere`. Add a label `nowhere:`, or call a library function this emulator knows: `printf`, `scanf`, `puts`, `putchar` or `exit`.',
    )
  })

  it('suggests a close label for a jump', () => {
    expect(operandError('jmp Done').message).toBe(
      'Line 1: there is no label named `Done`. Did you mean `done`?',
    )
  })
})

/* ─────────────────────────────── helpers ─────────────────────────────── */

describe('helpers', () => {
  it.each([
    ['mov', 'mov', 0],
    ['mvo', 'mov', 1],
    ['mo', 'mov', 1],
    ['movv', 'mov', 1],
    ['mxv', 'mov', 1],
    ['mxx', 'mov', 2],
    ['', 'mov', 3],
    ['push', 'pop', 3],
    ['abcd', 'badc', 2],
  ])('editDistance(%j, %j) is %i', (a, b, distance) => {
    expect(editDistance(a, b)).toBe(distance)
    expect(editDistance(b, a)).toBe(distance)
  })

  it.each([
    ['mvo', ['mov']],
    ['psuh', ['push']],
    ['jmpp', ['jmp']],
    ['ad', ['add', 'and']],
    ['leaa', ['lea']],
    ['jm', ['jmp']],
    ['mo', ['mov']],
    ['pu', ['push']],
    ['leav', ['lea', 'leave']],
    ['xyzzyplugh', []],
    ['a-very-long-word-that-is-not-an-instruction', []],
  ])('suggestMnemonics(%j)', (written, expected) => {
    expect(suggestMnemonics(written)).toEqual(expected)
  })

  it('suggests the registers one edit away, and none when there are too many to list', () => {
    expect(suggestRegisters('rex')).toEqual(['rax', 'rbx', 'rcx', 'rdx'])
    expect(suggestRegisters('eaxx')).toEqual(['eax'])
    expect(suggestRegisters('r1')).toEqual(['r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'])
    expect(suggestRegisters('r1000')).toEqual([])
    expect(suggestRegisters('banana')).toEqual([])
    expect(suggestRegisters('r1d')).toEqual([]) // fourteen names are one edit away
  })

  it.each([
    ['rex', true],
    ['eex', true],
    ['r16', true],
    ['r8l', true],
    ['fx', true],
    ['raxx', true],
    ['end', false],
    ['err', false],
    ['max', false],
    ['val', false],
    ['idx', false],
    ['x', false],
    ['count', false],
  ])('looksLikeRegister(%j) is %s', (name, expected) => {
    expect(looksLikeRegister(name)).toBe(expected)
  })

  it.each([
    ['DWORD   PTR [ RBP - 4 ]', 'dword ptr [rbp-4]'],
    ['QWORD PTR Message[RIP]', 'qword ptr Message[rip]'],
    ['OFFSET FLAT:Msg', 'offset flat:Msg'],
    ['[rax + rbx*8 + 16]', '[rax+rbx*8+16]'],
    ['printf @ PLT', 'printf@PLT'],
    ['- 8 [rbp]', '-8[rbp]'],
    ['rax rbx', 'rax rbx'],
    ["'A'", "'A'"],
    ['0X1F', '0X1F'],
  ])('tidyText(%j) is %j', (text, tidy) => {
    expect(tidyText(lexLine(text).tokens)).toBe(tidy)
  })

  it.each([
    ['A', [0x41]],
    ['', []],
    ['é', [0xc3, 0xa9]],
    ['€', [0xe2, 0x82, 0xac]],
    ['😀', [0xf0, 0x9f, 0x98, 0x80]],
    ['a\0b', [0x61, 0, 0x62]],
    ['\ud800', [0xef, 0xbf, 0xbd]],
  ])('utf8Bytes(%j)', (text, bytes) => {
    expect(utf8Bytes(text)).toEqual(bytes)
  })

  it('knows the library functions and their other names', () => {
    expect(libraryFunction('printf')).toBe('printf')
    expect(libraryFunction('__isoc99_scanf')).toBe('scanf')
    expect(libraryFunction('toString')).toBeUndefined()
    expect(libraryFunction('Printf')).toBeUndefined()
  })
})
