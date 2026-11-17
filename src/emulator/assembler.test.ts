import { describe, expect, it } from 'vitest'
import { assemble } from './assembler'
import { internalProblem, missingIntelSyntax } from './errors'
import { reg } from './registers'
import {
  DEFAULT_OPTIONS,
  LIBRARY_FUNCTIONS,
  type AssembleCode,
  type DataItem,
  type Diagnostic,
  type EmulatorOptions,
  type Instruction,
  type Operand,
  type Program,
} from './types'

/* ───────────────────────────── helpers ───────────────────────────── */

/** Two lines that keep the whole-program warnings away: line 1 and line 2 of a program. */
const HEAD = '.intel_syntax noprefix\nmain:\n'

/** Assemble a program that must have no errors. */
function programOf(source: string, options?: EmulatorOptions): Program {
  const result = assemble(source, options)
  if (!result.ok) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'))
  }
  return result.program
}

/** The errors of a program that must have at least one. */
function errorsOf(source: string): Diagnostic[] {
  const result = assemble(source)
  expect(result.ok, source).toBe(false)
  expect(result.program).toBeNull()
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
  expect(errors.length).toBeGreaterThan(0)
  return errors
}

/** The instructions of `HEAD` + lines. */
function instructionsOf(...lines: string[]): Instruction[] {
  return programOf(HEAD + lines.join('\n')).instructions
}

/** The operands of one instruction written after `HEAD` and some definitions. */
function operandsOf(line: string, definitions = ''): Operand[] {
  return programOf(`${definitions}\n${HEAD}${line}\nret`).instructions[0].operands
}

function dataOf(source: string, options?: EmulatorOptions): DataItem[] {
  return programOf(`${source}\n.text\nmain: ret`, options).data
}

function bytesOf(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0))
}

/* ─────────────────────────── the result ─────────────────────────── */

describe('the result of assemble', () => {
  it('returns a program and no diagnostics for a clean program', () => {
    const result = assemble(`${HEAD}ret`)
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual([])
    expect(result.program?.instructions).toHaveLength(1)
  })

  it('keeps the source text in the program', () => {
    const source = `${HEAD}  ret   # the end\n`
    expect(programOf(source).source).toBe(source)
  })

  it('on success, diagnostics is the list of warnings of the program', () => {
    const result = assemble('.foo\nret')
    if (!result.ok) throw new Error('expected success')
    expect(result.diagnostics).toBe(result.program.warnings)
    expect(result.diagnostics.every((diagnostic) => diagnostic.severity === 'warning')).toBe(true)
    expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.line])).toEqual([
      ['missing-intel-syntax', 0],
      ['no-main', 0],
      ['unknown-directive', 1],
    ])
  })

  it('on failure, returns no program and at least one error', () => {
    const result = assemble(`${HEAD}mov [rax], [rbx]`)
    expect(result.ok).toBe(false)
    expect(result.program).toBeNull()
    expect(result.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'memory-to-memory',
        line: 3,
        message: "Line 3: you can't move memory into memory. Load it into a register first.",
      },
    ])
  })

  it('reports at most one error per line and goes on to the next lines', () => {
    const errors = errorsOf('mvo %rax, 010 ; x\nmov rex, [ebp\nret\nmov [rax], [rbx]')
    expect(errors.map((error) => error.line)).toEqual([1, 2, 4])
  })

  it('sorts the diagnostics by line, whatever pass found them', () => {
    const source = [
      'main:',
      '  jmp nowhere', // 2: found when names are resolved
      '  mvo rax, 1', // 3: found while reading the line
      '  mov al, 256', // 4: found by the operand rules
      '  .foo', // 5: a warning
      '  mov rax, 08', // 6: found by the lexer
      'main:', // 7: found while collecting labels
    ].join('\n')
    const result = assemble(source)
    expect(result.diagnostics.map((diagnostic) => [diagnostic.line, diagnostic.code])).toEqual([
      [2, 'undefined-symbol'],
      [3, 'unknown-instruction'],
      [4, 'immediate-too-large'],
      [5, 'unknown-directive'],
      [6, 'bad-number'],
      [7, 'duplicate-label'],
    ])
  })

  it('stops after 20 errors, then says that more errors follow', () => {
    const source = Array.from({ length: 30 }, () => 'mov [rax], [rbx]').join('\n')
    const result = assemble(source)
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    expect(errors.map((diagnostic) => diagnostic.line)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    )
    // One more line, about the whole program (so it is a warning, and comes first by line).
    expect(result.diagnostics).toHaveLength(21)
    expect(result.diagnostics[0]).toEqual({
      severity: 'warning',
      code: 'more-errors',
      line: 0,
      message: 'There are more errors after line 20. Fix these first.',
    })
  })

  it('says nothing more with exactly 20 errors', () => {
    const source = Array.from({ length: 20 }, () => 'mov [rax], [rbx]').join('\n')
    const result = assemble(source)
    expect(result.diagnostics).toHaveLength(20)
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'more-errors')).toBe(false)
  })

  it('names the line of the 20th error, not of the last line of the program', () => {
    // Bad lines 1, 3, 5, …, 45: the 20th of them is line 39.
    const lines = Array.from({ length: 45 }, (_, i) => (i % 2 === 0 ? 'mov [rax], [rbx]' : 'nop'))
    const result = assemble(lines.join('\n'))
    const note = result.diagnostics.find((diagnostic) => diagnostic.code === 'more-errors')
    expect(note?.message).toBe('There are more errors after line 39. Fix these first.')
  })

  it('keeps the warnings of single lines next to the errors, but not the whole-program ones', () => {
    const result = assemble('.foo\nmvo rax, 1')
    expect(result.diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.code])).toEqual([
      ['warning', 'unknown-directive'],
      ['error', 'unknown-instruction'],
    ])
  })

  it('starts every message about a line with "Line N: "', () => {
    const source = [
      '.foo',
      'mvo rax',
      'mov rax, 08',
      'mov [rax], [rbx]',
      'jmp nowhere',
      '.string "abc',
      'mov rax, 5 ; x',
    ].join('\n')
    const { diagnostics } = assemble(source)
    expect(diagnostics).toHaveLength(7)
    for (const diagnostic of diagnostics) {
      expect(diagnostic.message.startsWith(`Line ${diagnostic.line}: `)).toBe(true)
    }
  })

  it('does not start a message about the whole program with "Line"', () => {
    const messages = [...assemble('ret').diagnostics, ...assemble('').diagnostics].map(
      (diagnostic) => diagnostic.message,
    )
    expect(messages).toHaveLength(3)
    for (const message of messages) expect(message).not.toMatch(/^Line/)
  })

  it('ends every message with a full stop or a question mark', () => {
    const { diagnostics } = assemble(
      '.foo\nmvo rax\nmov rax, 08\nmov al, 256\njmp nowhere\npush eax',
    )
    for (const diagnostic of diagnostics) expect(diagnostic.message).toMatch(/[.?]$/)
  })
})

/* ─────────────────────────── every code ─────────────────────────── */

describe('every error code, on the right line', () => {
  const CASES = [
    ['unknown-instruction', 'main:\n  mvo rax, 5', 2],
    ['unsupported-instruction', 'main:\n  ret\n  shl rax, 1', 3],
    ['unknown-register', 'main:\n  mov rex, 5', 2],
    ['operand-count', 'main:\n  mov rax', 2],
    ['bad-operand', 'main:\n\n  mov rax, !', 3],
    ['bad-number', 'main:\n  mov rax, 010', 2],
    ['bad-memory-operand', 'main:\n  mov rax, [rbp-8', 2],
    ['bad-directive', '.equ count\nmain:\n  ret', 1],
    ['bad-string', 'msg: .string "Hello\nmain:\n  ret', 1],
    ['bad-label', 'main:\n  ret\nrax:\n  ret', 3],
    ['duplicate-label', 'main:\n  ret\nmain:\n  ret', 3],
    ['undefined-symbol', 'main:\n  mov rax, nosuch', 2],
    ['memory-to-memory', 'main:\n  mov [rax], [rbx]', 2],
    ['immediate-destination', 'main:\n  mov 5, rax', 2],
    ['size-mismatch', 'main:\n  mov eax, bx', 2],
    ['missing-size', 'main:\n  mov [rbp-8], 5', 2],
    ['immediate-too-large', 'main:\n  mov al, 256', 2],
    ['push-pop-operand', 'main:\n  push eax', 2],
    ['invalid-operands', 'main:\n  lea rax, rbx', 2],
    ['high-byte-rex', 'main:\n  mov ah, r8b', 2],
    ['jump-target', 'main:\n  jmp rax', 2],
    ['address-register', 'main:\n  mov eax, [ebp-8]', 2],
    ['comment-style', 'main:\n  ret ; back', 2],
    ['att-syntax', 'main:\n  mov %rax, %rbx', 2],
    ['wrong-section', '.data\n  mov rax, 1', 2],
    ['empty-program', '# nothing here', 0],
  ] as const satisfies readonly (readonly [AssembleCode, string, number])[]

  const WARNINGS = [
    ['unknown-directive', '.intel_syntax noprefix\nmain:\n  .frob 1\n  ret', 3],
    ['missing-intel-syntax', 'main:\n  ret', 0],
    ['no-main', '.intel_syntax noprefix\n  ret', 0],
  ] as const satisfies readonly (readonly [AssembleCode, string, number])[]

  /** Not a problem itself: the note after the first 20 errors of a program that fails. */
  const NOTES = [
    ['more-errors', Array.from({ length: 21 }, () => 'push eax').join('\n'), 0],
  ] as const satisfies readonly (readonly [AssembleCode, string, number])[]

  it('has a case for every code in AssembleCode', () => {
    type Covered =
      (typeof CASES)[number][0] | (typeof WARNINGS)[number][0] | (typeof NOTES)[number][0]
    // This line fails to compile when a code is added to AssembleCode without a case here.
    const complete: [Exclude<AssembleCode, Covered>] extends [never] ? true : false = true
    expect(complete).toBe(true)
    expect(new Set([...CASES, ...WARNINGS, ...NOTES].map(([code]) => code)).size).toBe(30)
  })

  it.each(NOTES)('%s (a note on a program that fails)', (code, source, line) => {
    const result = assemble(source)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.filter((item) => item.code === code)).toEqual([
      expect.objectContaining({ severity: 'warning', code, line }),
    ])
  })

  it.each(CASES)('%s', (code, source, line) => {
    const result = assemble(source)
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', code, line })
  })

  it.each(WARNINGS)('%s (a warning)', (code, source, line) => {
    const result = assemble(source)
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({ severity: 'warning', code, line })
  })

  it('says the fixed sentence for mov memory, memory', () => {
    expect(errorsOf('main:\n\n\n\n\n\n  mov [rbp-8], [rbp-16]')[0].message).toBe(
      "Line 7: you can't move memory into memory. Load it into a register first.",
    )
    expect(errorsOf('mov qword ptr [rax], qword ptr [rbx]')[0].message).toBe(
      "Line 1: you can't move memory into memory. Load it into a register first.",
    )
  })

  it.each([
    [
      'mov eax, bx',
      'Line 3: `eax` is 32 bits but `bx` is 16 bits. Both sides of `mov` must be the same size. To copy a smaller value into a bigger register, use `movzx` or `movsx`.',
    ],
    [
      'mov [rbp-8], 5',
      'Line 3: this line does not say how many bytes to write to `[rbp-8]`. Add `byte ptr` (1 byte), `word ptr` (2), `dword ptr` (4) or `qword ptr` (8) in front, like `mov dword ptr [rbp-8], 5`.',
    ],
    [
      'push eax',
      'Line 3: `push` needs a 64-bit register (like `rax`) or a number. `eax` is only 32 bits.',
    ],
    [
      'mov 5, rax',
      "Line 3: a number can't be the destination. Put the register or memory first: `mov rax, 5`.",
    ],
    ['mvo rax, 5', 'Line 3: `mvo` is not an instruction this emulator knows. Did you mean `mov`?'],
    [
      'mov %rax, %rbx',
      'Line 3: this line is AT&T syntax. This emulator uses Intel syntax, which puts the destination first: write `mov rbx, rax`.',
    ],
    [
      'mov rax, %rbx',
      'Line 3: this looks like AT&T syntax (`%rbx`). This emulator uses Intel syntax: write `rbx` with no `%`, like `mov rax, 5`.',
    ],
    [
      'movq rax, 5',
      'Line 3: `movq` is AT&T syntax. This emulator uses Intel syntax: write `mov`, not `movq`.',
    ],
    [
      'ret ; done',
      'Line 3: in gcc assembly a comment starts with `#`, not `;`. Change `;` to `#`.',
    ],
    [
      'mov rax, 010',
      'Line 3: `010` starts with a zero, so gcc reads it as an octal (base 8) number. Remove the zero: write `10`.',
    ],
  ])('says the right thing for %j', (line, message) => {
    expect(errorsOf(HEAD + line)[0].message).toBe(message)
  })

  it('says where code belongs when an instruction is inside .data', () => {
    expect(errorsOf('.data\nx: .quad 1\nmov rax, 1')[0]).toEqual({
      severity: 'error',
      code: 'wrong-section',
      line: 3,
      message: 'Line 3: this instruction is inside `.data`. Put code after `.text`.',
    })
    expect(errorsOf('.section .rodata\nret')[0].message).toContain('inside `.rodata`')
    expect(errorsOf('.bss\nret')[0].code).toBe('wrong-section')
  })

  it('reports empty-program only when nothing else is wrong', () => {
    expect(errorsOf('')).toEqual([
      {
        severity: 'error',
        code: 'empty-program',
        line: 0,
        message: 'This program has no instructions. Write at least one, like `mov rax, 5`.',
      },
    ])
    expect(errorsOf('.data\nx: .quad 1').map((error) => error.code)).toEqual(['empty-program'])
    expect(errorsOf('mvo rax').map((error) => error.code)).toEqual(['unknown-instruction'])
  })

  it('does not report a second error for a name whose own line is already wrong', () => {
    // The label on a bad line still counts, and so does the name of a broken constant.
    expect(errorsOf('main: mvo rax\n  jmp main\n  ret').map((e) => e.line)).toEqual([1])
    expect(errorsOf('.equ count, 08\nmain:\n  mov rax, count\n  ret').map((e) => e.line)).toEqual([
      1,
    ])
    expect(
      errorsOf('msg: .string "abc\nmain:\n  lea rdi, msg[rip]\n  ret').map((e) => e.line),
    ).toEqual([1])
  })
})

/* ───────────────────────────── lines ───────────────────────────── */

describe('lines', () => {
  it.each([
    ['\\n', 'main:\n  mov rax, 1\n  ret\n'],
    ['\\r\\n', 'main:\r\n  mov rax, 1\r\n  ret\r\n'],
    ['\\r', 'main:\r  mov rax, 1\r  ret'],
    ['tabs', 'main:\n\tmov\trax,\t1\n\tret'],
    ['no line ending at the end', 'main:\n  mov rax, 1\n  ret'],
  ])('reads lines that end with %s', (_name, source) => {
    const { instructions } = programOf(source)
    expect(instructions.map((instruction) => [instruction.line, instruction.text])).toEqual([
      [2, 'mov rax, 1'],
      [3, 'ret'],
    ])
  })

  it('ignores # comments and empty lines', () => {
    const program = programOf('# start\n\nmain:   # the entry\n  ret # back\n\n# end')
    expect(program.instructions.map((instruction) => instruction.line)).toEqual([4])
  })

  it('reads labels and a statement on one line', () => {
    const program = programOf('first: second: mov eax, 1\n  ret')
    expect(program.symbols.get('first')).toEqual({
      name: 'first',
      address: 0x401126n,
      kind: 'code',
      line: 1,
    })
    expect(program.symbols.get('second')?.address).toBe(0x401126n)
    expect(program.lineToIndex.get(1)).toBe(0)
  })

  it('reads mnemonics, registers, directives and keywords in any letter case', () => {
    const program = programOf(
      '.INTEL_SYNTAX NOPREFIX\n.TEXT\nmain:\n  MOV EAX, DWORD PTR [RBP-4]\n  Lea RDI, [Rip+main]\n  RET',
    )
    expect(program.instructions.map((instruction) => instruction.text)).toEqual([
      'mov eax, dword ptr [rbp-4]',
      'lea rdi, [rip+main]',
      'ret',
    ])
    expect(program.warnings).toEqual([])
  })

  it('treats label names as case-sensitive', () => {
    const program = programOf('main:\n  jmp Main\nMain:\n  ret')
    expect(program.symbols.get('main')?.address).not.toBe(program.symbols.get('Main')?.address)
    expect(errorsOf('main:\n  jmp MAIN')[0].code).toBe('undefined-symbol')
  })

  it.each(['mov rax, 5 ; five', '; five', 'ret // back', 'ret /* back */'])(
    'refuses the comment in %j',
    (line) => {
      expect(errorsOf(line)[0]).toMatchObject({ code: 'comment-style', line: 1 })
    },
  )

  it.each(['.string "a;b // c /* d"', "mov al, ';'", 'ret # one; two // three'])(
    'allows ; and // in text, characters and comments: %j',
    (line) => {
      expect(assemble(`${HEAD}${line}\nret`).ok).toBe(true)
    },
  )

  it('refuses a label that is a register or a size word', () => {
    expect(errorsOf('rsp:\n  ret')[0]).toMatchObject({ code: 'bad-label', line: 1 })
    expect(errorsOf('main:\n  ret\nqword:\n  ret')[0]).toMatchObject({ code: 'bad-label', line: 3 })
  })

  it('allows a label named like an instruction, and jumps and calls go to it', () => {
    const program = programOf(
      'add:\n  add eax, 1\n  ret\nmain:\n  call add\ntest: test eax, eax\n  jne test',
    )
    expect(program.symbols.get('add')).toMatchObject({ kind: 'code', address: 0x401126n })
    expect(program.instructions[2].operands[0]).toMatchObject({ name: 'add', external: false })
    expect(program.instructions[4].operands[0]).toMatchObject({
      name: 'test',
      address: program.symbols.get('test')?.address,
    })
    expect(program.warnings).toEqual([missingIntelSyntax()])
  })

  it('allows labels that are common English words, even names of unsupported instructions', () => {
    const program = programOf('main:\nloop:\n  dec ecx\n  jnz loop\nexit:\n  ret')
    expect(program.symbols.get('loop')?.kind).toBe('code')
    expect(program.symbols.get('exit')?.kind).toBe('code')
  })

  it('reports a label defined twice on the second line', () => {
    expect(errorsOf('again:\n  ret\nagain:\n  ret')).toEqual([
      {
        severity: 'error',
        code: 'duplicate-label',
        line: 3,
        message:
          'Line 3: the label `again` is already defined on line 1. Give this label a different name.',
      },
    ])
  })
})

/* ─────────────────────────── directives ─────────────────────────── */

describe('directives', () => {
  it('warns when .intel_syntax noprefix is missing, and not when it is there', () => {
    expect(assemble('main:\n ret').diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'missing-intel-syntax',
        line: 0,
        message:
          'The line `.intel_syntax noprefix` is missing. This emulator works without it, but gcc needs it: put it at the top of the program.',
      },
    ])
    expect(assemble('main:\n ret\n.intel_syntax noprefix').diagnostics).toEqual([])
  })

  it('refuses .intel_syntax without noprefix', () => {
    expect(errorsOf('.intel_syntax\nmain: ret')[0]).toMatchObject({
      code: 'bad-directive',
      line: 1,
    })
  })

  it('puts code in the code section by default, and after .text', () => {
    expect(programOf('main:\n ret').instructions).toHaveLength(1)
    expect(programOf('.data\nx: .quad 1\n.text\nmain:\n ret').instructions).toHaveLength(1)
  })

  it.each([
    ['.text', 'rodata'],
    ['.rodata', 'rodata'],
    ['.section .rodata', 'rodata'],
    ['.section .rodata.str1.1,"aMS",@progbits,1', 'rodata'],
    ['.data', 'data'],
    ['.bss', 'data'],
    ['.section .data', 'data'],
    ['.section .data.rel.ro', 'data'],
    ['.section .bss', 'data'],
  ] as const)('data written after %j goes to the %s area', (directive, section) => {
    const [item] = dataOf(`${directive}\nx: .quad 1`)
    expect(item.section).toBe(section)
    expect(item.address).toBe(section === 'data' ? 0x404030n : 0x402010n)
  })

  it('treats an unknown section as read-only data, with a warning on its line', () => {
    const result = assemble(`${HEAD}ret\n.section .weird\nx: .quad 1`)
    if (!result.ok) throw new Error('expected success')
    expect(result.program.data[0].section).toBe('rodata')
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'unknown-directive',
        line: 4,
        message:
          'Line 4: `.weird` is not a section this emulator knows, so it treats it as read-only data.',
      },
    ])
  })

  it('ignores a .note section and what gcc writes inside it', () => {
    const source = [
      HEAD + 'ret',
      '.section .note.GNU-stack,"",@progbits',
      '.section .note.gnu.property,"a"',
      '.align 8',
      '.long 1f - 0f',
      '.long 4f - 1f',
      '.long 5',
      '0:',
      '.string "GNU"',
      '1:',
      '.align 8',
      '.long 0xc0000002',
      '.long 3f - 2f',
      '2:',
      '.long 0x3',
      '3:',
      '.align 8',
      '4:',
    ].join('\n')
    const result = assemble(source)
    expect(result.diagnostics).toEqual([])
    expect(result.program?.data).toEqual([])
  })

  it('reads everything that is not gcc bookkeeping after a .note line as usual', () => {
    const result = assemble(
      [
        '.section .note.GNU-stack,"",@progbits',
        '.intel_syntax noprefix',
        '.equ five, 5',
        '.frob',
        'main:',
        '  mov eax, five',
        '  ret',
      ].join('\n'),
    )
    if (!result.ok) throw new Error('expected success')
    expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.line])).toEqual([
      ['unknown-directive', 4],
    ])
    expect(result.program.constants.get('five')).toBe(5n)
  })

  it('ends a .note section at the next section line', () => {
    const program = programOf(
      '.section .note.GNU-stack,"",@progbits\n.long 1\n.data\nx: .long 2\n.text\nmain: ret',
    )
    expect(program.data.map((item) => [item.label, item.bytes])).toEqual([['x', [2, 0, 0, 0]]])
  })

  it('keeps assembling code that follows a .note line', () => {
    const program = programOf('.section .note.GNU-stack,"",@progbits\nmain:\n  mov eax, 1\n  ret')
    expect(program.instructions.map((instruction) => instruction.text)).toEqual([
      'mov eax, 1',
      'ret',
    ])
    expect(program.entryLabel).toBe('main')
  })

  it.each([
    '.globl main',
    '.global main',
    '.type main, @function',
    '.type main, %function',
    '.file "hello.c"',
    '.ident "GCC: (Ubuntu 13.2.0) 13.2.0"',
    '.size main, .-main',
    '.align 16',
    '.p2align 4,,15',
    '.balign 8',
    '.cfi_startproc',
    '.cfi_def_cfa_offset 16',
    '.cfi_endproc',
    '.loc 1 3 12',
    '.weak helper',
    '.local buffer',
    '.addrsig',
    '.addrsig_sym main',
  ])('accepts %j with no effect and no message', (directive) => {
    const result = assemble(`${HEAD}${directive}\nret`)
    expect(result.diagnostics).toEqual([])
    expect(result.program?.instructions).toHaveLength(1)
    expect(result.program?.data).toEqual([])
    expect([...(result.program?.symbols.keys() ?? [])]).toEqual(['main'])
  })

  it('warns about any other directive on its line and goes on', () => {
    const result = assemble(`${HEAD}.frobnicate 1, 2\nret`)
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'unknown-directive',
        line: 3,
        message:
          'Line 3: `.frobnicate` is not a directive this emulator knows, so it skipped this line. A directive is a word that starts with a dot, like `.text`.',
      },
    ])
  })

  it('guesses the directive that a misspelled one was meant to be', () => {
    // A skipped `.string` changes what the program does, so the hint matters.
    const result = assemble(`${HEAD}ret\nmsg: .sting "Hello"`)
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'unknown-directive',
        line: 4,
        message:
          'Line 4: `.sting` is not a directive this emulator knows, so it skipped this line. A directive is a word that starts with a dot, like `.text`. Did you mean `.string`?',
      },
    ])
  })

  it('says more about two directives that students meet', () => {
    const messages = (source: string): string[] =>
      assemble(`${HEAD}ret\n${source}`).diagnostics.map((diagnostic) => diagnostic.message)
    expect(messages('.att_syntax')).toEqual([
      'Line 4: `.att_syntax` switches to AT&T syntax. This emulator uses Intel syntax, so it skipped this line.',
    ])
    expect(messages('.section data\nx: .quad 1')).toEqual([
      'Line 4: `data` is not a section this emulator knows, so it treats it as read-only data. Did you mean `.data`?',
    ])
  })

  it.each([
    ['.equ count', 1],
    ['.equ count,', 1],
    ['.string', 1],
    ['.string 5', 1],
    ['.quad', 1],
    ['.zero', 1],
    ['.zero -1', 1],
    ['.zero 1, 2', 1],
    ['.section', 1],
    ['.globl', 1],
    ['.intel_syntax prefix', 1],
    ['count =', 1],
  ])('refuses %j with bad-directive', (directive, line) => {
    expect(errorsOf(`${directive}\nmain: ret`)[0]).toMatchObject({ code: 'bad-directive', line })
  })
})

describe('data: text', () => {
  it('stores .string and .asciz as the bytes of the text and a 0', () => {
    for (const directive of ['.string', '.asciz']) {
      expect(dataOf(`msg: ${directive} "Hi!"`)).toEqual([
        {
          label: 'msg',
          line: 1,
          section: 'rodata',
          address: 0x402010n,
          directive,
          elementSize: 1,
          bytes: [0x48, 0x69, 0x21, 0],
          text: 'Hi!',
        },
      ])
    }
  })

  it('stores .ascii without the 0', () => {
    expect(dataOf('.ascii "Hi!"')[0]).toMatchObject({
      label: null,
      directive: '.ascii',
      bytes: [0x48, 0x69, 0x21],
      text: 'Hi!',
    })
  })

  it.each([
    ['a\\nb', [0x61, 10, 0x62]],
    ['a\\tb', [0x61, 9, 0x62]],
    ['a\\rb', [0x61, 13, 0x62]],
    ['a\\0b', [0x61, 0, 0x62]],
    ['a\\\\b', [0x61, 0x5c, 0x62]],
    ['a\\"b', [0x61, 0x22, 0x62]],
    ["a\\'b", [0x61, 0x27, 0x62]],
    ['100% # not a comment', bytesOf('100% # not a comment')],
    ['caf\u00e9', [0x63, 0x61, 0x66, 0xc3, 0xa9]],
    ['\u20ac', [0xe2, 0x82, 0xac]],
    ['\u{1f600}', [0xf0, 0x9f, 0x98, 0x80]],
    ['', []],
    // The escapes gcc writes (checked with clang): octal, hex, backspace, form feed.
    ['a\\012b', [0x61, 0x0a, 0x62]],
    ['\\033[0m', [0x1b, 0x5b, 0x30, 0x6d]],
    ['caf\\303\\251', [0x63, 0x61, 0x66, 0xc3, 0xa9]],
    ['a\\x41', [0x61, 0x41]],
    ['\\b\\f', [0x08, 0x0c]],
    ['\\08', [0x00, 0x38]],
  ])('decodes the text %j', (written, bytes) => {
    expect(dataOf(`.string "${written}"`)[0].bytes).toEqual([...bytes, 0])
    expect(dataOf(`.ascii "${written}"`)[0].bytes).toEqual(bytes)
  })

  it('shows the text an octal escape stands for', () => {
    // gcc writes `printf("¿Cuál?")` as octal escapes; the Data panel shows the letters.
    const [item] = dataOf('msg: .string "\\302\\277Cu\\303\\241l?"')
    expect(item.text).toBe('¿Cuál?')
    expect(item.bytes).toEqual([0xc2, 0xbf, 0x43, 0x75, 0xc3, 0xa1, 0x6c, 0x3f, 0])
  })

  it('gives each of several texts its own 0', () => {
    const [item] = dataOf('.string "a", "bc"')
    expect(item.bytes).toEqual([0x61, 0, 0x62, 0x63, 0])
    expect(item.text).toBe('a\0bc')
    expect(dataOf('.ascii "a", "bc"')[0].bytes).toEqual([0x61, 0x62, 0x63])
  })

  it.each([
    '.string "abc',
    '.string "a\\qb"',
    '.string "a\\x"',
    '.string "\\777"',
    '.ascii "tail\\',
  ])('refuses %j with bad-string', (directive) => {
    expect(errorsOf(`${directive}\nmain: ret`)[0]).toMatchObject({ code: 'bad-string', line: 1 })
  })

  it.each([
    [
      '.string "a\\qb"',
      'Line 1: `\\q` is not an escape gcc knows. The common ones are `\\n` (new line), `\\t` (tab), `\\"` (a quote) and `\\\\` (a backslash).',
    ],
    [
      '.string "\\777"',
      'Line 1: `\\777` is too big for one byte. An octal escape can be at most `\\377`.',
    ],
    ['.string "a\\x"', 'Line 1: `\\x` needs hex digits after it, like `\\x41`.'],
    [
      '.string "abc',
      'Line 1: the text has no closing `"`. Put a `"` at the end of the text, like `"Hello"`.',
    ],
  ])('explains the bad text in %j', (directive, message) => {
    expect(errorsOf(`${directive}\nmain: ret`)[0].message).toBe(message)
  })
})

describe('data: numbers', () => {
  it.each([
    ['.quad 0x1122334455667788', 8, [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]],
    ['.quad -1', 8, [255, 255, 255, 255, 255, 255, 255, 255]],
    ['.quad 1, 2', 8, [1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]],
    ['.long 0x11223344', 4, [0x44, 0x33, 0x22, 0x11]],
    ['.int 258', 4, [2, 1, 0, 0]],
    ['.long -2', 4, [254, 255, 255, 255]],
    ['.long 4294967295', 4, [255, 255, 255, 255]],
    ['.word 0x1234', 2, [0x34, 0x12]],
    ['.short 1, 2, 3', 2, [1, 0, 2, 0, 3, 0]],
    ['.word -1', 2, [255, 255]],
    ['.byte 1, 2, 255, -1, -128', 1, [1, 2, 255, 255, 128]],
    [".byte 'A', '\\n', 0b101, 0x10", 1, [65, 10, 5, 16]],
    ['.byte 2+3*4, (2+3)*4', 1, [14, 20]],
  ])('%j', (directive, elementSize, bytes) => {
    const [item] = dataOf(`x: ${directive}`)
    expect(item).toEqual({
      label: 'x',
      line: 1,
      section: 'rodata',
      address: 0x402010n,
      directive: directive.split(' ')[0],
      elementSize,
      bytes,
      text: null,
    })
  })

  it.each([
    ['.byte 256', 1],
    ['.byte -129', 1],
    ['.word 65536', 1],
    ['.short -32769', 1],
    ['.long 4294967296', 1],
    ['.int -2147483649', 1],
    ['.quad 18446744073709551616', 1],
    ['.byte 1, 2, 300', 1],
  ])('refuses %j because the number does not fit', (directive, line) => {
    expect(errorsOf(`${directive}\nmain: ret`)[0]).toMatchObject({
      code: 'immediate-too-large',
      line,
    })
  })

  it('explains which number does not fit', () => {
    expect(errorsOf('.byte 1, 300\nmain: ret')[0].message).toBe(
      'Line 1: `300` does not fit in `.byte`. Each `.byte` value holds 8 bits, so it must be between -128 and 255.',
    )
  })

  it.each([
    ['.quad nosuch', 'undefined-symbol'],
    ['.quad 010', 'bad-number'],
    ['.quad 1 2', 'bad-directive'],
    ['.quad rax', 'bad-directive'],
    ['.byte "a"', 'bad-directive'],
  ] as [string, AssembleCode][])('refuses %j with %s', (directive, code) => {
    expect(errorsOf(`${directive}\nmain: ret`)[0]).toMatchObject({ code, line: 1 })
  })

  it('uses .equ names in values, even ones defined later', () => {
    expect(dataOf('.byte width, width*2\n.equ width, 3')[0].bytes).toEqual([3, 6])
  })

  it('stores the address of a label as a value', () => {
    const program = programOf('msg: .string "hi"\ntable: .quad msg, main\n.text\nmain: ret')
    expect(program.data[1].bytes).toEqual([
      0x10, 0x20, 0x40, 0, 0, 0, 0, 0, 0x26, 0x11, 0x40, 0, 0, 0, 0, 0,
    ])
  })

  it.each(['.zero', '.space', '.skip'])('%s n makes n zero bytes', (directive) => {
    expect(dataOf(`buf: ${directive} 5`)[0]).toEqual({
      label: 'buf',
      line: 1,
      section: 'rodata',
      address: 0x402010n,
      directive,
      elementSize: 1,
      bytes: [0, 0, 0, 0, 0],
      text: null,
    })
  })

  it('works out the count of .zero, also from a constant defined later', () => {
    expect(dataOf('.zero 2*3')[0].bytes).toHaveLength(6)
    expect(dataOf('.zero 0')[0].bytes).toEqual([])
    expect(dataOf('.zero size\n.equ size, 4')[0].bytes).toEqual([0, 0, 0, 0])
  })

  it.each([
    ['.zero -4', 'bad-directive'],
    ['.zero 99999999999', 'bad-directive'],
    ['.zero 1048577', 'bad-directive'],
    ['.zero nosuch', 'undefined-symbol'],
    ['here:\n.zero here', 'bad-directive'],
    ['.zero rax', 'bad-directive'],
  ] as [string, AssembleCode][])('refuses %j with %s', (directive, code) => {
    expect(errorsOf(`${directive}\n.text\nmain: ret`)[0].code).toBe(code)
  })

  it('allows a big buffer, but not more zero bytes than a page should hold', () => {
    expect(dataOf('.data\nbuffer: .zero 1048576')[0].bytes).toHaveLength(1048576)
    // 20 lines: only the first one that goes over the limit is an error (said once).
    const many = Array.from({ length: 20 }, () => '.zero 1048576').join('\n')
    expect(errorsOf(`.data\n${many}\n.text\nmain: ret`)).toEqual([
      {
        severity: 'error',
        code: 'bad-directive',
        line: 18,
        message:
          'Line 18: this program asks for too many zero bytes. This emulator allows 16777216 in all. Use smaller numbers.',
      },
    ])
  })
})

describe('data: where it goes', () => {
  it('places read-only items one after another from rodataBase, with no padding', () => {
    const data = dataOf('a: .string "Hi"\nb: .byte 7\nc: .quad 1\nd: .word 2')
    expect(data.map((item) => [item.label, item.address, item.bytes.length])).toEqual([
      ['a', 0x402010n, 3],
      ['b', 0x402013n, 1],
      ['c', 0x402014n, 8],
      ['d', 0x40201cn, 2],
    ])
  })

  it('places writable items one after another from dataBase', () => {
    const data = dataOf('.data\na: .long 1\nb: .long 2\nc: .zero 3\nd: .byte 4')
    expect(data.map((item) => [item.section, item.address])).toEqual([
      ['data', 0x404030n],
      ['data', 0x404034n],
      ['data', 0x404038n],
      ['data', 0x40403bn],
    ])
  })

  it('keeps the two areas apart, in source order, when the sections take turns', () => {
    const program = programOf(
      [
        'r1: .string "one"', // text section → read-only
        '.data',
        'd1: .quad 1',
        '.section .rodata',
        'r2: .string "two"',
        '.text',
        'main: ret',
        'r3: .byte 9',
        '.data',
        'd2: .byte 2',
      ].join('\n'),
    )
    expect(program.data.map((item) => [item.label, item.section, item.address, item.line])).toEqual(
      [
        ['r1', 'rodata', 0x402010n, 1],
        ['d1', 'data', 0x404030n, 3],
        ['r2', 'rodata', 0x402014n, 5],
        ['r3', 'rodata', 0x402018n, 8],
        ['d2', 'data', 0x404038n, 10],
      ],
    )
    expect(program.layout).toEqual({
      textBase: 0x401126n,
      textEnd: 0x401127n,
      rodataBase: 0x402010n,
      rodataEnd: 0x402019n,
      dataBase: 0x404030n,
      dataEnd: 0x404039n,
    })
  })

  it('does not mix data into the code addresses', () => {
    const program = programOf('main:\n  mov eax, 1\nmsg: .string "in the middle"\n  ret')
    expect(program.instructions.map((instruction) => instruction.address)).toEqual([
      0x401126n,
      0x40112bn,
    ])
    expect(program.symbols.get('msg')).toMatchObject({ kind: 'data', address: 0x402010n })
  })

  it('uses the bases from the options', () => {
    const program = programOf('r: .byte 1\n.data\nd: .byte 2\n.text\nmain: ret', {
      textBase: 0x1000n,
      rodataBase: 0x2000n,
      dataBase: 0x3000n,
    })
    expect(program.layout).toEqual({
      textBase: 0x1000n,
      textEnd: 0x1001n,
      rodataBase: 0x2000n,
      rodataEnd: 0x2001n,
      dataBase: 0x3000n,
      dataEnd: 0x3001n,
    })
    expect(program.symbols.get('r')?.address).toBe(0x2000n)
    expect(program.symbols.get('d')?.address).toBe(0x3000n)
    expect(program.symbols.get('main')?.address).toBe(0x1000n)
  })

  it('has empty areas when there is no data', () => {
    expect(programOf('main: ret').layout).toMatchObject({
      rodataBase: DEFAULT_OPTIONS.rodataBase,
      rodataEnd: DEFAULT_OPTIONS.rodataBase,
      dataBase: DEFAULT_OPTIONS.dataBase,
      dataEnd: DEFAULT_OPTIONS.dataBase,
    })
  })
})

describe('labels and what they name', () => {
  it('lets several labels name one data item; the item keeps the first', () => {
    const program = programOf('one:\ntwo: three:\n  .quad 7\n.text\nmain: ret')
    expect(program.data[0].label).toBe('one')
    for (const name of ['one', 'two', 'three']) {
      expect(program.symbols.get(name)).toMatchObject({ kind: 'data', address: 0x402010n })
    }
    expect(program.symbols.get('two')?.line).toBe(2)
  })

  it('lets several labels name one instruction', () => {
    const program = programOf('main:\n.LFB0:\nstart: push rbp\n  ret')
    for (const name of ['main', '.LFB0', 'start']) {
      expect(program.symbols.get(name)).toMatchObject({ kind: 'code', address: 0x401126n })
    }
  })

  it('names the next thing in the same section, not in another one', () => {
    const program = programOf('code:\n.data\nvalue: .quad 1\n.text\n  ret')
    expect(program.symbols.get('code')).toMatchObject({ kind: 'code', address: 0x401126n })
    expect(program.symbols.get('value')).toMatchObject({ kind: 'data', address: 0x404030n })
  })

  it('skips lines that take no space on the way to the next thing', () => {
    const program = programOf(
      'msg:\n.equ n, 5\n.globl msg\n.align 8\n  .string "x"\n.text\nmain: ret',
    )
    expect(program.data[0].label).toBe('msg')
    expect(program.symbols.get('msg')?.address).toBe(0x402010n)
  })

  it('puts a label with nothing after it at the end of the code', () => {
    const program = programOf('main:\n  mov eax, 1\n  jmp end\n  ret\nend:')
    expect(program.symbols.get('end')).toEqual({
      name: 'end',
      address: program.layout.textEnd,
      kind: 'code',
      line: 5,
    })
    expect(program.instructions[1].operands[0]).toMatchObject({ address: 0x40112en })
  })

  it('puts a label with nothing after it in .data at the end of the data area', () => {
    const program = programOf('main: ret\n.data\nfirst: .quad 1\nlast:')
    expect(program.symbols.get('last')).toEqual({
      name: 'last',
      address: 0x404038n,
      kind: 'data',
      line: 4,
    })
    expect(program.layout.dataEnd).toBe(0x404038n)
  })

  it('puts a label with nothing after it in .rodata at the end of the read-only area', () => {
    const program = programOf('main: ret\n.section .rodata\nfirst: .byte 1\nlast:')
    expect(program.symbols.get('last')).toMatchObject({ kind: 'data', address: 0x402011n })
  })

  it('lists code labels, data labels and the library functions that are called', () => {
    const program = programOf(
      'msg: .string "hi"\nmain:\n  lea rdi, msg[rip]\n  call puts@PLT\n  call puts@PLT\n  ret',
    )
    expect([...program.symbols.values()]).toEqual([
      { name: 'msg', address: 0x402010n, kind: 'data', line: 1 },
      { name: 'main', address: 0x401126n, kind: 'code', line: 2 },
      { name: 'puts', address: LIBRARY_FUNCTIONS.puts, kind: 'external', line: null },
    ])
  })
})

describe('.equ constants', () => {
  it.each(['.equ count, -8', '.set count, -8', 'count = -8', '.EQU count, 0-8', 'count=-(4+4)'])(
    'defines a constant with %j',
    (definition) => {
      const program = programOf(`${definition}\nmain:\n  mov rax, count[rbp]\n  ret`)
      expect([...program.constants]).toEqual([['count', -8n]])
      expect(program.symbols.has('count')).toBe(false)
      expect(program.instructions[0].operands[1]).toMatchObject({ disp: -8n, equNames: ['count'] })
    },
  )

  it('lets a constant be used before the line that defines it', () => {
    const program = programOf('main:\n  mov eax, total\n  ret\n.equ total, part*2\n.equ part, 21')
    expect(program.instructions[0].operands[1]).toEqual({
      kind: 'imm',
      value: 42n,
      symbol: 'total',
      text: 'total',
    })
    expect([...program.constants]).toEqual([
      ['total', 42n],
      ['part', 21n],
    ])
  })

  it('works in any section and takes no space', () => {
    const program = programOf(
      '.data\n.equ a, 1\nx: .byte a\n.equ b, 2\ny: .byte b\n.text\nmain: ret',
    )
    expect(program.data.map((item) => [item.address, item.bytes])).toEqual([
      [0x404030n, [1]],
      [0x404031n, [2]],
    ])
  })

  it.each([
    ['.equ n, 1\n.equ n, 2\nmain: ret', 2],
    ['n = 1\n.set n, 2\nmain: ret', 2],
    ['n:\n  ret\n.equ n, 1', 3],
    ['.equ n, 1\nn:\n  ret', 2],
  ])('refuses a name that is defined twice: %j', (source, line) => {
    expect(errorsOf(source)).toMatchObject([{ code: 'duplicate-label', line }])
  })

  it.each([
    ['.equ a, nosuch\nmain: ret', 'undefined-symbol', 1],
    ['.equ a, a+1\nmain: ret', 'bad-directive', 1],
    ['.equ a, b\n.equ b, a\nmain: ret', 'bad-directive', 2],
    ['main: ret\n.equ a, main', 'bad-directive', 2],
    ['.equ a, rax\nmain: ret', 'bad-directive', 1],
    ['.equ a, 08\nmain: ret', 'bad-number', 1],
  ] as [string, AssembleCode, number][])('refuses %j with %s', (source, code, line) => {
    expect(errorsOf(source)).toMatchObject([{ code, line }])
  })

  it('says the right word for the way the constant was written', () => {
    expect(errorsOf('main: ret\nwhere = main')[0].message).toBe(
      'Line 2: `main` is a label, not a number. `=` needs a number here.',
    )
    expect(errorsOf('main: ret\n.set where, rax')[0].message).toBe(
      'Line 2: `rax` is a register, not a number. `.set` needs a number here.',
    )
  })

  it('follows a chain of constants in either order', () => {
    const up = Array.from({ length: 50 }, (_, i) => `.equ c${i}, c${i + 1}+1`).join('\n')
    const down = Array.from({ length: 50 }, (_, i) => `.equ d${50 - i}, d${49 - i}+1`).join('\n')
    const program = programOf(`${up}\n.equ c50, 0\n.equ d0, 0\n${down}\nmain: ret`)
    expect(program.constants.get('c0')).toBe(50n)
    expect(program.constants.get('d50')).toBe(50n)
  })

  it('gives up on a chain of constants that is too long to follow, without failing itself', () => {
    const chain = Array.from({ length: 3000 }, (_, i) => `.equ c${i}, c${i + 1}+1`).join('\n')
    const errors = errorsOf(`${chain}\n.equ c3000, 0\nmain: ret`)
    expect(errors.every((error) => error.code === 'bad-directive')).toBe(true)
    expect(errors[0].message).toContain('is defined through too many other constants')
  })

  it('reports a use of an unknown name', () => {
    expect(errorsOf('main:\n  mov rax, [rbp+nosuch]\n  ret')).toMatchObject([
      { code: 'undefined-symbol', line: 2 },
    ])
  })

  it('says that `.` (the current address) is not supported', () => {
    expect(errorsOf('msg: .string "hi"\nlen = . - msg\nmain: ret')).toEqual([
      {
        severity: 'error',
        code: 'undefined-symbol',
        line: 2,
        message:
          'Line 2: this emulator does not support `.` (the address of the current line). Write a number or a label instead.',
      },
    ])
  })
})

/* ──────────────────────── instructions and operands ──────────────────────── */

describe('instructions', () => {
  it('describes one instruction completely', () => {
    const [instruction] = instructionsOf('MOV   EAX,DWORD PTR [RBP-4]   # load x')
    expect(instruction).toEqual({
      index: 0,
      line: 3,
      address: 0x401126n,
      size: 3,
      mnemonic: 'mov',
      written: 'mov',
      opSize: 32,
      text: 'mov eax, dword ptr [rbp-4]',
      operands: [
        { kind: 'reg', reg: reg('eax'), text: 'eax' },
        {
          kind: 'mem',
          size: 32,
          base: 'rbp',
          index: null,
          scale: 1,
          disp: -4n,
          symbol: null,
          symbolAddress: 0n,
          equNames: [],
          text: 'dword ptr [rbp-4]',
        },
      ],
    })
  })

  it.each([
    ['jz done', 'je', 'jz'],
    ['jnz done', 'jne', 'jnz'],
    ['jnle done', 'jg', 'jnle'],
    ['jnl done', 'jge', 'jnl'],
    ['jnge done', 'jl', 'jnge'],
    ['jng done', 'jle', 'jng'],
    ['jnbe done', 'ja', 'jnbe'],
    ['jnb done', 'jae', 'jnb'],
    ['jnc done', 'jae', 'jnc'],
    ['jnae done', 'jb', 'jnae'],
    ['jc done', 'jb', 'jc'],
    ['jna done', 'jbe', 'jna'],
    ['MOVSXD rax, ebx', 'movsx', 'movsxd'],
    ['ENDBR64', 'nop', 'endbr64'],
    ['JE done', 'je', 'je'],
  ])('folds the spelling in %j', (line, mnemonic, written) => {
    const [instruction] = instructionsOf(line, 'done: ret')
    expect(instruction).toMatchObject({ mnemonic, written })
    expect(instruction.text.startsWith(written)).toBe(true)
  })

  it.each([
    ['ret', 'ret'],
    ['PUSH   RBP', 'push rbp'],
    ['mov\trax ,\t[ rbp - 8 ]', 'mov rax, [rbp-8]'],
    ['lea rdi, Message[RIP]', 'lea rdi, Message[rip]'],
    ['mov rax, OFFSET FLAT:Message', 'mov rax, offset flat:Message'],
    ['call printf@PLT', 'call printf@PLT'],
    ['add QWORD PTR -8[rbp], 0X1F', 'add qword ptr -8[rbp], 0X1F'],
    ["cmp al, 'a'", "cmp al, 'a'"],
  ])('tidies the text of %j', (line, text) => {
    const [instruction] = instructionsOf(line, 'ret', 'Message: .string "x"')
    expect(instruction.text).toBe(text)
  })

  it.each([
    ['mov rax, rbx', 64],
    ['mov eax, 1', 32],
    ['mov ax, 1', 16],
    ['mov al, 1', 8],
    ['mov [rbp-8], rax', 64],
    ['mov [rbp-8], eax', 32],
    ['mov byte ptr [rbp-1], 0', 8],
    ['add qword ptr [rbp-8], 1', 64],
    ['cmp eax, 5', 32],
    ['cmp byte ptr [rdi], 0', 8],
    ['test al, al', 8],
    ['test eax, [rbp-4]', 32],
    ['inc dword ptr [rbp-4]', 32],
    ['dec cx', 16],
    ['imul rax, rbx', 64],
    ['movzx eax, al', 32],
    ['movsx rax, eax', 64],
    ['lea eax, [rdi+rsi]', 32],
    ['push rbp', 64],
    ['push 5', 64],
    ['pop rbp', 64],
    ['jmp done', null],
    ['jne done', null],
    ['call done', null],
    ['call printf@PLT', null],
    ['ret', null],
    ['nop', null],
    ['leave', null],
    ['endbr64', null],
  ])('gives %j the width %s', (line, opSize) => {
    expect(instructionsOf(line, 'done: ret')[0].opSize).toBe(opSize)
  })

  it.each([
    ['[rax]', { base: 'rax', index: null, scale: 1, disp: 0n, symbol: null, size: null }],
    ['[rbp-8]', { base: 'rbp', disp: -8n }],
    ['-8[rbp]', { base: 'rbp', disp: -8n, text: '-8[rbp]' }],
    ['8[rsp]', { base: 'rsp', disp: 8n }],
    ['count[rbp]', { base: 'rbp', disp: -8n, equNames: ['count'], symbol: null }],
    ['count+8[rbp]', { base: 'rbp', disp: 0n, equNames: ['count'] }],
    ['message[rip]', { base: 'rip', symbol: 'message', symbolAddress: 0x402010n, disp: 0n }],
    ['array+8[rip]', { base: 'rip', symbol: 'array', symbolAddress: 0x404030n, disp: 8n }],
    ['[rax+rbx*8+16]', { base: 'rax', index: 'rbx', scale: 8, disp: 16n }],
    [
      'array[rax*8]',
      { base: null, index: 'rax', scale: 8, symbol: 'array', symbolAddress: 0x404030n },
    ],
    [
      'counter',
      { base: null, index: null, symbol: 'counter', symbolAddress: 0x404048n, text: 'counter' },
    ],
    ['byte ptr [rax]', { size: 8 }],
    ['word ptr [rax]', { size: 16 }],
    ['dword ptr [rax]', { size: 32 }],
    ['qword ptr [rax]', { size: 64 }],
    [
      'QWORD PTR [RAX+RBX*8]',
      { size: 64, base: 'rax', index: 'rbx', text: 'qword ptr [rax+rbx*8]' },
    ],
  ])('reads the memory operand %j', (operand, expected) => {
    const definitions = [
      '.equ count, -8',
      '.data',
      'array: .quad 1, 2, 3',
      'counter: .long 0',
      '.text',
      'message: .string "hi"',
    ].join('\n')
    expect(operandsOf(`lea rsi, ${operand}`, definitions)[1]).toMatchObject({
      kind: 'mem',
      ...expected,
    })
  })

  it('reads the address of a label with offset', () => {
    const definitions = 'message: .string "hi"'
    for (const written of ['offset message', 'OFFSET FLAT:message']) {
      expect(operandsOf(`mov rdi, ${written}`, definitions)[1]).toMatchObject({
        kind: 'imm',
        value: 0x402010n,
        symbol: 'message',
      })
    }
    expect(operandsOf('mov rdi, offset main')[1]).toMatchObject({
      value: 0x401126n,
      symbol: 'main',
    })
  })

  it('checks a number that is a code address once the address is known', () => {
    expect(errorsOf('main:\n  mov al, offset main\n  ret')).toMatchObject([
      { code: 'immediate-too-large', line: 2 },
    ])
    expect(programOf('main:\n  mov eax, offset main\n  ret').instructions[0].size).toBe(5)
  })
})

describe('numbers', () => {
  it.each([
    ['42', 42n],
    ['0', 0n],
    ['0x2A', 42n],
    ['0X2a', 42n],
    ['0b101', 5n],
    ['-8', -8n],
    ['+8', 8n],
    ['-0x10', -16n],
    ["'A'", 65n],
    ["'\\n'", 10n],
    ["'\\0'", 0n],
    ['18446744073709551615', 0xffff_ffff_ffff_ffffn],
    ['-9223372036854775808', -(2n ** 63n)],
    ['2+3*4', 14n],
    ['(2+3)*4', 20n],
    ['10-2-3', 5n],
  ])('reads %s', (written, value) => {
    expect(operandsOf(`mov rax, ${written}`)[1]).toEqual({
      kind: 'imm',
      value,
      symbol: null,
      text: written,
    })
  })

  it.each(['010', '08', '00', '12abc', '0xZZ', '1Fh', '0b102', '0x', '1.5'])(
    'refuses %s with bad-number',
    (written) => {
      expect(errorsOf(`${HEAD}mov rax, ${written}`)).toMatchObject([
        { code: 'bad-number', line: 3 },
      ])
    },
  )

  it('says how to write hex the gcc way', () => {
    expect(errorsOf(`${HEAD}mov rax, 1Fh`)[0].message).toBe(
      'Line 3: `1Fh` is the way other assemblers write hex. In gcc assembly, write `0x1F`.',
    )
  })
})

/* ───────────────────────────── layout ───────────────────────────── */

describe('addresses', () => {
  const SOURCE = [
    'main:',
    '  push rbp', // 1 byte
    '  mov rbp, rsp', // 3
    '',
    '  mov eax, 0', // 5
    '  pop rbp', // 1
    '  ret', // 1
  ].join('\n')

  it('puts the first instruction at textBase and each next one after the one before', () => {
    const { instructions, layout } = programOf(SOURCE)
    expect(instructions.map((instruction) => instruction.address)).toEqual([
      0x401126n,
      0x401127n,
      0x40112an,
      0x40112fn,
      0x401130n,
    ])
    for (let i = 1; i < instructions.length; i++) {
      const previous = instructions[i - 1]
      expect(instructions[i].address).toBe(previous.address + BigInt(previous.size))
    }
    expect(layout.textBase).toBe(DEFAULT_OPTIONS.textBase)
    expect(layout.textEnd).toBe(0x401131n)
  })

  it('uses a textBase from the options', () => {
    const { instructions, layout, entry } = programOf(SOURCE, { textBase: 0x1000n })
    expect(instructions.map((instruction) => instruction.address)).toEqual([
      0x1000n,
      0x1001n,
      0x1004n,
      0x1009n,
      0x100an,
    ])
    expect(layout).toMatchObject({ textBase: 0x1000n, textEnd: 0x100bn })
    expect(entry).toBe(0x1000n)
  })

  it('numbers the instructions and maps addresses and lines to them', () => {
    const program = programOf(SOURCE)
    expect(program.instructions.map((instruction) => instruction.index)).toEqual([0, 1, 2, 3, 4])
    expect([...program.addressToIndex]).toEqual([
      [0x401126n, 0],
      [0x401127n, 1],
      [0x40112an, 2],
      [0x40112fn, 3],
      [0x401130n, 4],
    ])
    expect([...program.lineToIndex]).toEqual([
      [2, 0],
      [3, 1],
      [5, 2],
      [6, 3],
      [7, 4],
    ])
    expect(program.addressToIndex.get(0x401128n)).toBeUndefined()
    expect(program.lineToIndex.get(1)).toBeUndefined()
    expect(program.lineToIndex.get(4)).toBeUndefined()
  })

  it('starts at main when there is a main label', () => {
    const program = programOf('helper:\n  ret\nmain:\n  call helper\n  ret')
    expect(program.entry).toBe(0x401127n)
    expect(program.entryLabel).toBe('main')
    expect(program.warnings.map((warning) => warning.code)).not.toContain('no-main')
  })

  it('starts at the first instruction when there is no main, and warns', () => {
    const result = assemble('.intel_syntax noprefix\nstart:\n  mov eax, 1\n  ret')
    if (!result.ok) throw new Error('expected success')
    expect(result.program.entry).toBe(0x401126n)
    expect(result.program.entryLabel).toBeNull()
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'no-main',
        line: 0,
        message:
          'There is no `main:` label, so the program starts at its first instruction. gcc needs a `main:` label and the line `.globl main`. Put `main:` in front of the first instruction.',
      },
    ])
  })

  it('does not count a main that names data', () => {
    const program = programOf('main: .quad 1\n  ret')
    expect(program.entryLabel).toBeNull()
    expect(program.warnings.map((warning) => warning.code)).toContain('no-main')
  })

  it('treats Main and MAIN as other labels', () => {
    expect(programOf('Main:\n  ret').entryLabel).toBeNull()
  })
})

describe('jumps', () => {
  it('fills in the address of the target', () => {
    const [jump, , , call] = instructionsOf('jmp over', 'nop', 'over: nop', 'call main', 'ret')
    expect(jump.operands).toEqual([
      { kind: 'target', name: 'over', address: 0x401129n, external: false, text: 'over' },
    ])
    expect(call.operands).toEqual([
      { kind: 'target', name: 'main', address: 0x401126n, external: false, text: 'main' },
    ])
  })

  it.each([
    ['jmp', 127, 2],
    ['jmp', 128, 5],
    ['je', 127, 2],
    ['je', 128, 6],
  ])('%s forward over %i bytes is %i bytes long', (jump, gap, size) => {
    const lines = [`${jump} done`, ...Array.from({ length: gap }, () => 'nop'), 'done: ret']
    expect(instructionsOf(...lines)[0].size).toBe(size)
  })

  it.each([
    ['jmp', 126, 2],
    ['jmp', 127, 5],
    ['jne', 126, 2],
    ['jne', 127, 6],
  ])('%s backward over %i bytes is %i bytes long', (jump, gap, size) => {
    const lines = [
      'top: nop',
      ...Array.from({ length: gap - 1 }, () => 'nop'),
      `${jump} top`,
      'ret',
    ]
    expect(instructionsOf(...lines)[gap].size).toBe(size)
  })

  it('grows a jump when another jump between it and its target grows', () => {
    const instructions = instructionsOf(
      'je end', // 125 bytes to `end` while the jmp is 2 bytes, 128 once it is 5
      ...Array.from({ length: 120 }, () => 'nop'),
      'jmp far',
      'nop',
      'nop',
      'nop',
      'end:',
      ...Array.from({ length: 130 }, () => 'nop'),
      'far: ret',
    )
    expect(instructions[0].size).toBe(6)
    expect(instructions[121].size).toBe(5)
    expect(instructions[0].operands[0]).toMatchObject({ address: 0x401126n + 6n + 120n + 5n + 3n })
  })

  it('keeps call at 5 bytes however far the function is', () => {
    const near = instructionsOf('call f', 'ret', 'f: ret')
    const far = instructionsOf(
      'call f',
      'ret',
      ...Array.from({ length: 500 }, () => 'nop'),
      'f: ret',
    )
    expect(near[0].size).toBe(5)
    expect(far[0].size).toBe(5)
  })

  it.each([
    ['jmp nowhere', 'undefined-symbol'],
    ['jne nowhere', 'undefined-symbol'],
    ['jmp rax', 'jump-target'],
    ['jmp [rax]', 'jump-target'],
    ['jmp 5', 'jump-target'],
    ['je 0x401126', 'jump-target'],
    ['jmp printf', 'jump-target'],
    ['jz puts@PLT', 'jump-target'],
    ['call rax', 'jump-target'],
    ['call [rax]', 'jump-target'],
    ['call qword ptr [rax]', 'jump-target'],
  ] as [string, AssembleCode][])('refuses %j with %s', (line, code) => {
    expect(errorsOf(HEAD + line)).toMatchObject([{ code, line: 3 }])
  })
})

describe('library calls', () => {
  it.each([
    ['call printf@PLT', 'printf', 'printf@PLT'],
    ['call printf', 'printf', 'printf'],
    ['call scanf@PLT', 'scanf', 'scanf@PLT'],
    ['call __isoc99_scanf@PLT', 'scanf', '__isoc99_scanf@PLT'],
    ['call puts@PLT', 'puts', 'puts@PLT'],
    ['call putchar@PLT', 'putchar', 'putchar@PLT'],
    ['call exit@PLT', 'exit', 'exit@PLT'],
  ] as const)('%s', (line, name, text) => {
    const program = programOf(`${HEAD}${line}\nret`)
    expect(program.instructions[0]).toMatchObject({
      mnemonic: 'call',
      size: 5,
      opSize: null,
      text: line,
      operands: [{ kind: 'target', name, address: LIBRARY_FUNCTIONS[name], external: true, text }],
    })
    expect(program.symbols.get(name)).toEqual({
      name,
      address: LIBRARY_FUNCTIONS[name],
      kind: 'external',
      line: null,
    })
  })

  it('does not list a library function that is not called', () => {
    expect([...programOf(`${HEAD}ret`).symbols.keys()]).toEqual(['main'])
  })

  it("calls the program's own function when it has the name of a library function", () => {
    const program = programOf('main:\n  call puts@PLT\n  ret\nputs:\n  ret')
    expect(program.instructions[0].operands[0]).toEqual({
      kind: 'target',
      name: 'puts',
      address: 0x40112cn,
      external: false,
      text: 'puts@PLT',
    })
    expect(program.symbols.get('puts')).toMatchObject({ kind: 'code', line: 4 })
  })

  it('refuses a call to a function that does not exist, and lists the ones that do', () => {
    expect(errorsOf(`${HEAD}call strlen@PLT`)).toEqual([
      {
        severity: 'error',
        code: 'undefined-symbol',
        line: 3,
        message:
          'Line 3: there is no function named `strlen`. Add a label `strlen:`, or call a library function this emulator knows: `printf`, `scanf`, `puts`, `putchar` or `exit`.',
      },
    ])
  })

  it('does not cut a long name short inside a fix the student can copy', () => {
    const name = 'aVeryLongLabelNameThatGoesOnAndOnForeverAndEver'
    const [error] = errorsOf(`${HEAD}mov rax, ${name}`)
    // The name is cut where the message only repeats it, but never in the suggested code.
    expect(error.message).toContain(
      `Add a label \`${name}:\` or a constant like \`.equ ${name}, 8\`.`,
    )
  })
})

/* ─────────────────────────── robustness ─────────────────────────── */

describe('robustness', () => {
  const INTERNAL = internalProblem().message

  it.each([
    ['an empty program', ''],
    ['only spaces', '   \n\t\n  '],
    ['only comments', '# one\n   # two\n#three'],
    ['only labels', 'a:\nb:\nc:'],
    ['only data', 'x: .quad 1'],
  ])('reports %s as empty', (_name, source) => {
    expect(assemble(source).diagnostics).toMatchObject([{ code: 'empty-program', line: 0 }])
  })

  it('reads a line of 5 000 characters', () => {
    const long = `mov rax, ${'1+'.repeat(2495)}1`
    expect(long.length).toBeGreaterThanOrEqual(5000)
    const program = programOf(`${HEAD}${long}\nret`)
    expect(program.instructions[0].operands[1]).toMatchObject({ kind: 'imm', value: 2496n })
  })

  it('reads a long text and a long comment', () => {
    const text = 'x'.repeat(5000)
    const program = programOf(`msg: .string "${text}"   # ${'y'.repeat(5000)}\nmain: ret`)
    expect(program.data[0].bytes).toHaveLength(5001)
  })

  it('reports a long line of nonsense without repeating all of it', () => {
    const [error] = errorsOf(`${'z'.repeat(5000)} rax`)
    expect(error.code).toBe('unknown-instruction')
    expect(error.message.length).toBeLessThan(200)
  })

  it.each([
    `mov rax, ${'('.repeat(3000)}1${')'.repeat(3000)}`,
    `mov rax, ${'-'.repeat(5000)}1`,
    `mov rax, [${'rax+'.repeat(1500)}rax]`,
    `${'a: '.repeat(1500)}ret`,
    `.byte ${'1,'.repeat(2500)}1`,
    `.string ${'"a",'.repeat(1200)}"a"`,
    '\u0000\u0001\u0002',
    '\ud800 \udfff',
    '`mov` rax, `5`',
  ])('does not fail on the odd line %#', (line) => {
    const result = assemble(`${line}\nret`)
    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(INTERNAL)
  })

  it('reads many lines', () => {
    const lines = ['main:', ...Array.from({ length: 4000 }, (_, i) => `  add rax, ${i}`), '  ret']
    const program = programOf(lines.join('\n'))
    expect(program.instructions).toHaveLength(4001)
    expect(program.lineToIndex.get(4002)).toBe(4000)
  })

  it('never throws on 300 random byte strings, and never blames itself', () => {
    let seed = 0x2545f491
    const next = (): number => {
      // xorshift32: the same strings on every run.
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      seed >>>= 0
      return seed
    }
    for (let round = 0; round < 300; round++) {
      const length = next() % 200
      let source = ''
      for (let i = 0; i < length; i++) source += String.fromCharCode(next() % 256)
      const result = assemble(source)
      expect(typeof result.ok).toBe('boolean')
      expect(result.diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(INTERNAL)
      if (!result.ok) {
        expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true)
      }
    }
  })

  it('never throws on 300 random lines made of real assembly pieces', () => {
    const pieces = [
      ...['mov', 'add', 'lea', 'push', 'jmp', 'call', 'ret', 'imul', 'movzx', '.quad', '.string'],
      ...['rax', 'eax', 'al', 'ah', 'r8b', 'rsp', 'rip', '[', ']', ',', '+', '-', '*', ':', '@'],
      ...[
        '5',
        '0x10',
        '010',
        "'A'",
        '"text"',
        'dword',
        'ptr',
        'offset',
        'main',
        'x',
        '=',
        '(',
        ')',
      ],
      ...[' ', ' ', ' ', '\n', '\n', '#', ';', '%', '$'],
    ]
    let seed = 99
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed
    }
    for (let round = 0; round < 300; round++) {
      const length = next() % 40
      let source = 'main:\n'
      for (let i = 0; i < length; i++) source += pieces[next() % pieces.length]
      const result = assemble(source)
      expect(result.diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(INTERNAL)
      // At most one error per line, sorted by line, and every message is a sentence.
      const lines = result.diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => diagnostic.line)
      expect(lines).toEqual([...new Set(lines)].sort((a, b) => a - b))
      for (const diagnostic of result.diagnostics) expect(diagnostic.message).toMatch(/[.?]$/)
    }
  })

  it('treats a source that is not text as an empty program', () => {
    for (const source of [null, undefined, 42, { split: 5 }]) {
      expect(assemble(source as unknown as string).diagnostics).toMatchObject([
        { code: 'empty-program' },
      ])
    }
  })

  it('turns a failure of its own into one diagnostic instead of throwing', () => {
    // Options that throw when they are read stand in for a bug inside the assembler.
    const hostile: EmulatorOptions = {
      get textBase(): bigint {
        throw new Error('boom')
      },
    }
    const result = assemble('main:\n  ret', hostile)
    expect(result).toEqual({
      ok: false,
      program: null,
      diagnostics: [
        {
          severity: 'error',
          code: 'bad-operand',
          line: 0,
          message:
            'The emulator hit an internal problem while reading this program. This is a mistake in the emulator, not in your program.',
        },
      ],
    })
    expect(result.diagnostics).toEqual([internalProblem()])
  })
})

/* ─────────────────────────── whole programs ─────────────────────────── */

describe('whole programs', () => {
  it('assembles Hello World with no diagnostics and the addresses gdb would show', () => {
    const source = [
      '    .intel_syntax noprefix', //  1
      '    .text', //  2
      'message:', //  3
      '    .string "Hello, World!\\n"', //  4
      '    .globl main', //  5
      '    .type main, @function', //  6
      'main:', //  7
      '    push rbp', //  8   401126  1
      '    mov rbp, rsp', //  9   401127  3
      '    lea rdi, message[rip]', // 10   40112a  7
      '    mov eax, 0', // 11   401131  5
      '    call printf@PLT', // 12   401136  5
      '    mov eax, 0', // 13   40113b  5
      '    pop rbp', // 14   401140  1
      '    ret', // 15   401141  1
    ].join('\n')
    const result = assemble(source)
    expect(result.diagnostics).toEqual([])
    if (!result.ok) throw new Error('expected success')
    const program = result.program

    expect(
      program.instructions.map((instruction) => [
        instruction.line,
        instruction.address,
        instruction.size,
        instruction.text,
      ]),
    ).toEqual([
      [8, 0x401126n, 1, 'push rbp'],
      [9, 0x401127n, 3, 'mov rbp, rsp'],
      [10, 0x40112an, 7, 'lea rdi, message[rip]'],
      [11, 0x401131n, 5, 'mov eax, 0'],
      [12, 0x401136n, 5, 'call printf@PLT'],
      [13, 0x40113bn, 5, 'mov eax, 0'],
      [14, 0x401140n, 1, 'pop rbp'],
      [15, 0x401141n, 1, 'ret'],
    ])
    expect(program.entry).toBe(0x401126n)
    expect(program.entryLabel).toBe('main')
    expect(program.layout).toEqual({
      textBase: 0x401126n,
      textEnd: 0x401142n,
      rodataBase: 0x402010n,
      rodataEnd: 0x40201fn,
      dataBase: 0x404030n,
      dataEnd: 0x404030n,
    })
    expect(program.data).toEqual([
      {
        label: 'message',
        line: 4,
        section: 'rodata',
        address: 0x402010n,
        directive: '.string',
        elementSize: 1,
        bytes: [...bytesOf('Hello, World!\n'), 0],
        text: 'Hello, World!\n',
      },
    ])
    expect([...program.symbols.values()]).toEqual([
      { name: 'message', address: 0x402010n, kind: 'data', line: 3 },
      { name: 'main', address: 0x401126n, kind: 'code', line: 7 },
      { name: 'printf', address: LIBRARY_FUNCTIONS.printf, kind: 'external', line: null },
    ])
    expect(program.instructions[2].operands[1]).toEqual({
      kind: 'mem',
      size: null,
      base: 'rip',
      index: null,
      scale: 1,
      disp: 0n,
      symbol: 'message',
      symbolAddress: 0x402010n,
      equNames: [],
      text: 'message[rip]',
    })
    expect(program.constants.size).toBe(0)
  })

  it('assembles what gcc -S -masm=intel writes for a small C program', () => {
    const source = [
      '\t.file\t"sum.c"',
      '\t.intel_syntax noprefix',
      '\t.text',
      '\t.section\t.rodata',
      '.LC0:',
      '\t.string\t"sum = %d\\n"',
      '\t.text',
      '\t.globl\tmain',
      '\t.type\tmain, @function',
      'main:',
      '.LFB0:',
      '\t.cfi_startproc',
      '\tendbr64',
      '\tpush\trbp',
      '\t.cfi_def_cfa_offset 16',
      '\t.cfi_offset 6, -16',
      '\tmov\trbp, rsp',
      '\t.cfi_def_cfa_register 6',
      '\tsub\trsp, 16',
      '\tmov\tDWORD PTR -8[rbp], 0',
      '\tmov\tDWORD PTR -4[rbp], 1',
      '\tjmp\t.L2',
      '.L3:',
      '\tmov\teax, DWORD PTR -4[rbp]',
      '\tadd\tDWORD PTR -8[rbp], eax',
      '\tadd\tDWORD PTR -4[rbp], 1',
      '.L2:',
      '\tcmp\tDWORD PTR -4[rbp], 10',
      '\tjle\t.L3',
      '\tmov\teax, DWORD PTR -8[rbp]',
      '\tmov\tesi, eax',
      '\tlea\trax, .LC0[rip]',
      '\tmov\trdi, rax',
      '\tmov\teax, 0',
      '\tcall\tprintf@PLT',
      '\tmov\teax, 0',
      '\tleave',
      '\t.cfi_def_cfa 7, 8',
      '\tret',
      '\t.cfi_endproc',
      '.LFE0:',
      '\t.size\tmain, .-main',
      '\t.ident\t"GCC: (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0"',
      '\t.section\t.note.GNU-stack,"",@progbits',
      '\t.section\t.note.gnu.property,"a"',
      '\t.align 8',
      '\t.long\t1f - 0f',
      '\t.long\t4f - 1f',
      '\t.long\t5',
      '0:',
      '\t.string\t"GNU"',
      '1:',
      '\t.align 8',
      '\t.long\t0xc0000002',
      '\t.long\t3f - 2f',
      '2:',
      '\t.long\t0x3',
      '3:',
      '\t.align 8',
      '4:',
    ].join('\n')
    const result = assemble(source)
    expect(result.diagnostics).toEqual([])
    if (!result.ok) throw new Error('expected success')
    const { instructions, symbols, data, layout } = result.program
    expect(instructions.map((instruction) => [instruction.address, instruction.size])).toEqual([
      [0x401126n, 4], // endbr64
      [0x40112an, 1], // push rbp
      [0x40112bn, 3], // mov rbp, rsp
      [0x40112en, 4], // sub rsp, 16
      [0x401132n, 7], // mov dword ptr -8[rbp], 0
      [0x401139n, 7], // mov dword ptr -4[rbp], 1
      [0x401140n, 2], // jmp .L2
      [0x401142n, 3], // mov eax, dword ptr -4[rbp]
      [0x401145n, 3], // add dword ptr -8[rbp], eax
      [0x401148n, 4], // add dword ptr -4[rbp], 1
      [0x40114cn, 4], // cmp dword ptr -4[rbp], 10
      [0x401150n, 2], // jle .L3
      [0x401152n, 3], // mov eax, dword ptr -8[rbp]
      [0x401155n, 2], // mov esi, eax
      [0x401157n, 7], // lea rax, .LC0[rip]
      [0x40115en, 3], // mov rdi, rax
      [0x401161n, 5], // mov eax, 0
      [0x401166n, 5], // call printf@PLT
      [0x40116bn, 5], // mov eax, 0
      [0x401170n, 1], // leave
      [0x401171n, 1], // ret
    ])
    expect(instructions[0]).toMatchObject({ mnemonic: 'nop', written: 'endbr64', text: 'endbr64' })
    expect(instructions[6].operands[0]).toMatchObject({ name: '.L2', address: 0x40114cn })
    expect(instructions[11].operands[0]).toMatchObject({ name: '.L3', address: 0x401142n })
    expect(symbols.get('.LFE0')).toMatchObject({ kind: 'code', address: layout.textEnd })
    expect(symbols.get('.LC0')).toMatchObject({ kind: 'data', address: 0x402010n })
    expect(data).toHaveLength(1)
    expect(data[0].text).toBe('sum = %d\n')
  })

  it('assembles a program with locals named by .equ, a loop and a data section', () => {
    const source = [
      '.intel_syntax noprefix',
      '.equ i, -4',
      '.equ total, -8',
      '.data',
      'limit: .long 10',
      'result: .long 0',
      '.text',
      '.globl main',
      'main:',
      '  push rbp',
      '  mov rbp, rsp',
      '  sub rsp, 16',
      '  mov dword ptr total[rbp], 0',
      '  mov dword ptr i[rbp], 1',
      'again:',
      '  mov eax, i[rbp]',
      '  cmp eax, limit[rip]',
      '  jg finish',
      '  add total[rbp], eax',
      '  inc dword ptr i[rbp]',
      '  jmp again',
      'finish:',
      '  mov eax, total[rbp]',
      '  mov result[rip], eax',
      '  leave',
      '  ret',
    ].join('\n')
    const result = assemble(source)
    expect(result.diagnostics).toEqual([])
    if (!result.ok) throw new Error('expected success')
    const program = result.program
    expect([...program.constants]).toEqual([
      ['i', -4n],
      ['total', -8n],
    ])
    expect(
      program.data.map((item) => [item.label, item.section, item.address, item.bytes]),
    ).toEqual([
      ['limit', 'data', 0x404030n, [10, 0, 0, 0]],
      ['result', 'data', 0x404034n, [0, 0, 0, 0]],
    ])
    const jg = program.instructions[7]
    const jmp = program.instructions[10]
    expect(jg).toMatchObject({ mnemonic: 'jg', size: 2 })
    expect(jg.operands[0]).toMatchObject({ name: 'finish', address: jmp.address + 2n })
    expect(jmp.operands[0]).toMatchObject({
      name: 'again',
      address: program.instructions[5].address,
    })
    expect(program.instructions[5].operands[1]).toMatchObject({
      base: 'rbp',
      disp: -4n,
      equNames: ['i'],
      text: 'i[rbp]',
    })
    expect(program.instructions[6].operands[1]).toMatchObject({
      base: 'rip',
      symbol: 'limit',
      symbolAddress: 0x404030n,
    })
  })
})

/* ──────────────────── decisions of the milestone-1 review ──────────────────── */

// Each test below pins one decision where the contract was silent, unclear, or changed
// by the lead. The report lists them, so the contract can be updated.

describe('decisions: labels and names', () => {
  it.each(['loop', 'test', 'add', 'mov', 'call', 'ret', 'nop', 'push', 'jz', 'endbr64'])(
    'a label may be named like the instruction %s, and a jump goes to it',
    (name) => {
      const program = programOf(`${HEAD}mov eax, 0\n${name}:\ninc eax\njmp ${name}`)
      expect(program.warnings).toEqual([])
      expect(program.symbols.get(name)).toMatchObject({ kind: 'code', address: 0x40112bn })
      expect(program.instructions[2].operands[0]).toMatchObject({ name, address: 0x40112bn })
    },
  )

  it.each(['byte', 'word', 'dword', 'qword', 'QWORD', 'rax', 'rip', 'R8D'])(
    'refuses %s as a label: a size word or a register would be ambiguous in an operand',
    (name) => {
      expect(errorsOf(`${HEAD}${name}:\nret`)[0]).toMatchObject({ code: 'bad-label', line: 3 })
    },
  )

  it('allows `ptr`, `offset` and `flat` as names, and reads them as keywords where they act as one', () => {
    const program = programOf(
      [
        '.intel_syntax noprefix',
        '.data',
        'ptr: .quad 5',
        'offset: .quad 7',
        'flat: .quad 9',
        '.text',
        'main:',
        '  mov rax, ptr',
        '  mov rbx, offset',
        '  lea rdi, ptr[rip]',
        '  mov rcx, offset offset',
        '  mov rdx, qword ptr ptr[rip]',
        '  mov rsi, OFFSET FLAT:flat',
        '  ret',
      ].join('\n'),
    )
    const [a, b, c, d, e, f] = program.instructions.map((instruction) => instruction.operands[1])
    expect(a).toMatchObject({ kind: 'mem', symbol: 'ptr', base: null })
    expect(b).toMatchObject({ kind: 'mem', symbol: 'offset', base: null })
    expect(c).toMatchObject({ kind: 'mem', symbol: 'ptr', base: 'rip' })
    expect(d).toMatchObject({ kind: 'imm', value: 0x404038n, symbol: 'offset' })
    expect(e).toMatchObject({ kind: 'mem', size: 64, symbol: 'ptr', base: 'rip' })
    expect(f).toMatchObject({ kind: 'imm', value: 0x404040n, symbol: 'flat' })
    expect(program.instructions[3].text).toBe('mov rcx, offset offset')
  })

  it('reads `ptr` and `offset` as keywords again when no label has that name', () => {
    expect(errorsOf(`${HEAD}mov rax, ptr`)[0].code).toBe('bad-memory-operand')
    expect(errorsOf(`${HEAD}mov rax, offset`)[0].code).toBe('bad-operand')
  })

  it('allows a constant named like an instruction, but not like a register or a size word', () => {
    const program = programOf(`.equ mov, 5\nadd = 2\n${HEAD}mov eax, mov\nadd eax, add\nret`)
    expect(program.instructions[0].operands[1]).toMatchObject({ kind: 'imm', value: 5n })
    expect(program.instructions[1].operands[1]).toMatchObject({ kind: 'imm', value: 2n })
    expect(errorsOf(`.equ rax, 5\n${HEAD}ret`)[0]).toMatchObject({ code: 'bad-directive', line: 1 })
    expect(errorsOf(`.equ dword, 4\n${HEAD}ret`)[0]).toMatchObject({
      code: 'bad-directive',
      line: 1,
    })
  })

  it('reports a name used for a constant and a label, and a constant made from itself', () => {
    expect(errorsOf(`.equ size, 8\n${HEAD}size:\nret`)[0]).toMatchObject({
      code: 'duplicate-label',
      line: 4,
    })
    expect(errorsOf(`.equ a, a+1\n${HEAD}ret`)[0]).toMatchObject({ code: 'bad-directive', line: 1 })
  })

  it('keeps a constant defined twice an error, although gas allows it (a teaching rule)', () => {
    expect(errorsOf(`.equ k, 1\n.set k, 2\n${HEAD}ret`)[0]).toMatchObject({
      code: 'duplicate-label',
      line: 2,
    })
  })
})

describe('decisions: instructions and operands', () => {
  it.each([
    ['calll', 'call'],
    ['pushl', 'push'],
    ['addw', 'add'],
    ['testb', 'test'],
    ['cmpb', 'cmp'],
    ['leal', 'lea'],
    ['retl', 'ret'],
    ['jmpl', 'jmp'],
    ['nopw', 'nop'],
    ['movzbl', 'movzx'],
    ['movslq', 'movsxd'],
  ])(
    'reads %s as AT&T syntax for %s: the contract list is a kind, not a full list',
    (att, intel) => {
      const error = errorsOf(`${HEAD}${att} rax`)[0]
      expect(error.code).toBe('att-syntax')
      expect(error.message).toContain(`write \`${intel}\`, not \`${att}\``)
    },
  )

  it('reports a missing `]` in the first operand, not a wrong operand count', () => {
    for (const line of ['mov [rbp-8, rax', 'mov [rbp-8, 5', 'add [rax, 1']) {
      expect(errorsOf(`${HEAD}${line}`), line).toEqual([
        expect.objectContaining({ code: 'bad-memory-operand', line: 3 }),
      ])
    }
    expect(errorsOf(`${HEAD}mov [rbp-8, rax`)[0].message).toBe(
      'Line 3: `[rbp-8` is missing its closing `]`. Write `[rbp-8]`.',
    )
  })

  it('accepts a 64-bit number written as the unsigned form of a sign-extended 32-bit one', () => {
    for (const line of [
      'and rsp, 0xfffffffffffffff0',
      'add rax, 0xffffffffffffffff',
      'mov qword ptr [rax], 0xffffffffffffffff',
      'push 0xffffffffffffffff',
      'cmp rax, 0xffffffff80000000',
    ]) {
      expect(assemble(`${HEAD}${line}\nret`).ok, line).toBe(true)
    }
    expect(instructionsOf('and rsp, 0xfffffffffffffff0')[0].size).toBe(4)
    expect(instructionsOf('mov rax, 0xffffffffffffffff')[0].size).toBe(7)
    expect(errorsOf(`${HEAD}add rax, 0x80000000`)[0].code).toBe('immediate-too-large')
    expect(errorsOf(`${HEAD}mov eax, 0xffffffffffffffff`)[0].code).toBe('immediate-too-large')
  })

  it('cuts a number to the operand size before choosing the short form, as clang does', () => {
    const sizes = instructionsOf(
      'add eax, 0xffffffff',
      'cmp ecx, 0xffffff80',
      'add bx, 0xffff',
      'imul eax, 0xffffffff',
    ).map((instruction) => instruction.size)
    expect(sizes).toEqual([3, 3, 4, 3])
  })

  it.each([
    ['inc [rax]', 'missing-size'],
    ['inc 5', 'immediate-destination'],
    ['imul al, bl', 'invalid-operands'],
    ['imul eax, rbx', 'size-mismatch'],
    ['imul [rax], rbx', 'invalid-operands'],
    ['imul 5, eax', 'immediate-destination'],
    ['movzx rax, ebx', 'invalid-operands'],
    ['movzx al, bl', 'size-mismatch'],
    ['movzx eax, 5', 'invalid-operands'],
    ['movzx rax, ah', 'high-byte-rex'],
    ['mov ah, [r8]', 'high-byte-rex'],
  ] as const)('gives %s the code %s (a shape the rule table does not name)', (line, code) => {
    expect(errorsOf(`${HEAD}${line}`)[0]).toMatchObject({ code, line: 3 })
  })

  it('reports an instruction in any section that is not code as `wrong-section`', () => {
    for (const section of ['.data', '.bss', '.rodata', '.section .rodata', '.section .weird']) {
      expect(errorsOf(`${section}\nret`)[0], section).toMatchObject({
        code: 'wrong-section',
        line: 2,
      })
    }
  })

  it('reads @PLT in any letter case and on a label of the program, but never jumps into the library', () => {
    const program = programOf(`${HEAD}call printf@plt\njmp main@PLT`)
    expect(program.instructions.map((instruction) => instruction.operands[0])).toMatchObject([
      { name: 'printf', external: true },
      { name: 'main', external: false, address: 0x401126n },
    ])
    expect(errorsOf(`${HEAD}jmp printf@PLT`)[0].code).toBe('jump-target')
    expect(errorsOf(`.data\nvalue: .quad 1\n.text\n${HEAD}jmp value`)[0].code).toBe('jump-target')
  })

  it('reads `;`, `/` and `#` inside a character as the character', () => {
    expect(operandsOf("cmp al, ';'")[1]).toMatchObject({ kind: 'imm', value: 59n })
    expect(operandsOf("cmp al, '/'")[1]).toMatchObject({ kind: 'imm', value: 47n })
    expect(operandsOf("cmp al, '#'")[1]).toMatchObject({ kind: 'imm', value: 35n })
  })

  it('fills the open fields of operands and data the same way every time', () => {
    expect(operandsOf('mov rax, [rbx]')[1]).toMatchObject({ index: null, scale: 1 })
    expect(operandsOf('mov rax, count+8', '.equ count, 8')[1]).toMatchObject({
      kind: 'imm',
      value: 16n,
      symbol: null,
    })
    expect(operandsOf('mov rax, offset main+8')[1]).toMatchObject({
      kind: 'imm',
      value: 0x40112en,
      symbol: 'main',
    })
    const scanf = programOf(`${HEAD}call __isoc99_scanf@PLT`)
    expect(scanf.instructions[0].operands[0]).toMatchObject({
      name: 'scanf',
      external: true,
      text: '__isoc99_scanf@PLT',
    })
    expect([...scanf.symbols.keys()]).toEqual(['main', 'scanf'])
    const data = dataOf('.string "a", "b"\n.data\nx: .byte 1\n.text\ny: .byte 2')
    expect(data.map((item) => [item.label, item.section, item.address, item.text])).toEqual([
      [null, 'rodata', 0x402010n, 'a\0b'],
      ['x', 'data', 0x404030n, null],
      ['y', 'rodata', 0x402014n, null],
    ])
  })

  it('reads a bare code label as memory, like a data label', () => {
    expect(operandsOf('mov rax, main')[1]).toMatchObject({
      kind: 'mem',
      base: null,
      symbol: 'main',
      symbolAddress: 0x401126n,
    })
  })

  it('refuses a displacement that needs more than 32 bits', () => {
    expect(errorsOf(`${HEAD}mov rax, [rbp+0x80000000]`)[0].code).toBe('bad-memory-operand')
  })

  it('suggests the nearest instruction within two edits, both on a tie, none further away', () => {
    expect(errorsOf(`${HEAD}mvo rax, 1`)[0].message).toContain('Did you mean `mov`?')
    expect(errorsOf(`${HEAD}ad rax, 1`)[0].message).toContain('Did you mean `add` or `and`?')
    expect(errorsOf(`${HEAD}endbr32`)[0].message).toContain('Did you mean `endbr64`?')
    expect(errorsOf(`${HEAD}frobnicate rax`)[0].message).not.toContain('Did you mean')
  })
})

describe('decisions: layout, data and odd input', () => {
  it('names the line of a `main:` that names data in the no-main warning', () => {
    const program = programOf('.intel_syntax noprefix\nmain: .string "x"\nstart:\n  ret')
    expect(program.entryLabel).toBeNull()
    expect(program.warnings).toEqual([
      {
        severity: 'warning',
        code: 'no-main',
        line: 0,
        message:
          'The label `main:` on line 2 names data, not an instruction, so the program starts at its first instruction. Put `main:` in front of an instruction.',
      },
    ])
  })

  it('starts at the end of the code when nothing follows `main:`, and warns on that line', () => {
    const program = programOf('.intel_syntax noprefix\nhelper:\n  ret\nmain:')
    expect(program).toMatchObject({ entryLabel: 'main', entry: 0x401127n })
    expect(program.warnings).toEqual([
      {
        severity: 'warning',
        code: 'no-main',
        line: 4,
        message:
          'Line 4: the label `main:` has no instruction after it, so the program has nothing to run. Put the instructions of the program after `main:`.',
      },
    ])
  })

  it('gives no such warning when the instructions of main come after a `.data` part', () => {
    const program = programOf(
      '.intel_syntax noprefix\nmain:\n.data\nx: .quad 1\n.text\n  mov eax, 1\n  ret',
    )
    expect(program.warnings).toEqual([])
    expect(program.entry).toBe(program.instructions[0].address)
  })

  it('reads a label difference and a label address as data values', () => {
    const program = programOf(
      [
        '.intel_syntax noprefix',
        '.data',
        'table: .long .L4-.L3',
        'pointer: .quad main',
        '.text',
        'main:',
        '.L3: nop',
        '.L4: ret',
      ].join('\n'),
    )
    expect(program.data.map((item) => item.bytes)).toEqual([
      [1, 0, 0, 0],
      [0x26, 0x11, 0x40, 0, 0, 0, 0, 0],
    ])
  })

  it('does not pad data for `.align` (the contract says: no padding)', () => {
    const program = programOf('.data\na: .byte 1\n.align 8\nb: .quad 2\n.text\nmain: ret')
    expect(program.symbols.get('b')?.address).toBe(0x404031n)
  })

  it.each([
    ['a lone \\r as a line end', 'main:\r  mov eax, 1\r  ret'],
    ['spaces in a constant sum', '.equ count, -8\nmain:\n  mov rax, count + 8\n  ret'],
    ['a space before the bracket', '.equ count, -8\nmain:\n  mov rax, count [rbp]\n  ret'],
    ['a space before the colon of a label', 'main :\n  ret'],
    ['no space after the colon of a label', 'main:ret'],
    ['upper-case 0B and 0X', 'main:\n  mov eax, 0B101\n  mov ebx, 0X1F\n  ret'],
    ['an upper-case section name', '.section .TEXT\nmain:\n  ret'],
  ])('accepts %s', (_name, source) => {
    expect(assemble(source).ok).toBe(true)
  })
})

describe('decisions: a constant used before its .equ line', () => {
  // gcc reads the file from top to bottom (measured with clang): a constant it does not
  // know yet is read as a memory address in `mov eax, count`, refused as a scale, and
  // given a 4-byte displacement in `count[rbp]`.
  const TOP = ['.intel_syntax noprefix', 'main:']

  it('warns when a constant is used as a number before its line, and still uses the value', () => {
    const result = assemble(
      [
        ...TOP,
        '  mov eax, count',
        '  sub rsp, size*2',
        '  ret',
        '.equ count, 5',
        '.equ size, 8',
      ].join('\n'),
    )
    if (!result.ok) throw new Error('expected success')
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'undefined-symbol',
        line: 3,
        message:
          'Line 3: `count` is used before line 6, where it gets its value. Here gcc reads `count` as a memory address, not as the number 5. Move line 6 above line 3.',
      },
      {
        severity: 'warning',
        code: 'undefined-symbol',
        line: 4,
        message:
          'Line 4: `size` is used before line 7, where it gets its value. Here gcc reads `size` as a memory address, not as the number 8. Move line 7 above line 4.',
      },
    ])
    expect(result.program.instructions[0].operands[1]).toMatchObject({ kind: 'imm', value: 5n })
    expect(result.program.instructions[1].operands[1]).toMatchObject({ kind: 'imm', value: 16n })
  })

  it('warns about a constant whose value uses a constant from a later line', () => {
    const result = assemble(
      [
        '.intel_syntax noprefix',
        '.equ frame, slot*4',
        '.equ slot, 8',
        'main:',
        '  sub rsp, frame',
      ].join('\n'),
    )
    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'Line 5: `frame` uses `slot`, and `slot` gets its value later, on line 3. Here gcc reads `frame` as a memory address, not as the number 32. Move line 3 above line 2.',
    ])
  })

  it('says nothing when every constant comes first', () => {
    const source = [
      '.intel_syntax noprefix',
      '.equ slot, 8',
      '.equ frame, slot*4',
      'main:',
      '  sub rsp, frame',
      '  mov eax, frame[rbp]',
    ]
    expect(assemble(source.join('\n')).diagnostics).toEqual([])
  })

  it('says nothing for an address, `offset`, a data value or a constant (gcc reads those the same)', () => {
    const result = assemble(
      [
        ...TOP,
        '  mov rax, slot[rbp]',
        '  mov eax, offset count',
        '  ret',
        '.data',
        'value: .quad count',
        '.zero count',
        '.equ total, count+1',
        '.equ count, 5',
        'slot = -16',
      ].join('\n'),
    )
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual([])
  })

  it('gives an address with a constant from a later line a 4-byte displacement, as gcc does', () => {
    const program = programOf(
      [
        ...TOP,
        '  mov rax, slot[rbp]',
        '  lea rdi, [rbp+slot]',
        'slot = -16',
        '  mov rax, slot[rbp]',
      ].join('\n'),
    )
    expect(program.instructions.map((instruction) => instruction.size)).toEqual([7, 7, 4])
  })

  it('refuses a constant from a later line as the scale of a register, as gcc does', () => {
    expect(errorsOf([...TOP, '  mov eax, [rax+rbx*size]', '.equ size, 8'].join('\n'))).toEqual([
      {
        severity: 'error',
        code: 'undefined-symbol',
        line: 3,
        message:
          'Line 3: `size` is used before line 4, where it gets its value. gcc must know the value of `size` here, so it refuses this line. Move line 4 above line 3.',
      },
    ])
    const program = programOf(['.equ size, 8', ...TOP, '  mov eax, [rax+rbx*size]'].join('\n'))
    expect(program.instructions[0].operands[1]).toMatchObject({ index: 'rbx', scale: 8 })
  })
})

describe('decisions: characters pasted from slides and phones', () => {
  it('refuses a look-alike character with the corrected line, and warns about special spaces', () => {
    const result = assemble(
      [
        '.intel_syntax noprefix',
        'msg: .string “Hello”',
        'main:',
        '\u00a0\u00a0mov eax, 5',
        '  mov rax, [rbp–8]',
      ].join('\n'),
    )
    expect(result.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'bad-string',
        line: 2,
        message:
          'Line 2: `“` looks like `"`, but gcc can\'t read it. Type `"` instead: `msg: .string "Hello"`.',
      },
      {
        severity: 'warning',
        code: 'bad-operand',
        line: 4,
        message:
          "Line 4: this line has a special space (U+00A0) that gcc can't read. Delete the spaces on this line and type them again.",
      },
      {
        severity: 'error',
        code: 'bad-operand',
        line: 5,
        message:
          "Line 5: `–` looks like `-`, but gcc can't read it. Type `-` instead: `mov rax, [rbp-8]`.",
      },
    ])
  })

  it('runs a program whose only problem is special spaces or invisible characters', () => {
    const result = assemble(
      '\ufeff.intel_syntax noprefix\nmain:\n\u00a0\u00a0mov\u00a0eax, 5\n  re\u200bt',
    )
    if (!result.ok) throw new Error('expected success')
    expect(result.diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.line])).toEqual([
      ['warning', 1],
      ['warning', 3],
      ['warning', 4],
    ])
    expect(result.program.instructions.map((instruction) => instruction.text)).toEqual([
      'mov eax, 5',
      'ret',
    ])
  })

  it('keeps special characters inside text and comments as they are', () => {
    const result = assemble(
      '.intel_syntax noprefix\nmsg: .string "a\u00a0“b”" # – \u00a0\nmain:\n  ret',
    )
    if (!result.ok) throw new Error('expected success')
    expect(result.diagnostics).toEqual([])
    expect(result.program.data[0].bytes).toEqual([
      0x61, 0xc2, 0xa0, 0xe2, 0x80, 0x9c, 0x62, 0xe2, 0x80, 0x9d, 0,
    ])
  })
})

describe('decisions: messages say "this emulator" for what only the emulator lacks', () => {
  it.each([
    ['push ax', 'is a real x86 instruction, but this emulator'],
    ['push qword ptr [rax]', "this emulator can't push memory"],
    ['pop qword ptr [rax]', "this emulator can't pop into memory"],
    ['ret 8', 'in this emulator'],
    ['imul rax, rbx, 5', 'this emulator supports only the 2-operand form'],
    ['mov rax, [ebp-8]', 'This emulator builds addresses only from 64-bit registers'],
    ['mov rax, 1Fh', 'the way other assemblers write hex'],
    ['shl rax, 1', 'is a real instruction, but this emulator does not support it'],
  ])('%s', (line, words) => {
    expect(errorsOf(`${HEAD}${line}`)[0].message).toContain(words)
  })

  it('names the stack protector when gcc output uses it', () => {
    const errors = errorsOf(`${HEAD}mov rax, QWORD PTR fs:40\ncall __stack_chk_fail@PLT`)
    expect(errors.map((error) => error.message)).toEqual([
      "Line 3: `qword ptr fs:40` is gcc's stack protector, and this emulator has no segment registers. Compile with `-fno-stack-protector` to leave it out.",
      "Line 4: `__stack_chk_fail` is part of gcc's stack protector, and this emulator does not have it. Compile with `-fno-stack-protector` to leave it out.",
    ])
  })
})

describe('M8: NASM lines, .comm, and the note after 20 errors', () => {
  it.each([
    ['buf resb 8', 'Line 3: `resb` is NASM syntax. In gcc assembly, write `buf: .zero 8`.'],
    ['buf resw 8', 'Line 3: `resw` is NASM syntax. In gcc assembly, write `buf: .zero 16`.'],
    ['buf resd 2', 'Line 3: `resd` is NASM syntax. In gcc assembly, write `buf: .zero 8`.'],
    ['buf resq 4', 'Line 3: `resq` is NASM syntax. In gcc assembly, write `buf: .zero 32`.'],
    ['buf: resq 2', 'Line 3: `resq` is NASM syntax. In gcc assembly, write `.zero 16`.'],
    ['buf resb SIZE', 'Line 3: `resb` is NASM syntax. In gcc assembly, write `buf: .zero SIZE`.'],
    ['buf resq N+1', 'Line 3: `resq` is NASM syntax. In gcc assembly, write `buf: .zero (N+1)*8`.'],
    ['SIZE equ 8', 'Line 3: `equ` is NASM syntax. In gcc assembly, write `.equ SIZE, 8`.'],
    ['size equ 8', 'Line 3: `equ` is NASM syntax. In gcc assembly, write `.equ size, 8`.'],
  ])('%s: the NASM word, and the whole gcc line to write', (line, message) => {
    expect(errorsOf(`.intel_syntax noprefix\n.data\n${line}\n.text\nmain: ret`)).toEqual([
      { severity: 'error', code: 'unknown-instruction', line: 3, message },
    ])
  })

  it('a line that follows the NASM advice assembles', () => {
    for (const fixed of ['buf: .zero 32', '.equ SIZE, 8']) {
      expect(assemble(`.intel_syntax noprefix\n.data\n${fixed}\n.text\nmain: ret`).ok).toBe(true)
    }
  })

  it('warns about .comm and .lcomm on their own line, with the .data line to write instead', () => {
    const result = assemble(`${HEAD}  ret\n.comm counter, 8, 8\n.lcomm buffer, 64`)
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'unknown-directive',
        line: 4,
        message:
          'Line 4: this emulator does not support `.comm`, so it skipped this line. Put the variable after `.data` instead, like `counter: .zero 8`.',
      },
      {
        severity: 'warning',
        code: 'unknown-directive',
        line: 5,
        message:
          'Line 5: this emulator does not support `.lcomm`, so it skipped this line. Put the variable after `.data` instead, like `buffer: .zero 64`.',
      },
    ])
  })

  it('keeps the .comm warning next to the error of a later use of its variable', () => {
    const result = assemble(
      `.intel_syntax noprefix\n.comm buf, 16, 16\nmain:\n  lea rax, buf[rip]\n  ret`,
    )
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((item) => [item.severity, item.code, item.line])).toEqual([
      ['warning', 'unknown-directive', 2],
      ['error', 'undefined-symbol', 4],
    ])
  })
})

describe('M8: a long program moves its data up, as a linker does', () => {
  /** `count` 10-byte instructions, then a call to puts with a string and a .data value. */
  function longProgram(count: number): string {
    return [
      '.intel_syntax noprefix',
      's: .string "hi"',
      '.data',
      'd: .quad 7',
      '.text',
      'main:',
      ...Array.from({ length: count }, () => '    mov rax, 0x1122334455667788'),
      '    lea rdi, s[rip]',
      '    call puts@PLT',
      '    ret',
      '',
    ].join('\n')
  }

  // The gap from 0x401126 to 0x402010 is 3818 bytes. 380 × 10 + 7 + 5 + 1 = 3813 bytes fit
  // (the code ends at 0x40200b); with 381 the code needs 3823 bytes and reaches past it.
  it('keeps the read-only data at 0x402010 while the code ends at or before it', () => {
    const program = programOf(longProgram(380))
    expect(program.layout.textEnd).toBe(0x40200bn)
    expect(program.layout.textEnd).toBeLessThanOrEqual(0x402010n)
    expect(program.layout.rodataBase).toBe(0x402010n)
    expect(program.layout.dataBase).toBe(0x404030n)
  })

  it('moves the read-only data to the next page after the code when the code reaches into it', () => {
    const program = programOf(longProgram(381))
    expect(program.layout.textEnd).toBe(0x402015n)
    expect(program.layout.textEnd).toBeGreaterThan(0x402010n)
    expect(program.layout.rodataBase).toBe(0x403010n)
    expect(program.data[0]).toMatchObject({ label: 's', address: 0x403010n })
    // The writable data does not overlap anything, so it stays where it was.
    expect(program.layout.dataBase).toBe(0x404030n)
    expect(program.symbols.get('s')?.address).toBe(0x403010n)
    // `lea rdi, s[rip]` uses the new address.
    const lea = program.instructions[381]
    expect(lea.operands[1]).toMatchObject({ kind: 'mem', symbol: 's', symbolAddress: 0x403010n })
  })

  it('moves the writable data too when the read-only data or the code reaches into it', () => {
    const text = Array.from({ length: 1300 }, () => '    mov rax, 0x1122334455667788')
    const program = programOf(
      ['.intel_syntax noprefix', '.data', 'd: .quad 7', '.text', 'main:', ...text, '  ret'].join(
        '\n',
      ),
    )
    // 1300 × 10 bytes: the code runs from 0x401126 past 0x404030.
    expect(program.layout.textEnd).toBeGreaterThan(0x404030n)
    expect(program.layout.dataBase % 0x1000n).toBe(0x30n)
    expect(program.layout.dataBase).toBeGreaterThanOrEqual(program.layout.textEnd)
  })
})

describe('M8: a whole AT&T line is shown turned around', () => {
  const DESTINATION = 'This emulator uses Intel syntax, which puts the destination first'
  it.each([
    ['movq %rbx, %rax', `${DESTINATION}: write \`mov rax, rbx\`.`],
    ['mov %rax, %rbx', `${DESTINATION}: write \`mov rbx, rax\`.`],
    ['movl $0, -4(%rbp)', `${DESTINATION}: write \`mov dword ptr [rbp-4], 0\`.`],
    ['movl -20(%rbp), %eax', `${DESTINATION}: write \`mov eax, [rbp-20]\`.`],
    ['leaq .LC0(%rip), %rdi', `${DESTINATION}: write \`lea rdi, .LC0[rip]\`.`],
    ['subq $16, %rsp', `${DESTINATION}: write \`sub rsp, 16\`.`],
    ['addl $1, -4(%rbp)', `${DESTINATION}: write \`add dword ptr [rbp-4], 1\`.`],
    ['movq (%rax,%rbx,8), %rcx', `${DESTINATION}: write \`mov rcx, [rax+rbx*8]\`.`],
    ['movl arr(,%rcx,4), %eax', `${DESTINATION}: write \`mov eax, arr[rcx*4]\`.`],
    ['movq 16(%rax,%rbx,8), %rcx', `${DESTINATION}: write \`mov rcx, [rax+rbx*8+16]\`.`],
    ['movzbl -1(%rbp), %eax', `${DESTINATION}: write \`movzx eax, byte ptr [rbp-1]\`.`],
    ['movslq %eax, %rax', `${DESTINATION}: write \`movsxd rax, eax\`.`],
    ['movl $msg, %edi', `${DESTINATION}: write \`mov edi, offset msg\`.`],
    ['andq $-16, %rsp', `${DESTINATION}: write \`and rsp, -16\`.`],
    [
      'cmpl $9, -4(%rbp)',
      'This emulator uses Intel syntax, which puts the two operands in the other order: write `cmp dword ptr [rbp-4], 9`.',
    ],
    ['testq %rax, %rax', 'This emulator uses Intel syntax: write `test rax, rax`.'],
    ['pushq %rbp', 'This emulator uses Intel syntax: write `push rbp`.'],
    ['popq %rbx', 'This emulator uses Intel syntax: write `pop rbx`.'],
    ['incl -8(%rbp)', 'This emulator uses Intel syntax: write `inc dword ptr [rbp-8]`.'],
  ])('%s', (line, rest) => {
    const [error] = errorsOf(`${HEAD}${line}\nret`)
    expect(error).toEqual({
      severity: 'error',
      code: 'att-syntax',
      line: 3,
      message: `Line 3: this line is AT&T syntax. ${rest}`,
    })
    expect(error.message.length).toBeLessThan(200)
  })

  it('the Intel line it shows assembles and does the same thing', () => {
    const fixes: [string, string][] = [
      ['movq %rbx, %rax', 'mov rax, rbx'],
      ['movl $0, -4(%rbp)', 'mov dword ptr [rbp-4], 0'],
      ['movzbl -1(%rbp), %eax', 'movzx eax, byte ptr [rbp-1]'],
      ['cmpl $9, -4(%rbp)', 'cmp dword ptr [rbp-4], 9'],
    ]
    for (const [att, intel] of fixes) {
      expect(errorsOf(`${HEAD}${att}\nret`)[0].message).toContain(`\`${intel}\``)
      expect(assemble(`${HEAD}push rbp\nmov rbp, rsp\n${intel}\nret`).ok, intel).toBe(true)
    }
  })

  it.each([
    // An Intel line with one AT&T piece: the piece is named (turning it around would be wrong).
    ['mov rax, $5', 'this looks like AT&T syntax (`$5`)'],
    ['mov rax, %rbx', 'this looks like AT&T syntax (`%rbx`)'],
    // A suffix but Intel operands: the instruction name is the one thing to fix.
    ['movq rax, 5', 'write `mov`, not `movq`'],
    // Parts that cannot be turned around safely.
    ['movq %fs:40, %rax', 'write `mov`, not `movq`'],
    ['callq *%rax', 'write `call`, not `callq`'],
    ['movl 0x1234, %eax', 'write `mov`, not `movl`'],
    ['nopw 0(%rax,%rax,1)', 'write `nop`, not `nopw`'],
    // The wrong number of operands: that message comes once the line is Intel syntax.
    ['movq %rax', 'write `mov`, not `movq`'],
    ['imull $3, %eax, %ecx', 'write `imul`, not `imull`'],
  ])('%s keeps the message about one piece', (line, words) => {
    const [error] = errorsOf(`${HEAD}${line}\nret`)
    expect(error.code).toBe('att-syntax')
    expect(error.message).toContain(words)
  })
})
