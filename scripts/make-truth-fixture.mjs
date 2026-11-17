#!/usr/bin/env node
/**
 * Ground truth for arithmetic, flags and register writes, taken from a real x86-64 CPU.
 *
 *   node scripts/make-truth-fixture.mjs            write the fixture
 *   node scripts/make-truth-fixture.mjs --check    compare with the fixture, write nothing
 *
 * Options
 *   --out <file>   write somewhere else (default: the fixture in the repo)
 *   --check        build and run, then say if the fixture on disk is still the same
 *   --keep         keep the folder with the generated program (its path is printed)
 *
 * What it does
 *   1. Writes a small x86-64 program (one assembly file plus a C driver) and builds it
 *      with `clang -arch x86_64 -O0`. On an Apple Silicon Mac it runs through Rosetta 2.
 *   2. For every test vector the program loads all sixteen registers and the flags, runs
 *      ONE real instruction (`add al, cl`, `mov ah, dl`, `jl …`), and prints all sixteen
 *      registers and RFLAGS afterwards as one JSON line.
 *   3. This script checks the program against answers that were worked out by hand,
 *      checks that nothing else changed, and writes
 *      `src/emulator/__fixtures__/alu-truth.json`.
 *      `src/emulator/alu.truth.test.ts` replays that file through the emulator on every
 *      `npm test`, so the tests need no compiler.
 *
 * The script never loads the emulator: the fixture holds only what the CPU did.
 *
 * Exit codes
 *   0  the fixture was written (or `--check` found it unchanged), OR this machine cannot
 *      build or run x86-64 code: then the script says so and leaves the fixture alone.
 *   1  something is wrong: the CPU's answers disagree with the hand-worked ones, a run
 *      was not repeatable, `--check` found a difference, or an option is unknown.
 *      Nothing is written.
 *
 * No packages are needed, only Node and clang.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, release, tmpdir, type as systemName } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT = path.join(REPO_ROOT, 'src/emulator/__fixtures__/alu-truth.json')
const GENERATED_BY = 'scripts/make-truth-fixture.mjs (do not edit by hand: run the script again)'

/** The script found a problem with its own program or with the CPU's answers. */
class HarnessError extends Error {}
/** The command line was not understood. */
class UsageError extends Error {}

/* ───────────────────────────── Numbers ───────────────────────────── */

const MASK64 = (1n << 64n) - 1n
const SIZES = [8, 16, 32, 64]

function maskOf(size) {
  return (1n << BigInt(size)) - 1n
}

function hex(value) {
  return `0x${value.toString(16)}`
}

/** A number as written in assembly: `5`, `-1`, `0x80000000`, `-0x80000000`. */
function readNumber(text) {
  if (!/^-?(0x[0-9a-f]+|[0-9]+)$/.test(text)) {
    throw new HarnessError(`"${text}" is not a number this script can read.`)
  }
  return text.startsWith('-') ? -BigInt(text.slice(1)) : BigInt(text)
}

/** Largest whole number whose square is not above `value`. */
function squareRoot(value) {
  let low = 0n
  let high = value + 1n
  while (high - low > 1n) {
    const middle = (low + high) / 2n
    if (middle * middle <= value) low = middle
    else high = middle
  }
  return low
}

/** Reads `eax 5 | rax -1 | …` (over several lines) into [['eax', '5'], ['rax', '-1'], …]. */
function rows(text) {
  return text
    .split(/[|\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => item.split(/\s+/))
}

/* ────────────────────────────── Flags ────────────────────────────── */

const CF = 0x001
const PF = 0x004
const AF = 0x010
const ZF = 0x040
const SF = 0x080
const OF = 0x800
const FLAG_BY_NAME = { CF, PF, AF, ZF, SF, OF }
/** The six status flags. The program changes only these bits of RFLAGS. */
const STATUS = CF | PF | AF | ZF | SF | OF
/** The four flags the emulator models. */
const MODELLED = CF | ZF | SF | OF
/** Every status flag except CF. */
const NOT_CARRY = STATUS & ~CF

function flagBit(word, flag) {
  return (word & flag) !== 0 ? 1 : 0
}

function flagText(word) {
  const one = (name) => `${name}=${flagBit(word, FLAG_BY_NAME[name])}`
  return ['CF', 'ZF', 'SF', 'OF'].map(one).join(' ')
}

/* ──────────────────────────── Registers ──────────────────────────── */

/** The sixteen registers in x86 encoding order. The program's buffers use this order. */
const BASES = [
  ...['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi'],
  ...['r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'],
]
const RAX = BASES.indexOf('rax')

/**
 * Every register name, and the 64-bit register and the bits this script believes it is.
 * This is the script's own table, not the emulator's, and the CPU checks it: a run fails
 * when an instruction changes a register other than the one named here, or when the
 * value that arrives is not the value that was sent.
 */
function buildRegisters() {
  const table = new Map()
  const add = (name, base, size, shift = 0) =>
    table.set(name, { name, base, index: BASES.indexOf(base), size, shift })
  for (const letter of ['a', 'b', 'c', 'd']) {
    const base = `r${letter}x`
    add(base, base, 64)
    add(`e${letter}x`, base, 32)
    add(`${letter}x`, base, 16)
    add(`${letter}l`, base, 8)
    add(`${letter}h`, base, 8, 8)
  }
  for (const stem of ['si', 'di', 'bp', 'sp']) {
    const base = `r${stem}`
    add(base, base, 64)
    add(`e${stem}`, base, 32)
    add(stem, base, 16)
    add(`${stem}l`, base, 8)
  }
  for (let n = 8; n <= 15; n++) {
    const base = `r${n}`
    add(base, base, 64)
    add(`${base}d`, base, 32)
    add(`${base}w`, base, 16)
    add(`${base}b`, base, 8)
  }
  return table
}

const REGISTERS = buildRegisters()

function register(name) {
  const found = REGISTERS.get(name)
  if (!found) throw new HarnessError(`this script does not know the register "${name}".`)
  return found
}

/** The name of the low `size` bits of a 64-bit register: (rax, 8) → al. */
function partName(base, size) {
  for (const entry of REGISTERS.values()) {
    if (entry.base === base && entry.size === size && entry.shift === 0) return entry.name
  }
  throw new HarnessError(`no ${size}-bit part of ${base}.`)
}

/** The bits of a 64-bit value that a register name stands for. */
function partOf(value, entry) {
  return (value >> BigInt(entry.shift)) & maskOf(entry.size)
}

/**
 * What a register holds when a vector does not use it: 0xd0d0…d0 for rax, 0xd1d1…d1 for
 * rcx, and so on. Each value is different, so an unwanted change is easy to see.
 */
const IDLE = BASES.map((_base, i) => BigInt(`0x${(0xd0 + i).toString(16).repeat(8)}`))

/** The two values that make the fixture easy to read. */
const START = 0x1111_2222_3333_4444n
const SOURCE = 0xaaaa_bbbb_cccc_ddeen

/* ──────────────────────── Repeatable random numbers ──────────────────────── */

/** "STACKSTE" in ASCII. Change it and every random vector changes. */
const SEED = 0x5354_4143_4b53_5445n

/** FNV-1a: turns a label into a number, so every group of vectors has its own sequence. */
function hashLabel(label) {
  let hash = 0xcbf2_9ce4_8422_2325n
  for (const character of label) {
    hash ^= BigInt(character.codePointAt(0) ?? 0)
    hash = (hash * 0x100_0000_01b3n) & MASK64
  }
  return hash
}

/** splitmix64. The same label always gives the same numbers. */
function makeRandom(label) {
  let state = SEED ^ hashLabel(label)
  const next = () => {
    state = (state + 0x9e37_79b9_7f4a_7c15n) & MASK64
    let z = state
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK64
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK64
    return z ^ (z >> 31n)
  }
  return {
    next,
    /** A value of `size` bits. */
    bits: (size) => next() & maskOf(size),
    /** A whole number from 0 to `limit - 1`. */
    below: (limit) => Number(next() % BigInt(limit)),
    bit: () => Number(next() & 1n),
  }
}

/**
 * A `size`-bit number with a random count of digits and a random sign. Plain random
 * numbers are almost always huge; these are small as often as they are large, so
 * `imul` sees products that fit and products that do not.
 */
function shortSigned(random, size) {
  const digits = 1 + random.below(size - 1)
  const magnitude = random.next() & maskOf(digits)
  return (random.bit() === 1 ? -magnitude : magnitude) & maskOf(size)
}

/** `value` in the low `size` bits and random bits above it. */
function withRandomTop(random, value, size) {
  if (size === 64) return value
  return ((random.next() << BigInt(size)) | value) & MASK64
}

/* ─────────────────────────── The test vectors ─────────────────────────── */

/**
 * The interesting values of one width: 0, 1, 2, the largest unsigned value and the one
 * below it, the largest signed value, the smallest signed value and the one above it,
 * 0x55…, 0xAA….
 */
function interestingValues(size) {
  const top = maskOf(size)
  const smallestSigned = 1n << BigInt(size - 1)
  return [
    0n,
    1n,
    2n,
    top,
    top - 1n,
    smallestSigned - 1n,
    smallestSigned,
    smallestSigned + 1n,
    0x5555_5555_5555_5555n & top,
    0xaaaa_aaaa_aaaa_aaaan & top,
  ]
}

/** A list of [a, b] pairs that never holds the same pair twice. */
function pairList() {
  const list = []
  const seen = new Set()
  /** Adds the pair and returns true, or returns false when the list already has it. */
  const add = (a, b) => {
    const key = `${a} ${b}`
    if (seen.has(key)) return false
    seen.add(key)
    list.push([a, b])
    return true
  }
  /** Adds `count` pairs from `make` that the list does not have yet. */
  const addNew = (count, make) => {
    for (let added = 0; added < count;) if (add(...make())) added += 1
  }
  return { list, add, addNew }
}

/**
 * Every pair of interesting values, then 40 random pairs (20 plain, 20 of mixed length).
 * A random pair that is already in the list does not count: at 8 bits that happens.
 */
function operandPairs(size) {
  const pairs = pairList()
  const values = interestingValues(size)
  for (const a of values) for (const b of values) pairs.add(a, b)
  const random = makeRandom(`pairs ${size}`)
  pairs.addNew(20, () => [random.bits(size), random.bits(size)])
  pairs.addNew(20, () => [shortSigned(random, size), shortSigned(random, size)])
  return pairs
}

/** Products right at the edge of what fits in `size` bits as a signed number. */
function imulEdgePairs(size) {
  const top = maskOf(size)
  const negative = (value) => -value & top
  const largest = (1n << BigInt(size - 1)) - 1n
  const root = squareRoot(largest)
  const half = 1n << BigInt(size / 2)
  const third = largest / 3n
  return [
    [root, root], // the largest square that fits
    [root + 1n, root + 1n], // the smallest square that does not fit
    [negative(root), root], // fits
    [negative(root + 1n), root + 1n], // does not fit
    [half, half >> 1n], // 2^(size-1): too big by one
    [negative(half), half >> 1n], // -2^(size-1): the smallest signed value, fits exactly
    [negative(half), negative(half >> 1n)], // 2^(size-1) again, from two negative numbers
    [3n, third], // just fits
    [3n, third + 1n], // just too big
    [negative(3n), third + 1n], // just too small
  ]
}

/** The arithmetic instructions, in the order they appear in the fixture. */
const ALU_ORDER = ['add', 'sub', 'and', 'or', 'xor', 'imul', 'inc', 'dec', 'cmp', 'test']
/** The ones with a single operand. */
const ONE_OPERAND = ['inc', 'dec']

/** The fourteen conditional jumps the emulator knows (other spellings are the same jumps). */
const JUMPS = [
  ...['je', 'jne', 'jg', 'jge', 'jl', 'jle'],
  ...['ja', 'jae', 'jb', 'jbe', 'js', 'jns', 'jo', 'jno'],
]

/**
 * `mov <register>, <number>`. The number is written exactly as in the instruction.
 * Negative numbers matter: `mov eax, -1` leaves 0x00000000ffffffff in rax.
 */
const IMMEDIATE_MOVES = rows(`
  eax 5          | rax 5          | ax 5                   | al 5      | ah 5
  eax -1         | rax -1         | ax -1                  | al -1     | ah -1
  eax 0          | rax 0          | eax 0x80000000         | rax 0x80000000
  eax 0xffffffff | rax 0xffffffff | rax 0x123456789abcdef0 | rax -0x80000000
  ax 0xffff      | al 0xff        | bh 0x80                | r8d -1    | r8 -1
  r9w 0x1234     | r12b -1        | sil -1                 | dil 0x7f  | esi -2
  r15d 0x7fffffff
`)

/**
 * Arithmetic with the number written in the instruction: `<op> <part of rax>, <number>`.
 * This is how students write `sub rsp, 16`, `add eax, -1` and `and rsp, -16`.
 * (`imul eax, -3` is the short way to write `imul eax, eax, -3`.)
 */
const IMMEDIATE_ARITHMETIC = rows(`
  add eax -1   | add rax -1    | add al -1           | add ax -2       | add rax 16 | add al 0xff
  sub rax 16   | sub eax -1    | sub al 1            | sub ax 0x8000
  and rax -16  | and eax 0xff  | and al 0x0f         | and ax -256
  or eax -1    | or al 0x80    | or rax 1
  xor rax -1   | xor al -1     | xor eax 0x80000000
  imul eax -3  | imul rax 10   | imul ax 0x100       | imul eax 0x10000
  cmp al -1    | cmp eax 5     | cmp rax -1          | cmp ax 0x7fff
  test eax -1  | test al 0x80  | test rax 1
`)

/** `mov` forms that READ ah, bh, ch or dh, or that use two names of one register. */
const EXTRA_MOVES = rows(`
  dl ah | dl bh | al ch | al dh
  al ah | ah al | bl bh | ch cl
`)

/** Destination and source of the `movzx` and `movsx` forms, by source width. */
const EXTEND_FROM_8 = rows(`
  ax cl  | r8w dl | eax cl | r8d dl   | esi dil
  eax ah | eax al | rax cl | r12 sil  | rax al
`)
const EXTEND_FROM_16 = rows('eax cx | r8d dx | eax ax | rax cx | r12 r9w | rax ax')
/** `movsxd`: 32 bits into 64. */
const EXTEND_FROM_32 = rows('rax ecx | r8 edx | rax eax | r12 r9d')

/** Source values for the extensions: around 0, around the sign bit, and all ones. */
const EXTEND_VALUES = {
  8: [0x00n, 0x01n, 0x7fn, 0x80n, 0xffn],
  16: [0x0000n, 0x0080n, 0x7fffn, 0x8000n, 0xffffn],
  32: [0x0000_0000n, 0x0000_8000n, 0x7fff_ffffn, 0x8000_0000n, 0xffff_ffffn],
}

/**
 * A few instructions whose answers are known without any tool: each row was worked out
 * by hand from the definition of the instruction. The rows test this script's program
 * (do registers and flags go in and come out in the right places?), not the emulator.
 *
 *   instruction | registers before | flags set before | register after | flags after | why
 *
 * `-` means none and `all` means all six status flags. "flags after" lists the flags
 * that must hold; a flag that is not listed is not checked (the `imul` rows leave SF and
 * ZF out). `same` means that no status flag may change. A jump row leaves 1 in rax when
 * the jump was taken and 0 when it was not.
 */
const HAND_CHECKED = `
  add al, cl      | rax=0x7f rcx=0x1                              | -        | rax=0x80               | CF=0 ZF=0 SF=1 OF=1 | 127 + 1 = 128 does not fit in a signed byte
  add al, cl      | rax=0xff rcx=0x1                              | SF OF    | rax=0x0                | CF=1 ZF=1 SF=0 OF=0 | 255 + 1 = 256 does not fit in a byte and wraps to 0
  sub al, cl      | rax=0x80 rcx=0x1                              | CF ZF    | rax=0x7f               | CF=0 ZF=0 SF=0 OF=1 | -128 - 1 does not fit in a signed byte
  sub eax, ecx    | rax=0x1111222200000000 rcx=0x1                | -        | rax=0xffffffff         | CF=1 ZF=0 SF=1 OF=0 | 0 - 1 borrows; a 32-bit write clears the top half
  and ax, cx      | rax=0x111122223333ff00 rcx=0xff               | all      | rax=0x1111222233330000 | CF=0 ZF=1 SF=0 OF=0 | no bit in common; a 16-bit write keeps the other 48 bits
  xor eax, eax    | rax=0x1111222233334444                        | all      | rax=0x0                | CF=0 ZF=1 SF=0 OF=0 | the usual way to make a register 0
  inc al          | rax=0xff                                      | CF       | rax=0x0                | CF=1 ZF=1 SF=0 OF=0 | 255 + 1 wraps to 0; CF stays 1
  inc al          | rax=0x7f                                      | -        | rax=0x80               | CF=0 ZF=0 SF=1 OF=1 | 127 + 1 = 128; CF stays 0
  dec rax         | rax=0x0                                       | CF       | rax=0xffffffffffffffff | CF=1 ZF=0 SF=1 OF=0 | 0 - 1 is all ones; CF stays 1
  dec al          | rax=0x80                                      | -        | rax=0x7f               | CF=0 ZF=0 SF=0 OF=1 | -128 - 1 does not fit in a signed byte; CF stays 0
  imul eax, ecx   | rax=0x7fffffff rcx=0x2                        | -        | rax=0xfffffffe         | CF=1 OF=1           | 2147483647 × 2 does not fit in 32 signed bits
  imul ax, cx     | rax=0x3 rcx=0x4                               | CF OF    | rax=0xc                | CF=0 OF=0           | 3 × 4 = 12 fits
  imul rax, rcx   | rax=0xffffffffffffffff rcx=0x5                | -        | rax=0xfffffffffffffffb | CF=0 OF=0           | -1 × 5 = -5 fits
  add eax, -1     | rax=0x1111222200000005                        | -        | rax=0x4                | CF=1 ZF=0 SF=0 OF=0 | -1 is 0xffffffff here: 5 + 0xffffffff carries and leaves 4
  and rax, -16    | rax=0x7ffffffddff8                            | all      | rax=0x7ffffffddff0     | CF=0 ZF=0 SF=0 OF=0 | -16 is all ones except the last four bits: rounds down to a multiple of 16
  imul eax, -3    | rax=0x7                                       | -        | rax=0xffffffeb         | CF=0 OF=0           | 7 × -3 = -21 fits
  cmp al, cl      | rax=0x1111222233334401 rcx=0x2                | -        | rax=0x1111222233334401 | CF=1 ZF=0 SF=1 OF=0 | 1 - 2 = -1: sets the flags, stores nothing
  test eax, ecx   | rax=0x1111222280000000 rcx=0x80000000         | CF ZF OF | rax=0x1111222280000000 | CF=0 ZF=0 SF=1 OF=0 | the top bit is in both: sets the flags, stores nothing
  mov eax, edx    | rax=0x1111222233334444 rdx=0xaaaabbbbccccddee | all      | rax=0xccccddee         | same                | a 32-bit write clears the top half
  mov ax, dx      | rax=0x1111222233334444 rdx=0xaaaabbbbccccddee | -        | rax=0x111122223333ddee | same                | a 16-bit write keeps the other 48 bits
  mov al, dl      | rax=0x1111222233334444 rdx=0xaaaabbbbccccddee | -        | rax=0x11112222333344ee | same                | an 8-bit write keeps the other 56 bits
  mov ah, dl      | rax=0x1111222233334444 rdx=0xaaaabbbbccccddee | all      | rax=0x111122223333ee44 | same                | ah is bits 15 to 8
  mov dl, ah      | rax=0x1111222233334444 rdx=0xaaaabbbbccccddee | -        | rdx=0xaaaabbbbccccdd44 | same                | reading ah
  mov spl, dl     | rsp=0x1111222233334444 rdx=0xaaaabbbbccccddee | -        | rsp=0x11112222333344ee | same                | spl is the low byte of rsp
  mov r8d, edx    | r8=0x1111222233334444 rdx=0xaaaabbbbccccddee  | -        | r8=0xccccddee          | same                | the 32-bit rule holds for r8 to r15 too
  mov eax, -1     | rax=0x1111222233334444                        | -        | rax=0xffffffff         | same                | a negative number in a 32-bit register: the top half is 0
  mov rax, -1     | rax=0x1111222233334444                        | -        | rax=0xffffffffffffffff | same                | a negative number in a 64-bit register: all ones
  movzx eax, cl   | rax=0x1111222233334444 rcx=0xaaaabbbbccccdd80 | -        | rax=0x80               | same                | 0x80 with zeros in front
  movsx eax, cl   | rax=0x1111222233334444 rcx=0xaaaabbbbccccdd80 | all      | rax=0xffffff80         | same                | 0x80 is -128: ones in front, but only up to bit 31
  movsx rax, cl   | rax=0x1111222233334444 rcx=0xaaaabbbbccccdd80 | -        | rax=0xffffffffffffff80 | same                | ones all the way up to bit 63
  movsxd rax, ecx | rax=0x1111222233334444 rcx=0xaaaabbbb80000000 | -        | rax=0xffffffff80000000 | same                | 0x80000000 is negative as a 32-bit number
  jl              | -                                             | SF       | rax=0x1                | same                | SF is not OF: jumps
  jl              | -                                             | SF OF    | rax=0x0                | same                | SF equals OF: does not jump
  je              | -                                             | ZF       | rax=0x1                | same                | ZF = 1: jumps
  ja              | -                                             | CF       | rax=0x0                | same                | CF = 1: not above
  jg              | -                                             | -        | rax=0x1                | same                | ZF = 0 and SF equals OF: jumps
`

function readHandChecked(table) {
  const cellsOf = (text) => (text === '-' ? [] : text.split(/\s+/))
  const assignment = (text) => {
    const [name, value] = text.split('=')
    if (!BASES.includes(name)) throw new HarnessError(`"${name}" is not a 64-bit register.`)
    return [name, readNumber(value ?? '')]
  }
  const flagWord = (text) => {
    if (text === 'all') return STATUS
    return cellsOf(text).reduce((word, name) => {
      if (FLAG_BY_NAME[name] === undefined) throw new HarnessError(`"${name}" is not a flag.`)
      return word | FLAG_BY_NAME[name]
    }, 0)
  }
  const rows = table.split('\n').filter((line) => line.trim() !== '')
  return rows.map((line) => {
    const cells = line.split('|').map((cell) => cell.trim())
    if (cells.length !== 6) throw new HarnessError(`cannot read the hand-worked row: ${line}`)
    const [insn, before, flagsBefore, after, flagsAfter, why] = cells
    const [reg, value] = assignment(after)
    return {
      insn,
      why,
      before: Object.fromEntries(cellsOf(before).map(assignment)),
      flags: flagWord(flagsBefore),
      reg,
      after: value,
      // `same`, or [['CF', 1], ['ZF', 0], …]
      flagsAfter:
        flagsAfter === 'same'
          ? 'same'
          : cellsOf(flagsAfter).map((text) => {
              const [name, bit] = text.split('=')
              if (FLAG_BY_NAME[name] === undefined || (bit !== '0' && bit !== '1')) {
                throw new HarnessError(`cannot read "${text}" in the hand-worked row: ${line}`)
              }
              return [name, Number(bit)]
            }),
    }
  })
}

/**
 * The plan: every routine (one instruction wrapped in the save-and-restore code) and
 * every case (one vector: which routine, which registers, which flags before).
 */
function buildPlan() {
  const routines = []
  const routineByText = new Map()
  const cases = []

  /** The number of the routine that runs `text`. `body` is for more than one line. */
  function routine(text, body = [text]) {
    let index = routineByText.get(text)
    if (index === undefined) {
      index = routines.length
      routines.push({ text, body })
      routineByText.set(text, index)
    }
    return index
  }

  /** Registers before a run: the idle values, then the ones the vector sets. */
  function registersWith(values) {
    const registers = [...IDLE]
    for (const [base, value] of Object.entries(values)) {
      const index = BASES.indexOf(base)
      if (index < 0) throw new HarnessError(`"${base}" is not a 64-bit register.`)
      registers[index] = value & MASK64
    }
    return registers
  }

  /**
   * Arithmetic: `<op> <part of rax>, <part of rcx>`, or `<op> <part of rax>` for inc and
   * dec, or `<op> <part of rax>, <number>` when `immediate` is given.
   * `whole: true` also records the whole 64-bit register.
   */
  function arithmetic(op, size, destBefore, srcBefore, cfIn, { whole = false, immediate } = {}) {
    const mask = maskOf(size)
    const destName = partName('rax', size)
    const unary = ONE_OPERAND.includes(op)
    const a = destBefore & mask
    const b = srcBefore & mask
    const values = { rax: destBefore }
    let text = `${op} ${destName}`
    if (immediate !== undefined) {
      text += `, ${immediate}`
    } else if (!unary) {
      text += `, ${partName('rcx', size)}`
      values.rcx = srcBefore
    }
    const jobs = [{ routine: routine(text), registers: registersWith(values) }]
    // The same sum with one register on both sides, such as `xor eax, eax`.
    if (!unary && immediate === undefined && a === b) {
      jobs.push({
        routine: routine(`${op} ${destName}, ${destName}`),
        registers: registersWith({ rax: destBefore }),
      })
    }
    // CF as the vector says, the other flags all 0 and all 1. For an instruction with
    // two operands CF must not matter either, so it also runs with the other CF.
    const presets = unary
      ? [cfIn, cfIn | NOT_CARRY]
      : [cfIn, cfIn | NOT_CARRY, cfIn ^ CF, (cfIn ^ CF) | NOT_CARRY]
    cases.push({
      family: 'alu',
      op,
      size,
      a,
      b: unary || immediate !== undefined ? null : b,
      imm: immediate ?? null,
      cfIn,
      whole,
      jobs,
      presets,
    })
  }

  for (const op of ALU_ORDER) {
    for (const size of SIZES) {
      if (op === 'imul' && size === 8) continue // x86 has no two-operand 8-bit imul
      const random = makeRandom(`${op} ${size}`)

      // Two vectors that also record the whole 64-bit register (not needed at 64 bits).
      if (size !== 64) {
        arithmetic(op, size, START, SOURCE, random.bit(), { whole: true })
        arithmetic(op, size, random.next(), random.next(), random.bit(), { whole: true })
      }

      if (ONE_OPERAND.includes(op)) {
        // The interesting values and six other values.
        const values = [...interestingValues(size)]
        while (values.length < 16) {
          const value = random.bits(size)
          if (!values.includes(value)) values.push(value)
        }
        for (const value of values) {
          for (const cfIn of [0, 1]) {
            arithmetic(op, size, withRandomTop(random, value, size), 0n, cfIn)
          }
        }
        continue
      }

      let pairs
      if (op === 'cmp' || op === 'test') {
        // "A few vectors": five interesting values against each other, and five random pairs.
        const all = interestingValues(size)
        const few = [all[0], all[1], all[3], all[5], all[6]]
        pairs = pairList()
        for (const a of few) for (const b of few) pairs.add(a, b)
        pairs.addNew(5, () => [random.bits(size), random.bits(size)])
      } else {
        pairs = operandPairs(size)
        if (op === 'imul') for (const [a, b] of imulEdgePairs(size)) pairs.add(a, b)
      }
      for (const [a, b] of pairs.list) {
        const destBefore = withRandomTop(random, a, size)
        const srcBefore = withRandomTop(random, b, size)
        arithmetic(op, size, destBefore, srcBefore, random.bit())
      }
    }

    // The same instruction with the number written in it, such as `add eax, -1`.
    for (const [immediateOp, destName, immediate] of IMMEDIATE_ARITHMETIC) {
      if (immediateOp !== op) continue
      const random = makeRandom(`${op} ${destName} ${immediate}`)
      const { size } = register(destName)
      if (destName !== partName('rax', size)) {
        throw new HarnessError(`arithmetic runs on a part of rax, not on ${destName}.`)
      }
      readNumber(immediate) // fails when the list above has a typing mistake
      for (const destBefore of [START, random.next()]) {
        arithmetic(op, size, destBefore, 0n, random.bit(), { immediate })
      }
    }
  }

  /* Register writes: `mov`, `movzx`, `movsx`, `movsxd`. */
  function move(op, destName, source, destBefore, srcBefore) {
    const dest = register(destName)
    const values = { [dest.base]: destBefore }
    let src = null
    if (source.kind === 'register') {
      src = register(source.name)
      if (src.base === dest.base && srcBefore !== destBefore) {
        throw new HarnessError(`${destName} and ${source.name} are one register.`)
      }
      values[src.base] = srcBefore
    }
    const text = `${op} ${destName}, ${source.kind === 'register' ? source.name : source.text}`
    cases.push({
      family: 'move',
      op,
      dest,
      destBefore,
      src,
      srcBefore: src === null ? null : srcBefore,
      imm: source.kind === 'register' ? null : source.text,
      jobs: [{ routine: routine(text), registers: registersWith(values) }],
      presets: [0, STATUS],
    })
  }

  // Every one of the 68 register names as the destination of a `mov`.
  for (const dest of REGISTERS.values()) {
    const random = makeRandom(`mov ${dest.name}`)
    const srcName = partName(dest.base === 'rdx' ? 'rcx' : 'rdx', dest.size)
    const source = { kind: 'register', name: srcName }
    move('mov', dest.name, source, START, SOURCE)
    move('mov', dest.name, source, START, MASK64)
    move('mov', dest.name, source, random.next(), 0n)
    move('mov', dest.name, source, random.next(), random.next())
  }
  for (const [destName, srcName] of EXTRA_MOVES) {
    const random = makeRandom(`mov ${destName} ${srcName}`)
    const source = { kind: 'register', name: srcName }
    const same = register(destName).base === register(srcName).base
    for (const [destBefore, srcBefore] of [
      [START, SOURCE],
      [SOURCE, START],
      [random.next(), random.next()],
    ]) {
      move('mov', destName, source, destBefore, same ? destBefore : srcBefore)
    }
  }
  for (const [destName, text] of IMMEDIATE_MOVES) {
    const random = makeRandom(`mov ${destName} ${text}`)
    const source = { kind: 'immediate', text }
    move('mov', destName, source, START, 0n)
    move('mov', destName, source, random.next(), 0n)
  }

  // Zero and sign extension.
  function extend(op, forms, fromSize) {
    for (const [destName, srcName] of forms) {
      const random = makeRandom(`${op} ${destName} ${srcName}`)
      const src = register(srcName)
      const same = register(destName).base === src.base
      const parts = [...EXTEND_VALUES[fromSize], random.bits(fromSize)]
      parts.forEach((part, i) => {
        // The value sits in the named part of the source; random bits fill the rest.
        const shift = BigInt(src.shift)
        const hole = (maskOf(fromSize) << shift) ^ MASK64
        const srcBefore = (random.next() & hole) | (part << shift)
        const destBefore = same ? srcBefore : i < 3 ? START : random.next()
        move(op, destName, { kind: 'register', name: srcName }, destBefore, srcBefore)
      })
    }
  }
  for (const op of ['movzx', 'movsx']) {
    extend(op, EXTEND_FROM_8, 8)
    extend(op, EXTEND_FROM_16, 16)
  }
  extend('movsxd', EXTEND_FROM_32, 32)

  /* Conditional jumps: all sixteen settings of the four flags. */
  for (const op of JUMPS) {
    for (let n = 0; n < 16; n++) {
      const flags =
        ((n & 8) !== 0 ? CF : 0) |
        ((n & 4) !== 0 ? ZF : 0) |
        ((n & 2) !== 0 ? SF : 0) |
        ((n & 1) !== 0 ? OF : 0)
      cases.push({
        family: 'jump',
        op,
        flags,
        jobs: [{ routine: jumpRoutine(routine, op), registers: registersWith({}) }],
        presets: [flags, flags | PF | AF],
      })
    }
  }

  /* Answers worked out by hand. */
  const byHand = readHandChecked(HAND_CHECKED).map((item) => ({
    item,
    routine: JUMPS.includes(item.insn) ? jumpRoutine(routine, item.insn) : routine(item.insn),
    registers: registersWith(item.before),
  }))

  return { routines, cases, byHand }
}

/** A jump routine leaves 1 in rax when the jump was taken and 0 when it was not. */
function jumpRoutine(routine, op) {
  return routine(op, [`${op} @taken`, 'mov eax, 0', 'jmp @done', '@taken:', 'mov eax, 1', '@done:'])
}

/* ───────────────────────── The x86-64 program ───────────────────────── */

/** Registers the C calling convention wants back unchanged. */
const CALLEE_SAVED = ['rbx', 'rbp', 'r12', 'r13', 'r14', 'r15']

/**
 * One routine: set the flags, load all sixteen registers, run the instruction, save all
 * sixteen registers and the flags. `mov`, `push` and `pop` do not change flags, so the
 * flags the instruction sees and leaves are exactly the ones we set and read.
 * rsp is loaded too. For those few instructions it holds a test value; nothing uses the
 * stack until it is restored.
 */
function routineLines(routine, index, localPrefix) {
  const label = (name) => `${localPrefix}truth_${name}_${index}`
  const body = routine.body.map((line) => line.replace(/@(\w+)/g, (_all, name) => label(name)))
  return [
    '',
    `# ${routine.text}`,
    '    .p2align 4',
    `truth_fn_${index}:`,
    ...CALLEE_SAVED.map((name) => `    push ${name}`),
    '    mov [rip + truth_saved_rsp], rsp',
    '    pushfq',
    '    pop rax',
    `    and rax, ${-(STATUS + 1)}`,
    '    mov rcx, [rip + truth_flags_in]',
    `    and ecx, ${STATUS}`,
    '    or rax, rcx',
    '    push rax',
    '    popfq',
    ...BASES.map((name, i) => `    mov ${name}, [rip + truth_regs_in + ${i * 8}]`),
    ...body.map((line) => (line.endsWith(':') ? line : `    ${line}`)),
    ...BASES.map((name, i) => `    mov [rip + truth_regs_out + ${i * 8}], ${name}`),
    '    mov rsp, [rip + truth_saved_rsp]',
    '    pushfq',
    '    pop qword ptr [rip + truth_flags_out]',
    ...[...CALLEE_SAVED].reverse().map((name) => `    pop ${name}`),
    '    ret',
  ]
}

function assemblySource(routines, elf) {
  const lines = [
    '# Made by scripts/make-truth-fixture.mjs. One routine per instruction under test.',
    '.intel_syntax noprefix',
    '',
    '.data',
    '    .p2align 3',
    '    .globl truth_regs_in',
    'truth_regs_in:',
    '    .space 128',
    '    .globl truth_regs_out',
    'truth_regs_out:',
    '    .space 128',
    '    .globl truth_flags_in',
    'truth_flags_in:',
    '    .quad 0',
    '    .globl truth_flags_out',
    'truth_flags_out:',
    '    .quad 0',
    'truth_saved_rsp:',
    '    .quad 0',
    '    .globl truth_count',
    'truth_count:',
    `    .quad ${routines.length}`,
    '    .globl truth_table',
    'truth_table:',
    ...routines.map((_routine, i) => `    .quad truth_fn_${i}`),
    '',
    '.text',
  ]
  routines.forEach((routine, i) => lines.push(...routineLines(routine, i, elf ? '.L' : 'L')))
  if (elf) lines.push('', '.section .note.GNU-stack,"",@progbits')
  return `${lines.join('\n')}\n`
}

/**
 * The C driver. It reads one line per run from standard input:
 *   <id> <routine number> <flags, hex> <sixteen registers, hex>
 * and prints one JSON line per run. The first line it prints describes the CPU.
 */
const DRIVER_SOURCE = String.raw`/* Made by scripts/make-truth-fixture.mjs. */
#include <cpuid.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(__APPLE__)
#include <sys/sysctl.h>
#endif

extern uint64_t truth_regs_in[16] __asm__("truth_regs_in");
extern uint64_t truth_regs_out[16] __asm__("truth_regs_out");
extern uint64_t truth_flags_in __asm__("truth_flags_in");
extern uint64_t truth_flags_out __asm__("truth_flags_out");
extern void (*const truth_table[])(void) __asm__("truth_table");
extern const uint64_t truth_count __asm__("truth_count");

/* The CPU's own name for itself (CPUID leaves 0x80000002 to 0x80000004). */
static void cpu_brand(char *text) {
  unsigned int words[12];
  memset(words, 0, sizeof words);
  if (__get_cpuid_max(0x80000000u, NULL) >= 0x80000004u) {
    for (unsigned int i = 0; i < 3; i++) {
      __get_cpuid(0x80000002u + i, &words[i * 4], &words[i * 4 + 1], &words[i * 4 + 2],
                  &words[i * 4 + 3]);
    }
  }
  memcpy(text, words, 48);
  text[48] = '\0';
  for (char *c = text; *c != '\0'; c++) {
    if (*c < 0x20 || *c > 0x7e || *c == '"' || *c == '\\') *c = ' ';
  }
}

/* 1 when macOS runs this program through Rosetta, 0 when it does not, -1 when unknown. */
static int is_translated(void) {
#if defined(__APPLE__)
  int value = 0;
  size_t size = sizeof value;
  if (sysctlbyname("sysctl.proc_translated", &value, &size, NULL, 0) != 0) return -1;
  return value;
#else
  return 0;
#endif
}

static void print_registers(const char *name, const uint64_t *values) {
  printf(",\"%s\":[", name);
  for (int i = 0; i < 16; i++) printf("%s\"0x%" PRIx64 "\"", i == 0 ? "" : ",", values[i]);
  printf("]");
}

int main(void) {
  char brand[49];
  char line[1024];
  cpu_brand(brand);
  printf("{\"routines\":%" PRIu64 ",\"translated\":%d,\"brand\":\"%s\"}\n", truth_count,
         is_translated(), brand);

  while (fgets(line, sizeof line, stdin) != NULL) {
    char *cursor = line;
    char *end = NULL;
    uint64_t fields[19];
    for (int i = 0; i < 19; i++) {
      fields[i] = strtoull(cursor, &end, i < 2 ? 10 : 16);
      if (end == cursor) {
        fprintf(stderr, "cannot read field %d of the line: %s", i, line);
        return 2;
      }
      cursor = end;
    }
    if (fields[1] >= truth_count) {
      fprintf(stderr, "there is no routine %" PRIu64 "\n", fields[1]);
      return 2;
    }
    truth_flags_in = fields[2];
    truth_flags_out = 0;
    for (int i = 0; i < 16; i++) {
      truth_regs_in[i] = fields[3 + i];
      truth_regs_out[i] = 0;
    }

    truth_table[fields[1]]();

    printf("{\"id\":%" PRIu64 ",\"routine\":%" PRIu64 ",\"flagsIn\":\"0x%" PRIx64
           "\",\"flagsOut\":\"0x%" PRIx64 "\"",
           fields[0], fields[1], truth_flags_in, truth_flags_out);
    print_registers("in", truth_regs_in);
    print_registers("out", truth_regs_out);
    printf("}\n");
  }
  return 0;
}
`

/** The smallest program that proves "this machine builds and runs x86-64 code". */
const PROBE_SOURCE = String.raw`#include <stdio.h>
int main(void) {
#if defined(__x86_64__)
  puts("x86_64");
  return 0;
#else
  puts("not x86_64");
  return 1;
#endif
}
`

/* ───────────────────────── Building and running ───────────────────────── */

/** Run a program to the end. Never throws: `ok` is false when anything went wrong. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout: 180_000,
    ...options,
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const said = typeof result.stderr === 'string' ? result.stderr.trim() : ''
  const stopped = result.signal ? `stopped by ${result.signal}` : ''
  if (result.error) {
    // The program did not start, ran too long, or stopped reading its input.
    const stderr = [said, stopped, result.error.message].filter((part) => part !== '').join('; ')
    return { ok: false, stdout, stderr }
  }
  if (result.status === null) {
    return { ok: false, stdout, stderr: [stopped, said].filter((part) => part !== '').join('; ') }
  }
  return { ok: result.status === 0, stdout, stderr: said }
}

function firstLine(text) {
  return text.trim().split('\n')[0] ?? ''
}

/**
 * Can this machine build and run x86-64 code?
 * Returns `{ flags, elf, compiler }`, or `{ problem }` with a sentence for the user.
 */
function findToolchain(folder) {
  const version = run('clang', ['--version'])
  if (!version.ok) return { problem: 'clang was not found (or does not start).' }

  let flags
  if (process.platform === 'darwin') flags = ['-arch', 'x86_64']
  else if (process.arch === 'x64') flags = ['-m64']
  else {
    const machine = `${process.platform}, ${process.arch}`
    return { problem: `this machine (${machine}) is not x86-64 and has no Rosetta.` }
  }

  const source = path.join(folder, 'probe.c')
  const binary = path.join(folder, 'probe')
  writeFileSync(source, PROBE_SOURCE)
  const built = run('clang', [...flags, '-O0', '-o', binary, source])
  if (!built.ok) {
    return { problem: `clang cannot build x86-64 programs here: ${firstLine(built.stderr)}` }
  }
  const ran = run(binary, [])
  if (ran.stdout.trim() === 'not x86_64') {
    return { problem: 'clang built a program for another kind of CPU, not for x86-64.' }
  }
  if (!ran.ok || ran.stdout.trim() !== 'x86_64') {
    const hint =
      process.platform === 'darwin' && process.arch === 'arm64'
        ? ' Rosetta 2 may be missing: `softwareupdate --install-rosetta` installs it.'
        : ''
    const detail = firstLine(ran.stderr) || firstLine(ran.stdout) || 'no output'
    return { problem: `this machine cannot run x86-64 programs (${detail}).${hint}` }
  }
  return { flags, elf: process.platform !== 'darwin', compiler: firstLine(version.stdout) }
}

/** Write the program, build it, and return the path of the binary. */
function buildHarness(folder, tools, plan) {
  const assembly = path.join(folder, 'truth.s')
  const driver = path.join(folder, 'driver.c')
  const binary = path.join(folder, 'truth')
  writeFileSync(assembly, assemblySource(plan.routines, tools.elf))
  writeFileSync(driver, DRIVER_SOURCE)
  const built = run('clang', [...tools.flags, '-O0', '-Wall', '-o', binary, driver, assembly])
  if (!built.ok) {
    throw new HarnessError(`clang could not build the test program:\n${built.stderr.trim()}`)
  }
  return binary
}

/**
 * Run every job of every case with every flag setting.
 * Returns `{ cpu, answers }`; `answers[id]` belongs to `runs[id]`.
 */
function runHarness(binary, runs) {
  const input = runs
    .map((one, id) => {
      const registers = one.registers.map((value) => value.toString(16)).join(' ')
      return `${id} ${one.routine} ${one.flags.toString(16)} ${registers}\n`
    })
    .join('')
  const result = run(binary, [], { input })
  if (!result.ok) {
    throw new HarnessError(`the test program failed: ${result.stderr.trim() || 'no message'}`)
  }
  const lines = result.stdout.split('\n').filter((line) => line !== '')
  if (lines.length !== runs.length + 1) {
    throw new HarnessError(`expected ${runs.length + 1} lines of output, got ${lines.length}.`)
  }
  const cpu = JSON.parse(lines[0])
  const answers = runs.map((one, id) => {
    const answer = JSON.parse(lines[id + 1])
    // The program repeats what it was given, so a misread line cannot go unnoticed.
    const echoed =
      answer.id === id &&
      answer.routine === one.routine &&
      Number.parseInt(answer.flagsIn, 16) === one.flags &&
      answer.in.length === 16 &&
      answer.in.every((text, i) => BigInt(text) === one.registers[i])
    if (!echoed) {
      throw new HarnessError(`run ${id} came back with different input: ${lines[id + 1]}`)
    }
    return {
      flags: Number.parseInt(answer.flagsOut, 16),
      registers: answer.out.map((text) => BigInt(text)),
    }
  })
  return { cpu, answers }
}

/* ───────────────────────── Checking and collecting ───────────────────────── */

/** Give every job of every case (and every hand-worked row) its runs. */
function listRuns(plan) {
  const runs = []
  for (const one of plan.cases) {
    for (const job of one.jobs) {
      job.runIds = one.presets.map((flags) => {
        runs.push({ routine: job.routine, registers: job.registers, flags })
        return runs.length - 1
      })
    }
  }
  for (const entry of plan.byHand) {
    runs.push({ routine: entry.routine, registers: entry.registers, flags: entry.item.flags })
    entry.runId = runs.length - 1
  }
  return runs
}

/** Compare the program with the answers worked out by hand. */
function checkByHand(plan, answers) {
  const problems = []
  for (const { item, registers, runId } of plan.byHand) {
    const answer = answers[runId]
    const index = BASES.indexOf(item.reg)
    const complain = (text) => problems.push(`  ${item.insn} (${item.why}): ${text}`)
    const got = answer.registers[index]
    if (got !== item.after) {
      complain(`${item.reg} should be ${hex(item.after)}, the CPU gave ${hex(got)}`)
    }
    answer.registers.forEach((value, i) => {
      if (i !== index && value !== registers[i]) complain(`${BASES[i]} changed to ${hex(value)}`)
    })
    if (item.flagsAfter === 'same') {
      if ((answer.flags & STATUS) !== item.flags) {
        complain(`the flags changed from ${hex(item.flags)} to ${hex(answer.flags & STATUS)}`)
      }
    } else {
      for (const [name, wanted] of item.flagsAfter) {
        const bit = flagBit(answer.flags, FLAG_BY_NAME[name])
        if (bit !== wanted) complain(`${name} should be ${wanted}, the CPU gave ${bit}`)
      }
    }
  }
  if (problems.length > 0) {
    throw new HarnessError(
      `the test program does not give the answers worked out by hand:\n${problems.join('\n')}`,
    )
  }
}

/** Fail when a run changed a register other than `destIndex`. */
function expectOthersUnchanged(text, job, answer, destIndex) {
  answer.registers.forEach((value, i) => {
    if (i !== destIndex && value !== job.registers[i]) {
      throw new HarnessError(
        `${text}: ${BASES[i]} changed from ${hex(job.registers[i])} to ${hex(value)}.`,
      )
    }
  })
}

/** One arithmetic case → one vector. */
function collectArithmetic(plan, one, answers, notes) {
  const mask = maskOf(one.size)
  const first = answers[one.jobs[0].runIds[0]]
  const defined = one.op === 'imul' ? CF | OF : MODELLED
  const storesNothing = one.op === 'cmp' || one.op === 'test'

  for (const job of one.jobs) {
    const text = plan.routines[job.routine].text
    job.runIds.forEach((id, i) => {
      const answer = answers[id]
      const preset = `flags ${hex(one.presets[i])} before`
      expectOthersUnchanged(text, job, answer, RAX)

      // The rest of rax. Most vectors do not record it, so it is checked here, on every
      // run: that makes the sentence about it in the fixture's notes true.
      const before = job.registers[RAX]
      const after = answer.registers[RAX]
      const restKept = (after & ~mask & MASK64) === (before & ~mask & MASK64)
      const followsRule = storesNothing
        ? after === before
        : one.size === 32
          ? after >> 32n === 0n
          : restKept
      if (!followsRule) {
        throw new HarnessError(`${text}: rax went from ${hex(before)} to ${hex(after)}.`)
      }

      // The same answer whatever the flags were before.
      if ((after & mask) !== (first.registers[RAX] & mask)) {
        throw new HarnessError(`${text} (${preset}): the result is not repeatable.`)
      }
      if ((answer.flags & defined) !== (first.flags & defined)) {
        throw new HarnessError(
          `${text} (${preset}): ${flagText(answer.flags)}, but ${flagText(first.flags)} ` +
            `with flags ${hex(one.presets[0])} before.`,
        )
      }
      if (one.op === 'imul' && (answer.flags & (SF | ZF)) !== (first.flags & (SF | ZF))) {
        notes.imulDependsOnFlagsBefore.add(one)
      }
    })
  }

  const result = first.registers[RAX] & mask
  const vector = { op: one.op, size: one.size, a: hex(one.a) }
  if (one.imm !== null) vector.imm = one.imm
  else if (one.b !== null) vector.b = hex(one.b)
  Object.assign(vector, {
    cfIn: one.cfIn,
    result: hex(result),
    cf: flagBit(first.flags, CF),
    zf: flagBit(first.flags, ZF),
    sf: flagBit(first.flags, SF),
    of: flagBit(first.flags, OF),
  })
  if (one.whole) {
    Object.assign(vector, {
      dest: partName('rax', one.size),
      destReg: 'rax',
      destBefore: hex(one.jobs[0].registers[RAX]),
      destAfter: hex(first.registers[RAX]),
    })
  }
  if (one.op === 'imul') {
    const negative = (result >> BigInt(one.size - 1)) & 1n
    notes.imul.count += 1
    notes.imul.sfSet += vector.sf
    notes.imul.zfSet += vector.zf
    notes.imul.negativeResults += Number(negative)
    notes.imul.zeroResults += result === 0n ? 1 : 0
    notes.imul.sfLikeResult += vector.sf === Number(negative) ? 1 : 0
    notes.imul.zfLikeResult += vector.zf === (result === 0n ? 1 : 0) ? 1 : 0
  }
  return vector
}

/** One `mov`, `movzx`, `movsx` or `movsxd` case → one vector. */
function collectMove(plan, one, answers) {
  const job = one.jobs[0]
  const text = plan.routines[job.routine].text
  const first = answers[job.runIds[0]]
  const destAfter = first.registers[one.dest.index]
  job.runIds.forEach((id, i) => {
    const answer = answers[id]
    expectOthersUnchanged(text, job, answer, one.dest.index)
    if (answer.registers[one.dest.index] !== destAfter) {
      throw new HarnessError(`${text}: the result is not repeatable.`)
    }
    if ((answer.flags & STATUS) !== one.presets[i]) {
      throw new HarnessError(`${text}: the flags changed from ${hex(one.presets[i])}.`)
    }
  })

  // Did the value that was sent arrive? This checks the script's own register table
  // (which register and which bits a name stands for), not the rule for the other bits:
  // those are in `destAfter` for the emulator test to judge.
  const sent =
    one.src === null ? readNumber(one.imm) & maskOf(one.dest.size) : partOf(one.srcBefore, one.src)
  const sentBits = one.src === null ? one.dest.size : one.src.size
  if ((partOf(destAfter, one.dest) & maskOf(sentBits)) !== sent) {
    throw new HarnessError(`${text}: sent ${hex(sent)}, but ${one.dest.name} holds something else.`)
  }

  const vector = { op: one.op, dest: one.dest.name, destReg: one.dest.base }
  if (one.src === null) {
    vector.imm = one.imm
    vector.destBefore = hex(one.destBefore)
  } else {
    Object.assign(vector, {
      src: one.src.name,
      srcReg: one.src.base,
      destBefore: hex(one.destBefore),
      srcBefore: hex(one.srcBefore),
    })
  }
  vector.destAfter = hex(destAfter)
  return vector
}

/** One conditional jump with one setting of the flags → one vector. */
function collectJump(plan, one, answers) {
  const job = one.jobs[0]
  const first = answers[job.runIds[0]]
  job.runIds.forEach((id, i) => {
    const answer = answers[id]
    expectOthersUnchanged(one.op, job, answer, RAX)
    if (answer.registers[RAX] !== first.registers[RAX] || answer.registers[RAX] > 1n) {
      throw new HarnessError(`${one.op} with flags ${hex(one.presets[i])}: no clear answer.`)
    }
    if ((answer.flags & STATUS) !== one.presets[i]) {
      throw new HarnessError(`${one.op}: the flags changed from ${hex(one.presets[i])}.`)
    }
  })
  return {
    op: one.op,
    cfIn: flagBit(one.flags, CF),
    zfIn: flagBit(one.flags, ZF),
    sfIn: flagBit(one.flags, SF),
    ofIn: flagBit(one.flags, OF),
    taken: Number(first.registers[RAX]),
  }
}

function collectVectors(plan, answers) {
  const imul = { count: 0, sfSet: 0, zfSet: 0, negativeResults: 0, zeroResults: 0 }
  const notes = {
    imul: { ...imul, sfLikeResult: 0, zfLikeResult: 0 },
    imulDependsOnFlagsBefore: new Set(),
  }
  const vectors = plan.cases.map((one) => {
    if (one.family === 'alu') return collectArithmetic(plan, one, answers, notes)
    if (one.family === 'move') return collectMove(plan, one, answers)
    return collectJump(plan, one, answers)
  })
  return { vectors, notes }
}

/* ─────────────────────────────── Output ─────────────────────────────── */

function describeHost(cpu, tools) {
  const machine = cpus()[0]?.model ?? 'an unknown CPU'
  let system = `${systemName()} ${release()}`
  if (process.platform === 'darwin') {
    const version = run('sw_vers', ['-productVersion'])
    if (version.ok) system = `macOS ${version.stdout.trim()} (${system})`
  }
  const brand = String(cpu.brand).trim()
  // The program says 1 when macOS translates it. When it cannot tell (-1), an Apple
  // Silicon Mac still has only one way to run x86-64 code.
  const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64'
  const translated = cpu.translated === 1 || (cpu.translated !== 0 && appleSilicon)
  const how = translated
    ? `x86-64 instructions run through Rosetta 2 on ${machine} ` +
      `(the x86-64 CPU calls itself "${brand}")`
    : `x86-64 instructions run directly on ${brand === '' ? machine : brand}`
  return `${how}; ${system}; built with ${tools.compiler}`
}

function describeImul(notes) {
  const { count, sfSet, zfSet, sfLikeResult, zfLikeResult, zeroResults, negativeResults } =
    notes.imul
  const depends = notes.imulDependsOnFlagsBefore.size
  return (
    `imul: Intel's manual says SF and ZF are undefined after imul, so the sf and zf of an imul ` +
    `vector are only what this machine did. In ${count} imul vectors the result was negative ` +
    `in ${negativeResults} and zero in ${zeroResults}; SF was 1 in ${sfSet} and ZF was 1 in ` +
    `${zfSet}; SF equalled the top bit of the result in ${sfLikeResult} and ZF equalled ` +
    `"the result is 0" in ${zfLikeResult}. ` +
    (depends === 0
      ? 'They did not depend on the flags before.'
      : `They changed with the flags before in ${depends} vectors (written here: CF = cfIn ` +
        `and all other flags 0 before).`)
  )
}

function fixtureNotes(notes) {
  return [
    'One vector is one real instruction. The script loaded all sixteen registers and the ' +
      'flags, ran the instruction, and read everything back. No register other than the ' +
      'destination changed.',
    'Arithmetic vectors (size, a, b): the instruction was <op> <part of rax>, <part of rcx>, ' +
      'for example add al, cl (inc and dec have no b). The other bits of both registers held ' +
      'random values: 8-bit and 16-bit instructions left the other bits of rax alone, 32-bit ' +
      'instructions cleared the top half. When a equals b the instruction also ran with one ' +
      'register on both sides, for example xor eax, eax, with the same answer. result is the ' +
      'low size bits of rax afterwards; cmp and test store nothing, so their result equals a. ' +
      'An arithmetic vector with imm in place of b had that number written in the ' +
      'instruction, for example add eax, -1. An arithmetic vector with dest also records the ' +
      'whole 64-bit register (destReg) before and after.',
    'Flags: CF was cfIn before the instruction. Every arithmetic vector also ran with ZF, SF, ' +
      'OF, PF and AF all 0 and all 1 beforehand, and every one except inc and dec with the ' +
      'other value of CF too. The result and the flags written here were the same in every run ' +
      '(the sf and zf of imul are a special case: see the next note).',
    describeImul(notes),
    'Register vectors (mov, movzx, movsx, movsxd): destReg is the 64-bit register that holds ' +
      'dest. It held destBefore; the instruction was <op> <dest>, <src> (or <op> <dest>, <imm>); ' +
      'afterwards it held destAfter. srcReg is the 64-bit register that holds src, and ' +
      'srcBefore is its whole value. These instructions changed no flag.',
    'Jump vectors (taken): the flags were set to cfIn, zfIn, sfIn, ofIn (once with PF and AF ' +
      '0 and once with both 1), then the jump ran. taken is 1 when it jumped. A jump changed ' +
      'no flag.',
  ]
}

/** JSON with one vector per line, so a change shows up as a small diff. */
function toJson(fixture) {
  const line = (vector) =>
    `    { ${Object.entries(vector)
      .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join(', ')} }`
  return [
    '{',
    `  "generatedBy": ${JSON.stringify(fixture.generatedBy)},`,
    `  "host": ${JSON.stringify(fixture.host)},`,
    `  "seed": ${JSON.stringify(fixture.seed)},`,
    '  "notes": [',
    fixture.notes.map((note) => `    ${JSON.stringify(note)}`).join(',\n'),
    '  ],',
    '  "vectors": [',
    fixture.vectors.map(line).join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n')
}

function countByOperation(vectors) {
  const counts = new Map()
  for (const vector of vectors) counts.set(vector.op, (counts.get(vector.op) ?? 0) + 1)
  return [...counts].map(([op, count]) => `${op} ${count}`).join(', ')
}

/** Replace the file in one step, so a failure never leaves half a fixture behind. */
function writeFixture(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, text)
  renameSync(temporary, file)
}

function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function withoutHostLine(text) {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('  "host": '))
    .join('\n')
}

/* ──────────────────────────────── Main ──────────────────────────────── */

function readArguments(argv) {
  const options = { out: DEFAULT_OUT, check: false, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]
    if (argument === '--check') options.check = true
    else if (argument === '--keep') options.keep = true
    else if (argument === '--out') {
      const value = argv[++i]
      if (value === undefined) throw new UsageError('--out needs a file name.')
      options.out = path.resolve(value)
    } else {
      throw new UsageError(`unknown option "${argument}". Use --out <file>, --check or --keep.`)
    }
  }
  return options
}

function main(argv) {
  const options = readArguments(argv)
  const plan = buildPlan()
  const runs = listRuns(plan)
  // A short name for messages: the path from here, unless the file is somewhere else.
  const fromHere = path.relative(process.cwd(), options.out)
  const shown = fromHere === '' || fromHere.startsWith('..') ? options.out : fromHere

  const folder = mkdtempSync(path.join(tmpdir(), 'stack-step-truth-'))
  try {
    const tools = findToolchain(folder)
    if (tools.problem !== undefined) {
      console.log(`Cannot get answers from a real x86-64 CPU: ${tools.problem}`)
      console.log(`Nothing was written. ${shown} is unchanged.`)
      return 0
    }

    const binary = buildHarness(folder, tools, plan)
    const { cpu, answers } = runHarness(binary, runs)
    if (cpu.routines !== plan.routines.length) {
      throw new HarnessError('the test program has a different number of routines.')
    }
    checkByHand(plan, answers)
    const { vectors, notes } = collectVectors(plan, answers)

    const fixture = {
      generatedBy: GENERATED_BY,
      host: describeHost(cpu, tools),
      seed: hex(SEED),
      notes: fixtureNotes(notes),
      vectors,
    }
    const text = toJson(fixture)
    if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(fixture)) {
      throw new HarnessError('the JSON text does not read back as the fixture.')
    }

    console.log(fixture.host)
    console.log(
      `${runs.length} runs of ${plan.routines.length} different instructions; ` +
        `${plan.byHand.length} answers worked out by hand all match.`,
    )
    console.log(`${vectors.length} vectors: ${countByOperation(vectors)}`)
    console.log(describeImul(notes))

    if (options.check) {
      const existing = readOrNull(options.out)
      if (existing === text) {
        console.log(`${shown} is up to date.`)
        return 0
      }
      if (existing !== null && withoutHostLine(existing) === withoutHostLine(text)) {
        console.log(`${shown} has the same vectors. Only the "host" line is different.`)
        return 0
      }
      console.log(
        existing === null
          ? `${shown} does not exist.`
          : `${shown} is DIFFERENT from what this machine gives. Nothing was written.`,
      )
      return 1
    }

    writeFixture(options.out, text)
    console.log(`Wrote ${shown} (${Math.round(text.length / 1024)} KB).`)
    return 0
  } finally {
    if (options.keep) console.log(`The generated program is in ${folder}`)
    else rmSync(folder, { recursive: true, force: true })
  }
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  if (!(error instanceof HarnessError) && !(error instanceof UsageError)) throw error
  console.error(`make-truth-fixture: ${error.message}`)
  console.error('Nothing was written.')
  process.exitCode = 1
}
