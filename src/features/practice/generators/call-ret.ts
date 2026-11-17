/**
 * call and ret: the return address, rsp and rip.
 *
 * Build: a listing with addresses. `main` sets an argument, calls a small function and
 * does one more thing; the function (sometimes saving rbx or r12 with a push/pop pair)
 * returns with `ret`. rsp is a multiple of 16 just before the `call`, as on a real
 * machine.
 *
 * Run it in the emulator; the answer key is read from the snapshots: rsp and rip right
 * after the `call`, the value in the new top box (the return address), and rip and rsp
 * right after the function's `ret`.
 */
import { createRng, type Rng } from '../../../lib/rng'
import {
  answerIs,
  codeBlock,
  decimalSlip,
  hexField,
  instructionAtLine,
  lineAddresses,
  runProgram,
  show,
  smallWorld,
  stepAtLine,
  textBlock,
} from '../gen/helpers'
import type { Mistake, Problem, ProblemGenerator } from '../types'

/* ─────────────────────────────── the program ─────────────────────────────── */

interface Fn {
  name: string
  /** The body, given the 32- and 64-bit names of the register that holds the argument. */
  body: (arg32: string, arg64: string) => string[]
}

/** Small functions whose names say what they do. The argument comes in edi. */
const FUNCTIONS: readonly Fn[] = [
  { name: 'square', body: (a) => [`mov eax, ${a}`, `imul eax, ${a}`] },
  { name: 'twice', body: (a) => [`mov eax, ${a}`, `add eax, eax`] },
  { name: 'triple', body: (_, a) => [`lea eax, [${a}+${a}*2]`] },
  { name: 'add_one', body: (_, a) => [`lea eax, [${a}+1]`] },
  { name: 'add_five', body: (a) => [`mov eax, ${a}`, `add eax, 5`] },
  { name: 'helper', body: (a) => [`mov eax, ${a}`, `sub eax, 3`] },
]

/** Registers a function must give back unchanged, so it saves them with push/pop. */
const SAVED = [
  { r64: 'rbx', r32: 'ebx' },
  { r64: 'r12', r32: 'r12d' },
] as const

/** How far students sometimes move rsp for one box instead of 8. */
const WRONG_SIZES = [1n, 2n, 4n, 16n] as const

/** What `main` does with the result after the call. */
const AFTER_CALL = ['mov ecx, eax', 'mov edx, eax', 'mov esi, eax', 'add eax, 1'] as const

interface Built {
  lines: string[]
  fn: string
  /** 1-based source lines of the `call` and of the function's `ret`. */
  callLine: number
  retLine: number
}

function buildProgram(rng: Rng): Built {
  const fn = rng.pick(FUNCTIONS)
  const saved = rng.chance() ? rng.pick(SAVED) : null
  const before = [...(rng.chance(0.4) ? ['mov eax, 0'] : []), `mov edi, ${rng.int(2, 30)}`]
  const body = saved === null ? fn.body('edi', 'rdi') : fn.body(saved.r32, saved.r64)
  const inner =
    saved === null
      ? body
      : [`push ${saved.r64}`, `mov ${saved.r32}, edi`, ...body, `pop ${saved.r64}`]

  const lines = [
    'main:',
    ...before.map((line) => `    ${line}`),
    `    call ${fn.name}`,
    `    ${rng.pick(AFTER_CALL)}`,
    '    ret',
    `${fn.name}:`,
    ...inner.map((line) => `    ${line}`),
    '    ret',
  ]
  return {
    lines,
    fn: fn.name,
    callLine: before.length + 2,
    retLine: lines.length,
  }
}

/**
 * rsp just before the call: a multiple of 0x10 in 0x110 … 0xff0, so every rsp the problem
 * shows (down to rsp − 16 inside the function) has 3 hex digits. More than half of the
 * time every digit is 0–9, so the "subtracted in decimal" slip (0x300 − 8 → 0x292) can
 * show.
 */
function pickRsp(rng: Rng): bigint {
  for (;;) {
    const high = rng.chance(0.6) ? rng.int(1, 9) : rng.int(1, 15)
    const middle = rng.chance(0.6) ? rng.int(0, 9) : rng.int(0, 15)
    const rsp = BigInt(high * 0x100 + middle * 0x10)
    if (rsp >= 0x110n) return rsp
  }
}

/** A code address for `main`: 0x4000 … 0x4f80, sometimes with only the digits 0–9. */
function pickTextBase(rng: Rng): bigint {
  if (rng.chance()) {
    return 0x4000n + BigInt(rng.int(0, 9) * 0x100 + rng.int(0, 9) * 0x10 + rng.int(0, 9))
  }
  return BigInt(rng.int(0x4000, 0x4f80))
}

/* ────────────────────────────── the problem ──────────────────────────────── */

export const generate: ProblemGenerator = (seed) => {
  const rng = createRng(seed)

  // 1. Build the program.
  const built = buildProgram(rng)
  const { lines, fn, callLine, retLine } = built
  const code = `${lines.join('\n')}\n`
  const options = smallWorld({ rsp: pickRsp(rng), textBase: pickTextBase(rng) })

  // 2. Run it and read the answers from the snapshots.
  const run = runProgram(code, options)
  const callIndex = stepAtLine(run, callLine)
  const retIndex = stepAtLine(run, retLine)
  const call = run.steps[callIndex]
  const ret = run.steps[retIndex]
  const beforeCall = callIndex === 0 ? run.start : run.steps[callIndex - 1].after
  const beforeRet = run.steps[retIndex - 1].after

  const rspBefore = beforeCall.registers.rsp // shown in the question
  const callAddress = call.result.address
  const callSize = BigInt(instructionAtLine(run.program, callLine).size)
  const rspAfterCall = call.after.registers.rsp
  const pushed = call.after.stack.find((box) => box.address === rspAfterCall)?.value ?? null
  const ripAfterCall = call.after.rip
  const rspInsideBeforeRet = beforeRet.registers.rsp
  const ripAfterRet = ret.after.rip
  const rspAfterRet = ret.after.registers.rsp
  if (pushed === null) throw new Error('call-ret: the new top box is empty.')

  // 3. Fields and prompt.
  const fields = [
    hexField('rspAfterCall', 'rsp right after the `call`', rspAfterCall),
    hexField('pushed', 'The value the `call` puts on the stack', pushed),
    hexField('ripAfterCall', 'rip right after the `call`', ripAfterCall),
    hexField('ripAfterRet', `rip right after the \`ret\` of \`${fn}\``, ripAfterRet),
    hexField('rspAfterRet', `rsp right after the \`ret\` of \`${fn}\``, rspAfterRet),
  ]
  const prompt = [
    textBlock(
      `rsp is ${show(rspBefore)} just before the \`call\` on line ${callLine}. Answer in hex.`,
    ),
    codeBlock(lines, lineAddresses(run.program, lines)),
  ]

  // 4. The tempting wrong answers, in the order of the specification.
  const diagnose = (answers: Readonly<Record<string, string>>): Mistake | null => {
    const right = fields.every((field) => answers[field.id] === field.expected)
    if (right) return null
    /** The student's answer for one field, when it is wrong and equals `value`. */
    const said = (id: string, value: bigint | null): boolean => {
      const field = fields.find((item) => item.id === id)
      return (
        value !== null &&
        field !== undefined &&
        answers[id] !== field.expected &&
        answerIs(answers[id], value)
      )
    }
    const own = /^[0-9a-f]+$/.test(answers.rspAfterCall ?? '')
      ? BigInt(`0x${answers.rspAfterCall}`)
      : null
    /**
     * rsp before the `ret`, as the student sees it: their own rsp after the `call` (the
     * function gives back every box it takes), or the right value when that answer cannot
     * be read. A `ret` worked out right from a wrong rsp is a carried slip, not a new one.
     */
    const retBase = own ?? rspInsideBeforeRet

    // 1. The return address and the function's address in each other's place.
    if (said('ripAfterCall', pushed)) {
      return {
        code: 'return-address-in-rip',
        message: `You put the return address in rip. \`call\` saves the return address (${show(pushed)}) on the stack; rip gets the address of \`${fn}\` (${show(ripAfterCall)}).`,
      }
    }
    if (said('pushed', ripAfterCall)) {
      return {
        code: 'return-address-in-rip',
        message: `You put the address of \`${fn}\` on the stack. \`call\` saves the return address (${show(pushed)}) there; rip gets the address of \`${fn}\` (${show(ripAfterCall)}).`,
      }
    }

    // 2. The address of the `call` itself used as the return address.
    if (said('pushed', callAddress) || said('ripAfterRet', callAddress)) {
      return {
        code: 'return-address-is-call',
        message: `The return address is the line after the \`call\` (${show(pushed)}), not the \`call\` itself (${show(callAddress)}). Going back to the \`call\` would run it again.`,
      }
    }

    // 3. rsp went up for `call` or down for `ret`.
    if (said('rspAfterCall', rspBefore + 8n) || said('rspAfterRet', retBase - 8n)) {
      return {
        code: 'rsp-wrong-direction',
        message: `rsp moved the wrong way. \`call\` pushes, so rsp goes DOWN by 8 (${show(rspBefore)} → ${show(rspAfterCall)}); \`ret\` pops, so rsp goes UP by 8.`,
      }
    }

    // 4. rsp unchanged by the `call` or by the `ret`.
    if (said('rspAfterCall', rspBefore)) {
      return {
        code: 'call-ret-forgot-stack',
        message: `\`call\` moves rsp too: it pushes the return address, so rsp goes down by 8 (${show(rspBefore)} → ${show(rspAfterCall)}).`,
      }
    }
    if (said('rspAfterRet', retBase)) {
      return {
        code: 'call-ret-forgot-stack',
        message: `\`ret\` moves rsp too: it pops the return address, so rsp goes up by 8 (${show(rspInsideBeforeRet)} → ${show(rspAfterRet)}).`,
      }
    }

    // 5. Hex numbers added or subtracted as if they were decimal.
    const slips: { id: string; base: bigint; change: bigint }[] = [
      { id: 'rspAfterCall', base: rspBefore, change: rspAfterCall - rspBefore },
      { id: 'rspAfterRet', base: retBase, change: rspAfterRet - rspInsideBeforeRet },
      { id: 'pushed', base: callAddress, change: callSize },
      { id: 'ripAfterRet', base: callAddress, change: callSize },
    ]
    for (const { id, base, change } of slips) {
      const slip = decimalSlip(base, change)
      if (slip === null || !said(id, slip)) continue
      const size = change < 0n ? -change : change
      const sum = `${show(base)} ${change < 0n ? '−' : '+'} ${size} = ${show(base + change)}, not ${show(slip)}`
      const slipped = `It looks like you ${change < 0n ? 'subtracted' : 'added'} in decimal.`
      return {
        code: 'decimal-arithmetic',
        message:
          id === 'pushed' || id === 'ripAfterRet'
            ? `${slipped} The \`call\` is ${size} bytes long, and in hex ${sum}.`
            : `${slipped} In hex, ${sum}.`,
      }
    }

    // 6. One box moved by 1, 2, 4 or 16 bytes instead of 8 (a slip the spec does not list
    // for this type, but the message is true and names it at the step where it happened).
    if (WRONG_SIZES.some((size) => said('rspAfterCall', rspBefore - size))) {
      return {
        code: 'rsp-wrong-amount',
        message: `\`call\` pushes one box (the return address, 8 bytes), so rsp goes down by exactly 8 (${show(rspBefore)} → ${show(rspAfterCall)}).`,
      }
    }
    if (WRONG_SIZES.some((size) => said('rspAfterRet', retBase + size))) {
      return {
        code: 'rsp-wrong-amount',
        message: `\`ret\` pops one box (the return address, 8 bytes), so rsp goes up by exactly 8 (${show(rspInsideBeforeRet)} → ${show(rspAfterRet)}).`,
      }
    }
    return null
  }

  const problem: Problem = {
    id: `call-ret-${seed}`,
    topic: 'call-ret',
    seed,
    view: 'form',
    prompt,
    fields,
    reason: `\`call\` pushes the return address ${show(pushed)} (the next line), so rsp = ${show(rspAfterCall)} and rip = ${show(ripAfterCall)}; \`ret\` pops it back into rip, so rsp = ${show(rspAfterRet)} again.`,
    // 5. The same program in the stepper.
    stepper: {
      code,
      options,
      note: 'Step until the `call` has run, then look at rsp, rip and the new top box of the stack.',
    },
    diagnose,
  }
  return problem
}
