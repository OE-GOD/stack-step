/**
 * Where is rip while an instruction runs, and after a jump?
 *
 * Three forms:
 * - A: one instruction, its address and its size: "While it runs, rip = ?"
 * - B: 3–4 lines with the address of the first one and each size in a comment:
 *      "Address of line p?" and "rip while line q runs?"
 * - C: a listing with addresses and one `jmp` or conditional jump (the flags stated
 *      plainly): "rip after this line runs?"
 *
 * Sizes come from the assembler; every answer comes from running the program in the
 * emulator (small world: code at 0x4000 … 0x4ff0).
 */
import {
  assemble,
  conditionHolds,
  describeCondition,
  FLAG_NAMES,
  joinAnd,
  subRegister,
  type FlagName,
  type Flags,
  type JumpCondition,
  type OperandSize,
  type Reg64,
} from '../../../emulator'
import { createRng, type Rng } from '../../../lib/rng'
import {
  answerIs,
  codeBlock,
  decimalSlip,
  FREE_REGISTERS,
  hexField,
  lineAddresses,
  pickRegisters,
  random64,
  runProgram,
  show,
  SMALL_WORLD,
  smallWorld,
  stepAtLine,
  textBlock,
} from '../gen/helpers'
import type { Field, Problem, ProblemGenerator, PromptBlock } from '../types'

/* ─────────────────────────── instructions to ask about ───────────────────── */

interface Line {
  /** The instruction as shown, e.g. "mov eax, 7". */
  text: string
  /** A line the stepper program needs later so it ends cleanly (the `pop` for a `push`). */
  undo?: string
  /** Uses memory at rbp − 8 … rbp − 1, so rbp must point into the stack. */
  frame?: boolean
  /** Uses the label `message` (a short string placed after the code). */
  message?: boolean
  /** Writes no flags and leaves rsp alone (safe right before a conditional jump). */
  quiet?: boolean
}

const name = (reg: Reg64, size: OperandSize): string => subRegister(reg, size).name
const register = (rng: Rng, size: OperandSize): string => name(rng.pick(FREE_REGISTERS), size)
/** A small number that is pleasant to read. */
const small = (rng: Rng): number => rng.int(2, 99)

/** The low byte of rax/rbx/rcx/rdx, which every beginner knows. */
const LOW_BYTES = ['al', 'bl', 'cl', 'dl'] as const

/**
 * Real instruction forms of many different sizes (1 to 10 bytes). The sizes are not
 * written here: the assembler gives them.
 */
const LINE_MAKERS: readonly ((rng: Rng) => Line)[] = [
  (rng) => ({ text: `mov ${register(rng, 32)}, ${small(rng)}`, quiet: true }),
  (rng) => ({ text: `mov ${register(rng, 64)}, ${small(rng)}`, quiet: true }),
  (rng) => ({ text: `mov ${register(rng, 64)}, ${show(random64(rng))}`, quiet: true }),
  (rng) => ({ text: `mov ${rng.pick(LOW_BYTES)}, ${small(rng)}`, quiet: true }),
  (rng) => ({ text: `mov ${register(rng, 16)}, ${small(rng)}`, quiet: true }),
  (rng) => {
    const [a, b] = pickRegisters(rng, 2)
    return { text: `mov ${a}, ${b}`, quiet: true }
  },
  (rng) => {
    const [a, b] = pickRegisters(rng, 2)
    return { text: `mov ${name(a, 32)}, ${name(b, 32)}`, quiet: true }
  },
  (rng) => ({ text: `add ${register(rng, 32)}, ${small(rng)}` }),
  (rng) => ({ text: `add ${register(rng, 32)}, ${rng.int(200, 5000)}` }),
  (rng) => ({ text: `sub ${register(rng, 64)}, ${small(rng)}` }),
  (rng) => {
    const reg = register(rng, 32)
    return { text: `xor ${reg}, ${reg}` }
  },
  (rng) => ({ text: `inc ${register(rng, 64)}` }),
  (rng) => {
    const [a, b] = pickRegisters(rng, 2)
    return { text: `imul ${a}, ${b}` }
  },
  (rng) => ({ text: `movzx ${register(rng, 32)}, ${rng.pick(LOW_BYTES)}`, quiet: true }),
  (rng) => ({ text: `lea ${register(rng, 64)}, 8[rsp]`, quiet: true }),
  (rng) => ({
    text: `lea ${register(rng, 64)}, ${rng.chance() ? '-8[rbp]' : '[rbp-8]'}`,
    quiet: true,
  }),
  (rng) => {
    const reg = rng.pick(FREE_REGISTERS)
    return { text: `push ${reg}`, undo: `pop ${reg}` }
  },
  () => ({ text: 'nop', quiet: true }),
  (rng) => ({ text: `mov ${register(rng, 64)}, [rsp]`, quiet: true }),
  (rng) => ({ text: `mov qword ptr -8[rbp], ${small(rng)}`, frame: true, quiet: true }),
  (rng) => ({ text: `mov dword ptr [rbp-4], ${small(rng)}`, frame: true, quiet: true }),
  (rng) => ({ text: `mov -8[rbp], ${register(rng, 64)}`, frame: true, quiet: true }),
  (rng) => ({ text: `mov ${register(rng, 32)}, dword ptr -8[rbp]`, frame: true, quiet: true }),
  () => ({ text: 'lea rdi, message[rip]', message: true, quiet: true }),
  (rng) => ({ text: `cmp ${register(rng, 32)}, ${small(rng)}` }),
]

/** `count` lines made by different makers, so their sizes vary. */
function pickLines(rng: Rng, count: number, accept: (line: Line) => boolean = () => true): Line[] {
  const lines: Line[] = []
  const used = new Set<number>()
  while (lines.length < count) {
    const index = rng.int(0, LINE_MAKERS.length - 1)
    if (used.has(index)) continue
    const line = LINE_MAKERS[index](rng)
    if (!accept(line)) continue
    used.add(index)
    lines.push(line)
  }
  return lines
}

/**
 * The lines around a jump: quiet (no flags written, rsp left alone) and short, so the
 * listing with its address column fits a phone screen. They are not what is asked.
 */
const fillerLine = (line: Line): boolean => line.quiet === true && line.text.length <= 18

/* ─────────────────────────── the program around them ─────────────────────── */

/**
 * The first line of a stepper program, as gcc wants it. Only form A uses it: forms B and
 * C ask about line numbers, and the stepper must number the lines the way the question
 * does (the stepper page is asked to hide the "missing" note for practice links).
 */
const INTEL_SYNTAX = '    .intel_syntax noprefix'

/** rsp at the start, and where rbp points for the lines that use rbp. */
const START_RSP = SMALL_WORLD.initialRsp
const FRAME_RBP = START_RSP + 0x10n

/** What the stepper needs after the shown lines: pops (newest first), `ret`, the string. */
function ending(lines: readonly Line[]): string[] {
  const undo = lines.flatMap((line) => (line.undo === undefined ? [] : [`    ${line.undo}`]))
  const end = [...undo.reverse(), '    ret']
  if (lines.some((line) => line.message)) end.push('message:', '    .string "Hi"')
  return end
}

/** Small-world options for these lines, with rbp and its box ready when a line uses them. */
function worldFor(lines: readonly Line[], textBase: bigint, flags?: Partial<Flags>) {
  const frame = lines.some((line) => line.frame)
  return smallWorld({
    textBase,
    rsp: START_RSP,
    extra: {
      ...(frame
        ? {
            initialRegisters: { rbp: FRAME_RBP },
            initialMemory: [{ address: FRAME_RBP - 8n, bytes: 8 as const, value: 0x2an }],
          }
        : {}),
      ...(flags === undefined ? {} : { initialFlags: flags }),
    },
  })
}

/** Instruction sizes of a program, from the assembler. */
function sizesOf(code: string): number[] {
  const result = assemble(code, smallWorld())
  if (!result.ok) {
    throw new Error(`rip: the program did not assemble.\n${code}`)
  }
  return result.program.instructions.map((instruction) => instruction.size)
}

/**
 * A code address in the small world. Half of the time all its digits are 0–9 and the
 * last one is 5–9, so adding a size often carries into the next digit: that is where
 * the "added in decimal" slip shows.
 */
function pickAddress(rng: Rng): bigint {
  if (rng.chance()) {
    return 0x4000n + BigInt(rng.int(0, 9) * 0x100 + rng.int(0, 9) * 0x10 + rng.int(5, 9))
  }
  return BigInt(rng.int(0x4000, 0x4fd0))
}

/* ───────────────────────────────── words ─────────────────────────────────── */

const bytes = (size: number): string => (size === 1 ? '1 byte' : `${size} bytes`)

/** "ZF is 1", "SF is 1 and OF is 0", "ZF is 0, SF is 1 and OF is 1" */
function flagList(flags: Flags, names: readonly FlagName[]): string {
  return joinAnd(names.map((flag) => `${flag} is ${flags[flag]}`))
}

/** "It looks like you added in decimal. [Lines 1 to 2 take 8 bytes, and i]n hex, …" */
function decimalMessage(base: bigint, size: bigint, wrong: bigint, lead?: string): string {
  const sum = `${show(base)} + ${size} = ${show(base + size)}, not ${show(wrong)}`
  return lead === undefined
    ? `It looks like you added in decimal. In hex, ${sum}.`
    : `It looks like you added in decimal. ${lead}, and in hex ${sum}.`
}

/* ─────────────────────────────── shared parts ────────────────────────────── */

interface Built {
  prompt: PromptBlock[]
  fields: Field[]
  reason: string
  stepper: Problem['stepper']
  diagnose: Problem['diagnose']
}

/* ─────────────────────────────── form A ──────────────────────────────────── */

function formA(rng: Rng): Built {
  const [line] = pickLines(rng, 1)
  const address = pickAddress(rng)
  // The question shows no listing, so the stepper program can start the way gcc wants.
  const code = [INTEL_SYNTAX, 'main:', `    ${line.text}`, ...ending([line])].join('\n') + '\n'
  const options = worldFor([line], address)
  const run = runProgram(code, options)
  const step = run.steps[0]
  const start = step.result.address
  const rip = step.after.rip
  const length = BigInt(run.program.instructions[0].size)
  if (start !== address) throw new Error('rip: form A layout moved.')

  return {
    prompt: [
      textBlock(
        `The instruction \`${line.text}\` is at address ${show(start)}. It is ${bytes(Number(length))} long. While it runs, what is in rip? Answer in hex.`,
      ),
    ],
    fields: [hexField('rip', 'rip while it runs', rip)],
    reason: `While an instruction runs, rip already holds the address of the next one: ${show(start)} + ${length} = ${show(rip)}.`,
    stepper: {
      code,
      options,
      note: 'Step once: rip then shows the value it had while the instruction ran.',
    },
    diagnose: (answers) => {
      const given = answers.rip
      if (answerIs(given, rip)) return null
      if (answerIs(given, start)) {
        return {
          code: 'rip-is-current',
          message: `That is the address of the instruction itself. While it runs, rip already holds the address of the next instruction: ${show(start)} + ${length} = ${show(rip)}.`,
        }
      }
      const slip = decimalSlip(start, length)
      if (slip !== null && answerIs(given, slip)) {
        return { code: 'decimal-arithmetic', message: decimalMessage(start, length, slip) }
      }
      return null
    },
  }
}

/* ─────────────────────────────── form B ──────────────────────────────────── */

/**
 * Planning only (the answer key comes from the run): with the first line at `first`, does
 * an "added in decimal" slip for either box equal the address of a listed line, or the
 * address right after the last one? `sizes[k]` is the size of line k + 1.
 */
function decimalSlipMisleads(
  first: bigint,
  sizes: readonly number[],
  p: number,
  q: number,
): boolean {
  const count = sizes.length
  const addresses = [first]
  for (let index = 0; index < count; index++) {
    addresses.push(addresses[index] + BigInt(sizes[index]))
  }
  const at = (line: number) => addresses[line - 1]
  const slips = [
    decimalSlip(first, at(p) - first),
    decimalSlip(first, at(q + 1) - first),
    decimalSlip(at(q), at(q + 1) - at(q)),
  ]
  return slips.some((slip) => slip !== null && addresses.includes(slip))
}

function formB(rng: Rng): Built {
  const count = rng.int(3, 4)
  const lines = pickLines(rng, count)
  const sizes = sizesOf(
    [...lines.map((line) => `    ${line.text}`), ...ending(lines)].join('\n') + '\n',
  )
  // Each size right after its line (not lined up in a column): on a phone, a short line
  // keeps its size on the same row, and a long one wraps with its size whole.
  const shown = lines.map((line, index) => `    ${line.text}  # ${bytes(sizes[index])}`)

  // p: the line whose address is asked; q: the line during which rip is asked.
  // The two answers always differ (rip while line q runs is the address of line q + 1).
  const pairs: [number, number][] = []
  for (let p = 2; p <= count; p++) {
    for (let q = 1; q <= count; q++) if (q + 1 !== p) pairs.push([p, q])
  }
  const [p, q] = rng.pick(pairs)

  // An "added in decimal" slip must never look like another answer the student could
  // mean: the address of another line, or the answer of the other box. Then a student
  // who counts one line too far is never told they added in decimal.
  const listed = sizes.slice(0, count)
  let address = pickAddress(rng)
  for (let attempt = 0; attempt < 20 && decimalSlipMisleads(address, listed, p, q); attempt++) {
    address = pickAddress(rng)
  }
  // Still no luck: an address with the digit a in it, where no decimal slip can happen.
  if (decimalSlipMisleads(address, listed, p, q)) address = 0x4a00n + BigInt(rng.int(0, 0xd0))
  const code = [...shown, ...ending(lines)].join('\n') + '\n'
  const options = worldFor(lines, address)
  const run = runProgram(code, options)

  const first = run.steps[0].result.address
  const lineP = run.steps[p - 1].result.address
  const lineQ = run.steps[q - 1].result.address
  const ripQ = run.steps[q - 1].after.rip
  const sizeOf = (line: number) => BigInt(run.program.instructions[line - 1].size)
  run.program.instructions.slice(0, count).forEach((instruction, index) => {
    if (instruction.size !== sizes[index]) throw new Error('rip: a size comment is wrong.')
  })
  if (first !== address) throw new Error('rip: form B layout moved.')

  const before = (line: number) => Array.from({ length: line - 1 }, (_, index) => sizeOf(index + 1))
  const sum = (values: readonly bigint[]) => values.reduce((total, value) => total + value, 0n)
  const sizesBeforeP = before(p)
  const takes =
    p === 2
      ? `Line 1 takes ${bytes(Number(sizesBeforeP[0]))}`
      : `Lines 1 ${p === 3 ? 'and' : 'to'} ${p - 1} take ${bytes(Number(sum(sizesBeforeP)))}`

  return {
    prompt: [
      textBlock(
        `The first line is at address ${show(first)}. The comment on each line gives its size. Answer in hex.`,
      ),
      codeBlock(shown),
    ],
    fields: [
      hexField('address', `Address of line ${p}`, lineP),
      hexField('rip', `rip while line ${q} runs`, ripQ),
    ],
    reason: `Line ${p} is at ${show(first)} + ${sizesBeforeP.join(' + ')} = ${show(lineP)}. While line ${q} runs, rip = ${show(lineQ)} + ${sizeOf(q)} = ${show(ripQ)}.`,
    stepper: {
      code,
      options,
      note: 'Step one line at a time: after each step, rip shows the value it had while that line ran.',
    },
    diagnose: (answers) => {
      const addressRight = answerIs(answers.address, lineP)
      const ripRight = answerIs(answers.rip, ripQ)
      if (addressRight && ripRight) return null
      // Both answers typed into each other's boxes: not a known mistake, whatever a value
      // might look like on its own.
      if (answerIs(answers.address, ripQ) && answerIs(answers.rip, lineP)) return null

      // 1. rip given as the address of line q itself.
      if (!ripRight && answerIs(answers.rip, lineQ)) {
        return {
          code: 'rip-is-current',
          message: `That is the address of line ${q} itself. While a line runs, rip already holds the address of the next line: ${show(lineQ)} + ${sizeOf(q)} = ${show(ripQ)}.`,
        }
      }

      // 2. Sizes added in decimal.
      if (!addressRight) {
        const total = sum(sizesBeforeP)
        const slip = decimalSlip(first, total)
        if (slip !== null && answerIs(answers.address, slip)) {
          return { code: 'decimal-arithmetic', message: decimalMessage(first, total, slip, takes) }
        }
      }
      if (!ripRight) {
        const starts: [bigint, bigint][] = [
          [first, sum(before(q + 1))],
          [lineQ, sizeOf(q)],
        ]
        for (const [base, size] of starts) {
          const slip = decimalSlip(base, size)
          if (slip !== null && answerIs(answers.rip, slip)) {
            return { code: 'decimal-arithmetic', message: decimalMessage(base, size, slip) }
          }
        }
      }
      return null
    },
  }
}

/* ─────────────────────────────── form C ──────────────────────────────────── */

const CONDITIONS: readonly JumpCondition[] = [
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
]
const TARGETS = ['done', 'skip', 'found', 'finish', 'other', 'later'] as const

/** The flags a condition reads, in the order its rule names them ("ZF = 0 and SF = OF"). */
function flagsRead(condition: JumpCondition): FlagName[] {
  const rule = describeCondition(condition).rule
  return FLAG_NAMES.filter((flag) => rule.includes(flag)).sort(
    (a, b) => rule.indexOf(a) - rule.indexOf(b),
  )
}

/** Flag values (the ones the condition reads) that make the jump go the way we want. */
function flagsFor(rng: Rng, condition: JumpCondition, taken: boolean): Flags {
  const read = flagsRead(condition)
  for (;;) {
    const flags: Flags = { CF: 0, ZF: 0, SF: 0, OF: 0 }
    for (const flag of read) flags[flag] = rng.chance() ? 1 : 0
    if (conditionHolds(condition, flags) === taken) return flags
  }
}

function formC(rng: Rng): Built {
  const kind = rng.pick(['jmp', 'taken', 'not-taken'] as const)
  const condition = kind === 'jmp' ? null : rng.pick(CONDITIONS)
  const flags = condition === null ? undefined : flagsFor(rng, condition, kind === 'taken')
  const target = rng.pick(TARGETS)
  const jump = `${condition ?? 'jmp'} ${target}`

  const [fall, landing, ...before] = pickLines(rng, 2 + rng.int(0, 2), fillerLine)
  const used = [...before, fall, landing]
  const lines = [
    'main:',
    ...before.map((line) => `    ${line.text}`),
    `    ${jump}`,
    `    ${fall.text}`,
    '    ret',
    `${target}:`,
    `    ${landing.text}`,
    '    ret',
  ]
  const jumpLine = before.length + 2
  const tail = ending(used).filter((line) => line !== '    ret')
  const code = [...lines, ...tail].join('\n') + '\n'

  /** Run the program with `main` at `textBase` and read the addresses that matter. */
  const layout = (textBase: bigint) => {
    const options = worldFor(used, textBase, flags)
    const run = runProgram(code, options)
    const index = stepAtLine(run, jumpLine)
    const addresses = lineAddresses(run.program, lines)
    const own = run.steps[index].result.address
    const fallThrough = addresses[jumpLine]
    return {
      options,
      index,
      addresses,
      own,
      fallThrough,
      targetAddress: addresses[lines.indexOf(`${target}:`)],
      rip: run.steps[index].after.rip,
      // The "added in decimal" slip for the next line (only asked when the jump is not taken).
      slip: kind === 'not-taken' ? decimalSlip(own, fallThrough - own) : null,
    }
  }
  // When that slip lands exactly on the label's address, a student who thought the jump
  // was taken would be told they added in decimal. Move the code so the two never meet
  // (and if they still meet, do not offer the decimal slip at all).
  let placed = layout(pickAddress(rng))
  for (let attempt = 0; attempt < 20 && placed.slip === placed.targetAddress; attempt++) {
    placed = layout(pickAddress(rng))
  }
  const { options, index, addresses, own, fallThrough, targetAddress, rip } = placed
  const decimalWrong = placed.slip === targetAddress ? null : placed.slip
  const wanted = kind === 'not-taken' ? fallThrough : targetAddress
  if (rip !== wanted) throw new Error(`rip: the jump did not go where planned.\n${code}`)

  const read = condition === null ? [] : flagsRead(condition)
  const rule = condition === null ? '' : describeCondition(condition).rule
  const state = flags === undefined ? '' : flagList(flags, read)
  const prompt: PromptBlock[] = [
    textBlock(`What is in rip right after line ${jumpLine} (\`${jump}\`) runs? Answer in hex.`),
  ]
  if (condition !== null) {
    prompt.push(
      textBlock(`\`${condition}\` jumps when ${rule}. Before line ${jumpLine} runs, ${state}.`),
    )
  }
  prompt.push(codeBlock(lines, addresses))

  const why =
    condition === null
      ? `\`jmp\` always jumps, so rip = the address of \`${target}\`, ${show(targetAddress)}.`
      : kind === 'taken'
        ? `\`${condition}\` jumps when ${rule}; ${state}, so it jumps: rip = the address of \`${target}\`, ${show(targetAddress)}.`
        : `\`${condition}\` jumps only when ${rule}; ${state}, so it does not jump: rip = the next line, ${show(fallThrough)}.`

  const stepsToRun = index + 1
  return {
    prompt,
    fields: [hexField('rip', `rip after line ${jumpLine} runs`, rip)],
    reason: why,
    stepper: {
      code,
      options,
      note:
        stepsToRun === 1
          ? 'Press Step once, then look at rip.'
          : `Press Step ${stepsToRun} times, then look at rip.`,
    },
    diagnose: (answers) => {
      const given = answers.rip
      if (answerIs(given, rip)) return null
      if (answerIs(given, own)) {
        return {
          code: 'rip-is-current',
          message: `That is the address of the jump itself. After a line runs, rip holds the address of the line that runs next: ${show(rip)}.`,
        }
      }
      if (kind === 'not-taken') {
        if (decimalWrong !== null && answerIs(given, decimalWrong)) {
          return {
            code: 'decimal-arithmetic',
            message: decimalMessage(own, fallThrough - own, decimalWrong),
          }
        }
        if (answerIs(given, targetAddress)) {
          return {
            code: 'wrong-reason',
            message: `This jump is not taken: \`${condition}\` jumps only when ${rule}, and ${state}. So rip moves on to the next line: ${show(fallThrough)}.`,
          }
        }
        return null
      }
      if (answerIs(given, fallThrough)) {
        return {
          code: 'wrong-reason',
          message:
            condition === null
              ? `\`jmp\` always jumps, so rip gets the address of \`${target}\`: ${show(targetAddress)}. The next line does not run.`
              : `This jump is taken: \`${condition}\` jumps when ${rule}, and ${state}. So rip gets the address of \`${target}\`: ${show(targetAddress)}.`,
        }
      }
      return null
    },
  }
}

/* ────────────────────────────── the problem ──────────────────────────────── */

const FORMS = { A: formA, B: formB, C: formC } as const

export const generate: ProblemGenerator = (seed) => {
  const rng = createRng(seed)
  const form = rng.pick(['A', 'B', 'C'] as const)
  const built = FORMS[form](rng)
  const problem: Problem = {
    id: `rip-${seed}`,
    topic: 'rip',
    seed,
    view: 'form',
    prompt: built.prompt,
    fields: built.fields,
    reason: built.reason,
    stepper: built.stepper,
    diagnose: built.diagnose,
  }
  return problem
}
