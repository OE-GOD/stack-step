#!/usr/bin/env node
/**
 * Ground truth for instruction sizes.
 *
 * The emulator gives every instruction its real x86-64 encoding length
 * (`src/emulator/sizes.ts`). This script asks a real assembler for the same lengths
 * and stores them in `src/emulator/__fixtures__/encoding-sizes.json`.
 * `src/emulator/sizes.test.ts` replays that file through `assemble()` on every test
 * run, so the tests need no assembler. Run this script again only when the list of
 * instruction forms below changes:
 *
 *   node scripts/make-size-fixture.mjs
 *
 * Options
 *   --out <file>     write somewhere else (default: the fixture in the repo)
 *   --target <name>  `linux` or `macho`: use only this clang target (default: try both)
 *
 * How it works
 *   1. assemble the lines with clang as x86-64 (`-target x86_64-unknown-linux-gnu`
 *      first, then `-arch x86_64`), with `.intel_syntax noprefix` at the top;
 *   2. read the length of every instruction back with `objdump -d`
 *      (or `llvm-objdump`, or `xcrun llvm-objdump`);
 *   3. write the JSON file.
 *
 * When clang or objdump is missing, or cannot make x86-64 code, the script says so
 * and leaves the existing fixture alone (exit code 0). When a line of the list does
 * not assemble, that is a mistake in the list: the script shows the assembler's
 * message and exits with code 1.
 *
 * clang is not GNU `as`. Three things to know when adding lines:
 *   - clang does not read gcc's `OFFSET FLAT:label`; write `offset label` here.
 *   - clang wants `movsxd` for `movsx r64, r/m32`; add the note `| as: movsxd …`.
 *   - for `add/sub/cmp/and/or/xor ax|eax|rax, offset label` clang keeps the ModRM
 *     byte; GNU `as` uses the form without it, one byte shorter. The emulator follows
 *     clang, because this fixture is what its sizes are checked against.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT = path.join(REPO_ROOT, 'src/emulator/__fixtures__/encoding-sizes.json')

/* ───────────────────────── The instruction forms ───────────────────────── */

/**
 * Lines every single instruction below may use: three data labels and two constants.
 * The emulator and clang read exactly the same text.
 */
const PREAMBLE = [
  '.intel_syntax noprefix',
  '.data',
  'counter: .long 0',
  'table: .quad 1, 2, 3',
  'message: .string "hi"',
  '.text',
  '.equ count, -8',
  '.equ big, 1000',
]

/**
 * One instruction per line. Notes after `|`:
 *   as: <text>   clang needs another spelling for the same instruction
 *   elf          uses a 32-bit absolute address, which only the Linux target can make
 * Lines that start with `//` are headings.
 */
const SINGLES = `
// push and pop
push rbx
push rax
push rbp
push r8
push r12
push r15
push 0
push 5
push 127
push 128
push -128
push -129
push 1000
push 0x7fffffff
push -1
push count
push big
push offset message                 | elf
pop rbp
pop rax
pop rbx
pop r8
pop r12
pop r15

// mov register, register
mov rbp, rsp
mov rax, rbx
mov eax, ebx
mov ax, bx
mov al, bl
mov ah, bl
mov al, ch
mov r8, rax
mov rax, r8
mov r9, r10
mov r15, rsp
mov r8d, eax
mov eax, r9d
mov r8w, ax
mov r8b, al
mov sil, al
mov dil, sil
mov bpl, spl

// mov register, number
mov eax, 0
mov eax, 5
mov ecx, 1000
mov eax, -1
mov eax, 0xffffffff
mov eax, 'A'
mov eax, count
mov rax, 0
mov rax, 5
mov rax, -1
mov rax, 0x7fffffff
mov rax, 0x80000000
mov rax, 0xffffffff
mov rax, -0x80000000
mov rax, -0x80000001
mov rax, 0x1122334455667788
mov rax, 0xffffffffffffffff
mov rax, big
mov rdi, 1000
mov r8, 7
mov r12, -1
mov r10, 0x1122334455667788
mov al, 7
mov al, 'A'
mov ah, 7
mov bl, 255
mov cl, -1
mov sil, 7
mov dil, 1
mov r8b, 7
mov ax, 7
mov cx, 1000
mov r8w, 7
mov r8d, 7
mov r15d, 1000
mov edi, offset message             | elf
mov rdi, offset message             | elf

// mov register, memory: every shape of address
mov rax, [rax]
mov rax, [rbx]
mov rax, [rsp]
mov rax, [rbp]
mov rax, [r8]
mov rax, [r12]
mov rax, [r13]
mov rax, [r15]
mov eax, [rbp-4]
mov rax, [rbp-8]
mov rax, [rbp+8]
mov rax, [rbp-128]
mov rax, [rbp+127]
mov rax, [rbp+128]
mov rax, [rbp-129]
mov rax, [rbp-1000]
mov rax, [rax+8]
mov rax, [rax+1000]
mov rax, [rsp+8]
mov rax, 8[rsp]
mov rax, -8[rbp]
mov rax, [rsp+1000]
mov rax, [r12+8]
mov rax, [r13+8]
mov rax, [r12+1000]
mov eax, count[rbp]
mov rax, count+16[rbp]
mov rax, [rdi+rcx*8]
mov rax, [rax+rbx]
mov rax, [rax+rbx*2]
mov rax, [rax+rbx*4]
mov rax, [rax+rbx*8+16]
mov rax, [rax+rbx*8+1000]
mov rax, [rbp+rax*8]
mov rax, [r13+rax*8]
mov rax, [rsp+rax*2]
mov rax, [r12+rax]
mov rax, [rax+r12*8]
mov rax, [r8+r9*8]
mov rax, [rbx*8]
mov rax, [rbx*8+16]
mov rax, [rax*1]
mov rax, [rax+rsp]
mov rdx, [0+rax*4]
mov eax, counter[rip]
mov rax, table[rip]
mov rax, table+8[rip]
mov rax, [rip+table]
mov eax, [0x1000]
mov eax, [8]
mov eax, counter                    | elf
mov rax, counter                    | elf
mov al, counter                     | elf
mov eax, table+8                    | elf
mov eax, table[rax*8]               | elf
mov rax, table[rbx]                 | elf
mov rax, table[rbx+rcx*8]           | elf
mov al, [rax]
mov ax, [rax]
mov bl, [rbp-1]
mov sil, [rdi]
mov r8d, [rbp-4]
mov r9, [rbp-8]
mov eax, dword ptr [rbp-4]
mov rax, qword ptr [rbp-8]

// mov memory, register
mov [rbp-8], rax
mov [rbp-4], eax
mov [rbp-2], ax
mov [rbp-1], al
mov [rax], rbx
mov [rsp], rax
mov [rsp+8], rdi
mov [r12], rax
mov [r13], rax
mov [rdi+rcx*8], rax
mov [rax], r8
mov [r8], rax
mov [rax], sil
mov qword ptr [rbp-8], rax
mov counter[rip], eax
mov counter, eax                    | elf

// mov memory, number
mov dword ptr [rbp-4], 5
mov qword ptr [rbp-8], 5
mov byte ptr [rbp-1], 5
mov word ptr [rbp-2], 5
mov dword ptr [rax], 0
mov byte ptr [rax], 255
mov word ptr [rax], 1000
mov qword ptr [rsp], 1000
mov dword ptr [rbp-1000], 5
mov qword ptr [rax+rbx*8], -1
mov qword ptr [rbp-8], 0xffffffffffffffff
mov qword ptr [r12], 5
mov dword ptr [r8+8], 5
mov dword ptr counter[rip], 5
mov dword ptr counter, 5            | elf
mov qword ptr [rbp-8], offset message | elf

// add, sub, cmp, and, or, xor
sub rsp, 16
sub rsp, 8
sub rsp, 128
add rsp, -128
add rsp, 16
add rax, rbx
add eax, ebx
add ax, bx
add al, bl
add r8, r9
add rax, r8
add eax, 5
add eax, 127
add eax, 128
add eax, -128
add eax, -129
add eax, 1000
add ebx, 1000
add rax, 5
add rax, 1000
add rbx, 1000
add ax, 5
add ax, 1000
add bx, 1000
add al, 5
add bl, 5
add ah, 5
add sil, 5
add r8b, 5
add r8, 5
add r8, 1000
add r8d, 1000
add eax, 0xffffffff
add ax, 0xfff0
add rax, 0xfffffffffffffff0
add eax, count
add eax, big
and rsp, -16
and rsp, 0xfffffffffffffff0
sub eax, 1
sub rcx, 1
sub eax, 1000
sub rax, [rbp-8]
sub [rbp-8], rax
cmp rax, 10
cmp eax, 0
cmp eax, -1
cmp al, 5
cmp al, 'A'
cmp bl, 5
cmp ax, 5
cmp ax, 1000
cmp eax, 1000
cmp rax, 1000
cmp rbx, 1000
cmp eax, ebx
cmp eax, count
cmp rax, [rbp-8]
cmp [rbp-8], rax
cmp dword ptr [rbp-4], 0
cmp dword ptr [rbp-4], 1000
cmp qword ptr [rbp-8], 0
cmp qword ptr [rbp-8], 1000
cmp byte ptr [rdi], 0
cmp byte ptr [rax+rcx], 0
cmp word ptr [rax], 5
cmp word ptr [rax], 1000
and eax, 0xff
and eax, 0x7f
and eax, 1000
and rax, 1
and al, 1
and rax, rbx
and dword ptr [rbp-4], 1
or al, 0x80
or eax, 1
or eax, 1000
or rax, rbx
or qword ptr [rbp-8], 1
xor eax, eax
xor rax, rax
xor al, al
xor r8d, r8d
xor rdx, rdx
xor eax, 1
xor eax, 1000
xor byte ptr [rax], 1
add dword ptr [rbp-4], 1
add qword ptr [rbp-8], 1
add byte ptr [rax], 1
add word ptr [rax], 1
add word ptr [rax], 1000
add dword ptr [rax], 1000
add qword ptr [rax], 1000
add [rbp-8], rax
add rax, [rbp-8]
add eax, [rbp-4]
add rax, [rdi+rcx*8]
add eax, counter[rip]
add dword ptr counter[rip], 1
add rax, offset message             | elf
add eax, offset message             | elf
add rbx, offset message             | elf
cmp rax, offset message             | elf
sub ebx, offset message             | elf

// test
test rax, rax
test eax, eax
test ax, ax
test al, al
test r8, r8
test eax, ebx
test al, 1
test ax, 1
test eax, 1
test rax, 1
test bl, 1
test bx, 1
test ebx, 1
test rbx, 1
test sil, 1
test r8d, 1
test eax, 1000
test eax, 0xffffffff
test rax, -1
test byte ptr [rax], 1
test word ptr [rax], 1
test dword ptr [rax], 1
test qword ptr [rax], 1
test dword ptr [rbp-4], 1000
test [rax], eax
test eax, [rax]
test rax, [rbp-8]
test eax, offset message            | elf

// inc and dec
inc rax
inc eax
inc ax
inc al
inc ah
inc r8
inc r8d
inc sil
dec ecx
dec rcx
dec cx
dec cl
dec r15
inc dword ptr [rbp-4]
inc qword ptr [rax]
inc word ptr [rax]
inc byte ptr [rax]
inc dword ptr counter[rip]
dec dword ptr [rbp-4]
dec qword ptr [rsp]
dec byte ptr [rdi+rcx]

// imul
imul rax, rbx
imul eax, ebx
imul ax, bx
imul r8, r9
imul rax, r8
imul eax, [rbp-4]
imul rax, [rbp-8]
imul rax, [rbx]
imul rax, qword ptr [rbp-8]
imul eax, dword ptr counter[rip]
imul eax, 5
imul rax, 5
imul ax, 5
imul r8d, 5
imul eax, 127
imul eax, 128
imul eax, -128
imul eax, -129
imul eax, 1000
imul rax, 1000
imul ax, 1000
imul r8, 1000
imul ax, 0xfff0
imul eax, 0xffffffff
imul eax, count

// movzx and movsx
movzx eax, al
movzx eax, bl
movzx eax, ah
movzx eax, ax
movzx rax, al
movzx rax, ax
movzx ax, al
movzx eax, sil
movzx r8d, al
movzx eax, r8b
movzx eax, byte ptr [rbp-1]
movzx eax, word ptr [rbp-2]
movzx rax, byte ptr [rax]
movzx rax, word ptr [rax]
movzx ax, byte ptr [rax]
movzx eax, byte ptr [rdi+rcx]
movzx ecx, byte ptr [rsp]
movzx eax, byte ptr message[rip]
movsx rax, al
movsx eax, al
movsx eax, ax
movsx ax, al
movsx rax, ax
movsx eax, sil
movsx eax, byte ptr [rbp-1]
movsx eax, word ptr [rax]
movsx rax, byte ptr [rax]
movsx rax, word ptr [rsp+8]
movsx r9d, byte ptr [r8]
movsxd rax, ebx
movsxd rax, dword ptr [rbp-4]
movsx rax, ebx                      | as: movsxd rax, ebx
movsx rax, dword ptr [rbp-4]        | as: movsxd rax, dword ptr [rbp-4]
movsx r8, eax                       | as: movsxd r8, eax
movsx rax, r8d                      | as: movsxd rax, r8d

// lea
lea rdi, message[rip]
lea rax, message[rip]
lea rax, table[rip]
lea rax, table+16[rip]
lea rdi, 8[rsp]
lea rdi, [rsp+8]
lea rax, [rsp]
lea rax, [rbp-8]
lea rax, [rbp-4]
lea rsi, [rbp-8]
lea rax, [rbp-1000]
lea rax, [rbp]
lea rax, [rbp+0]
lea rax, [rax]
lea rax, [rax+rax*4]
lea eax, [rdi+rsi]
lea eax, [rax+1]
lea rax, [rdi+rsi*8+16]
lea ax, [rbx]
lea r8, [rax+8]
lea rax, [r8+8]
lea rax, [r12]
lea rax, [r13]
lea rdx, [0+rax*4]
lea rdx, [rax*8]
lea rax, counter                    | elf

// call, ret, nop, leave, endbr64
call printf@PLT
call printf
call puts@PLT
call putchar@PLT
call scanf@PLT
call __isoc99_scanf@PLT
call exit@PLT
ret
nop
leave
endbr64
`

/** `count` copies of one line. */
function times(line, count) {
  return { line, count }
}

const TEN_BYTES = 'mov rax, 0x1122334455667788'
const CONDITIONAL_JUMPS = [
  ...['je', 'jne', 'jg', 'jge', 'jl', 'jle', 'ja', 'jae', 'jb', 'jbe', 'js', 'jns', 'jo', 'jno'],
  ...['jz', 'jnz', 'jnle', 'jnl', 'jnge', 'jng', 'jnbe', 'jnb', 'jnc', 'jnae', 'jc', 'jna'],
]

/**
 * Small whole programs for the instructions whose size depends on where they are:
 * `jmp` and the conditional jumps are 2 bytes when the target is -128 … 127 bytes
 * from the end of the jump, and 5 or 6 bytes when it is not. Also an address that uses
 * a `.equ` constant from a later line: gcc does not know the number yet, so it leaves
 * 4 bytes for it.
 * A line is text, or `times(text, n)` for n copies. A line that ends with `:` is a label,
 * and a `.equ` line takes no space either.
 */
const PROGRAMS = [
  {
    name: 'jmp forward, 127 bytes away: near',
    lines: ['jmp done', times('nop', 127), 'done:', 'ret'],
  },
  {
    name: 'jmp forward, 128 bytes away: far',
    lines: ['jmp done', times('nop', 128), 'done:', 'ret'],
  },
  {
    name: 'jmp backward, 128 bytes away: near',
    lines: ['top:', times('nop', 126), 'jmp top', 'ret'],
  },
  {
    name: 'jmp backward, 129 bytes away: far',
    lines: ['top:', times('nop', 127), 'jmp top', 'ret'],
  },
  {
    name: 'je forward, 127 bytes away: near',
    lines: ['je done', times('nop', 127), 'done:', 'ret'],
  },
  {
    name: 'je forward, 128 bytes away: far',
    lines: ['je done', times('nop', 128), 'done:', 'ret'],
  },
  {
    name: 'jne backward, 128 bytes away: near',
    lines: ['top:', times('nop', 126), 'jne top', 'ret'],
  },
  {
    name: 'jne backward, 129 bytes away: far',
    lines: ['top:', times('nop', 127), 'jne top', 'ret'],
  },
  {
    name: 'jmp over bigger instructions, 127 bytes away: near',
    lines: ['jmp done', times(TEN_BYTES, 12), times('nop', 7), 'done:', 'ret'],
  },
  {
    name: 'jmp over bigger instructions, 130 bytes away: far',
    lines: ['jmp done', times(TEN_BYTES, 13), 'done:', 'ret'],
  },
  {
    name: 'every conditional jump, near and backward',
    lines: ['top:', 'nop', ...CONDITIONAL_JUMPS.map((jump) => `${jump} top`), 'ret'],
  },
  {
    name: 'every conditional jump, far and backward',
    lines: ['top:', times('nop', 200), ...CONDITIONAL_JUMPS.map((jump) => `${jump} top`), 'ret'],
  },
  {
    name: 'every conditional jump, near and forward',
    lines: [...CONDITIONAL_JUMPS.map((jump) => `${jump} done`), 'nop', 'done:', 'ret'],
  },
  {
    name: 'every conditional jump, far and forward',
    lines: [...CONDITIONAL_JUMPS.map((jump) => `${jump} done`), times('nop', 200), 'done:', 'ret'],
  },
  {
    name: 'a jump that grows pushes another jump out of reach',
    lines: [
      'je end',
      times('nop', 120),
      'jmp far',
      times('nop', 3),
      'end:',
      times('nop', 130),
      'far:',
      'ret',
    ],
  },
  {
    name: 'three jumps that grow one after another',
    lines: [
      'jmp first',
      times('nop', 121),
      'jne second',
      'jg third',
      'first:',
      times('nop', 122),
      'second:',
      times('nop', 130),
      'third:',
      'ret',
    ],
  },
  {
    name: 'jump to the next line and jump to itself',
    lines: ['jmp next', 'next:', 'jne next', 'self:', 'jmp self', 'ret'],
  },
  {
    name: 'jump to a label at the very end',
    lines: ['mov eax, 1', 'jmp end', 'mov eax, 2', 'end:'],
  },
  {
    name: 'call a function in the same program',
    lines: ['main:', 'call helper', 'call helper@PLT', 'ret', 'helper:', 'mov eax, 1', 'ret'],
  },
  {
    name: 'call a function that is far away',
    lines: ['main:', 'call helper', 'ret', times('nop', 300), 'helper:', 'ret'],
  },
  {
    name: 'a loop that counts down',
    lines: [
      'main:',
      'mov ecx, 5',
      'mov eax, 0',
      'again:',
      'add eax, ecx',
      'dec ecx',
      'jnz again',
      'ret',
    ],
  },
  {
    name: 'if and else',
    lines: [
      'main:',
      'cmp eax, 5',
      'jle small',
      'mov ebx, 1',
      'jmp done',
      'small:',
      'mov ebx, 0',
      'done:',
      'ret',
    ],
  },
  {
    name: 'a function with a stack frame and a loop',
    lines: [
      'main:',
      'push rbp',
      'mov rbp, rsp',
      'sub rsp, 16',
      'mov dword ptr [rbp-4], 0',
      'mov dword ptr [rbp-8], 1',
      'jmp check',
      'body:',
      'mov eax, dword ptr [rbp-8]',
      'add dword ptr [rbp-4], eax',
      'add dword ptr [rbp-8], 1',
      'check:',
      'cmp dword ptr [rbp-8], 10',
      'jle body',
      'mov eax, dword ptr [rbp-4]',
      'leave',
      'ret',
    ],
  },
  {
    name: 'an address with a constant from a later line has a 4-byte displacement',
    lines: [
      'main:',
      'mov rax, slot[rbp]',
      'lea rdi, [rbp+slot]',
      'mov eax, dword ptr slot[rsp]',
      'ret',
      '.equ slot, -16',
      'mov rax, slot[rbp]',
      'ret',
    ],
  },
  {
    name: 'an address with a constant whose value uses a later constant has a 4-byte displacement',
    lines: [
      '.equ frame, slot*4',
      '.equ slot, -2',
      'main:',
      'mov eax, frame[rbp]',
      'mov eax, slot[rbp]',
      'ret',
    ],
  },
]

/* ─────────────────────────────── Tools ─────────────────────────────── */

/** A mistake in the list above, or output this script cannot read. */
class FixtureError extends Error {}

const TARGETS = [
  {
    name: 'x86_64-unknown-linux-gnu',
    key: 'linux',
    flags: ['-target', 'x86_64-unknown-linux-gnu'],
    elf: true,
  },
  { name: 'x86_64 (Mach-O)', key: 'macho', flags: ['-arch', 'x86_64'], elf: false },
]

const OBJDUMPS = [['objdump'], ['llvm-objdump'], ['xcrun', 'llvm-objdump']]

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) return { ok: false, stdout: '', stderr: String(result.error.message) }
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr }
}

/** The instructions in the output of `objdump -d`: where each one starts and its length. */
function readDisassembly(text) {
  const instructions = []
  for (const line of text.split('\n')) {
    // "   4: b8 00 00 00 00   <tab>movl $0x0, %eax"   (llvm-objdump and GNU objdump)
    const match = /^\s*([0-9a-f]+):\s+((?:[0-9a-f]{2} )*[0-9a-f]{2})(?:\s+(.*))?$/.exec(line)
    if (!match) continue
    const address = Number.parseInt(match[1], 16)
    const bytes = match[2].split(' ').length
    const text = (match[3] ?? '').trim()
    const last = instructions[instructions.length - 1]
    // GNU objdump puts the last bytes of a long instruction on a second line.
    if (text === '' && last && last.address + last.bytes === address) last.bytes += bytes
    else instructions.push({ address, bytes })
  }
  for (let i = 1; i < instructions.length; i++) {
    const previous = instructions[i - 1]
    if (previous.address + previous.bytes !== instructions[i].address) {
      throw new FixtureError('objdump output has a gap: this script cannot read it.')
    }
  }
  return instructions.map((instruction) => instruction.bytes)
}

/** Assemble `lines` with clang. Returns the object file, or null and what clang said. */
function assembleLines(folder, target, lines) {
  const sourceFile = path.join(folder, 'fixture.s')
  const objectFile = path.join(folder, 'fixture.o')
  writeFileSync(sourceFile, `${lines.join('\n')}\n`)
  const assembled = run('clang', ['-c', ...target.flags, sourceFile, '-o', objectFile])
  return assembled.ok
    ? { objectFile, problem: null }
    : { objectFile: null, problem: assembled.stderr.trim() }
}

/** The size of every instruction in an object file, or null when `objdump` cannot say. */
function disassemble(objdump, objectFile) {
  const [command, ...args] = objdump
  const dumped = run(command, [...args, '-d', objectFile])
  return dumped.ok ? readDisassembly(dumped.stdout) : null
}

/** Assemble `lines` and return the size of every instruction, in order. */
function measure(tools, lines, expected) {
  const { objectFile, problem } = assembleLines(tools.folder, tools.target, lines)
  if (objectFile === null) {
    throw new FixtureError(`clang could not assemble the lines:\n${problem}`)
  }
  const sizes = disassemble(tools.objdump, objectFile)
  if (sizes === null) throw new FixtureError(`${tools.objdump.join(' ')} failed.`)
  if (sizes.length !== expected) {
    throw new FixtureError(`expected ${expected} instructions, objdump shows ${sizes.length}.`)
  }
  return sizes
}

/** Find a clang target and an objdump that can make and read x86-64 code. */
function findTools(folder, wantedTarget) {
  const version = run('clang', ['--version'])
  if (!version.ok) return { problem: 'clang was not found.' }
  const probe = ['.intel_syntax noprefix', '.text', 'push rbx', 'mov rbp, rsp', 'ret']
  const targets = TARGETS.filter((target) => wantedTarget === null || target.key === wantedTarget)
  const tried = targets.map((target) => `clang ${target.flags.join(' ')}`).join(', ')

  let assembledOnce = false
  for (const target of targets) {
    const { objectFile } = assembleLines(folder, target, probe)
    if (objectFile === null) continue
    assembledOnce = true
    for (const objdump of OBJDUMPS) {
      let sizes = null
      try {
        sizes = disassemble(objdump, objectFile)
      } catch (error) {
        if (!(error instanceof FixtureError)) throw error
      }
      if (sizes !== null && sizes.join(',') === '1,3,1') {
        return { target, objdump, assembler: version.stdout.split('\n')[0].trim() }
      }
    }
  }
  if (!assembledOnce) return { problem: `clang cannot make x86-64 code here (tried: ${tried}).` }
  const names = OBJDUMPS.map((objdump) => objdump.join(' ')).join(', ')
  return { problem: `no objdump could read what clang made (tried: ${names}).` }
}

/* ───────────────────────────── Measuring ───────────────────────────── */

function readSingles() {
  const singles = []
  for (const raw of SINGLES.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('//')) continue
    const [asm, ...notes] = line.split('|').map((part) => part.trim())
    const single = { asm, clang: asm, elf: false }
    for (const note of notes) {
      if (note === 'elf') single.elf = true
      else if (note.startsWith('as:')) single.clang = note.slice(3).trim()
      else throw new FixtureError(`unknown note "${note}" on the line "${asm}".`)
    }
    singles.push(single)
  }
  return singles
}

/** The Mach-O target does not know `@PLT`. */
function forTarget(line, target) {
  return target.elf ? line : line.replace(/@PLT\b/gi, '')
}

function measureSingles(tools) {
  const all = readSingles()
  const singles = all.filter((single) => tools.target.elf || !single.elf)
  const lines = [...PREAMBLE, ...singles.map((single) => forTarget(single.clang, tools.target))]
  const sizes = measure(tools, lines, singles.length)
  return {
    skipped: all.length - singles.length,
    singles: singles.map((single, i) => {
      const entry = { asm: single.asm, bytes: sizes[i] }
      if (single.clang !== single.asm) entry.assembledAs = single.clang
      return entry
    }),
  }
}

function measureProgram(tools, program) {
  const lines = program.lines.map((line) => (typeof line === 'string' ? times(line, 1) : line))
  const isLabel = (text) => text.endsWith(':')
  /** A label or a `.equ` line: no machine code. */
  const takesNoSpace = (text) => isLabel(text) || text.startsWith('.equ ')

  // On Mach-O only labels that start with `L` are private to the file, and only jumps
  // to private labels get their final size from the assembler.
  const names = lines.filter((entry) => isLabel(entry.line)).map((entry) => entry.line.slice(0, -1))
  const rename = (text) => {
    if (tools.target.elf) return text
    let renamed = forTarget(text, tools.target)
    for (const name of names)
      renamed = renamed.replace(new RegExp(`\\b${name}\\b`, 'g'), `L${name}`)
    return renamed
  }

  const source = ['.intel_syntax noprefix', '.text']
  let expected = 0
  for (const entry of lines) {
    for (let i = 0; i < entry.count; i++) source.push(rename(entry.line))
    if (!takesNoSpace(entry.line)) expected += entry.count
  }
  const sizes = measure(tools, source, expected)

  let next = 0
  const measured = lines.map((entry) => {
    if (takesNoSpace(entry.line)) return { asm: entry.line, bytes: 0 }
    const own = sizes.slice(next, next + entry.count)
    next += entry.count
    if (own.some((size) => size !== own[0])) {
      throw new FixtureError(`copies of "${entry.line}" in "${program.name}" differ in size.`)
    }
    return entry.count === 1
      ? { asm: entry.line, bytes: own[0] }
      : { asm: entry.line, bytes: own[0], repeat: entry.count }
  })
  return { name: program.name, lines: measured }
}

/* ─────────────────────────────── Output ─────────────────────────────── */

/** One measured line as compact JSON: { "asm": "push rbx", "bytes": 1 } */
function row(entry) {
  const parts = [`"asm": ${JSON.stringify(entry.asm)}`, `"bytes": ${entry.bytes}`]
  if (entry.repeat !== undefined) parts.push(`"repeat": ${entry.repeat}`)
  if (entry.assembledAs !== undefined) {
    parts.push(`"assembledAs": ${JSON.stringify(entry.assembledAs)}`)
  }
  return `{ ${parts.join(', ')} }`
}

/** JSON with one entry per line, so a change shows up as a small diff. */
function toJson(fixture) {
  const list = (items, indent) => items.map((item) => `${indent}${item}`).join(',\n')
  const programs = fixture.programs.map((program) =>
    [
      '{',
      `      "name": ${JSON.stringify(program.name)},`,
      '      "lines": [',
      list(program.lines.map(row), '        '),
      '      ]',
      '    }',
    ].join('\n'),
  )
  return [
    '{',
    `  "about": ${JSON.stringify(fixture.about)},`,
    `  "assembler": ${JSON.stringify(fixture.assembler)},`,
    `  "target": ${JSON.stringify(fixture.target)},`,
    '  "preamble": [',
    list(
      fixture.preamble.map((line) => JSON.stringify(line)),
      '    ',
    ),
    '  ],',
    '  "singles": [',
    list(fixture.singles.map(row), '    '),
    '  ],',
    '  "programs": [',
    list(programs, '    '),
    '  ]',
    '}',
    '',
  ].join('\n')
}

function readArguments(argv) {
  const options = { out: DEFAULT_OUT, target: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') options.out = path.resolve(argv[++i] ?? '')
    else if (argv[i] === '--target') options.target = argv[++i] ?? ''
    else throw new FixtureError(`unknown option "${argv[i]}". Use --out <file> or --target <name>.`)
  }
  if (options.target !== null && !TARGETS.some((target) => target.key === options.target)) {
    const known = TARGETS.map((target) => target.key).join(' or ')
    throw new FixtureError(`unknown target "${options.target}". Use ${known}.`)
  }
  return options
}

function main() {
  const options = readArguments(process.argv.slice(2))
  const folder = mkdtempSync(path.join(tmpdir(), 'stack-step-sizes-'))
  try {
    const found = findTools(folder, options.target)
    if (found.problem) {
      console.log(`Skipped: ${found.problem}`)
      console.log('The size fixture was left as it is.')
      return
    }
    const tools = { folder, target: found.target, objdump: found.objdump }
    const { singles, skipped } = measureSingles(tools)
    const programs = PROGRAMS.map((program) => measureProgram(tools, program))

    const fixture = {
      about:
        'Instruction sizes measured with a real assembler. Made by scripts/make-size-fixture.mjs. Do not edit by hand.',
      assembler: found.assembler,
      target: found.target.name,
      preamble: PREAMBLE,
      singles,
      programs,
    }
    mkdirSync(path.dirname(options.out), { recursive: true })
    writeFileSync(options.out, toJson(fixture))

    const inPrograms = programs.reduce(
      (sum, program) => sum + program.lines.filter((line) => line.bytes > 0).length,
      0,
    )
    console.log(`Assembler: ${found.assembler} (${found.target.name}), ${found.objdump.join(' ')}`)
    console.log(`Measured ${singles.length} single instructions and ${programs.length} programs`)
    console.log(`(${inPrograms} more instruction lines).`)
    if (skipped > 0) {
      console.log(`Skipped ${skipped} lines that need the Linux target (absolute addresses).`)
    }
    const shown = path.relative(process.cwd(), options.out)
    console.log(`Wrote ${shown.startsWith('..') ? options.out : shown}`)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  if (!(error instanceof FixtureError)) throw error
  console.error(`make-size-fixture: ${error.message}`)
  process.exitCode = 1
}
