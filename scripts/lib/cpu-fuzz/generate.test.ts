/**
 * The safety rules of the fuzz generator, checked on the program TEXT (the thing the
 * emulator and the real assembler read), not on the generator's own data.
 * A program that broke one of these rules could crash on the real CPU or give a result
 * that depends on the machine.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateProgram, generatePrograms } from './generate'
import { runModel } from './model'
import { emulatorBody, nativeBody, type FuzzProgram, type Line } from './program'
import { collectStats, coverageGaps } from './stats'

const SEED = 2026
const PROGRAMS = generatePrograms(SEED, 300)

const LOW_BYTES_NEEDING_REX = ['sil', 'dil', 'bpl']
const HIGH_BYTES = ['ah', 'bh', 'ch', 'dh']
const FREE_64 = [
  'rax',
  'rbx',
  'rcx',
  'rdx',
  'rsi',
  'rdi',
  'rbp',
  'r8',
  'r9',
  'r10',
  'r11',
  'r12',
  'r13',
  'r14',
]
const CARRY_OR_OVERFLOW_JUMPS = ['jo', 'jno', 'jb', 'jae', 'jc', 'jnc', 'jnae', 'jnb']
const MEMORY_OPERAND =
  /^(?:(byte|word|dword|qword) ptr )?(?:(0x[0-9a-f]+|\d+)\[r15\]|\[r15(?:\+(0x[0-9a-f]+|\d+))?\])$/

function isLabel(item: Line): boolean {
  return item.step.op === 'label'
}

function mnemonicOf(text: string): string {
  return text.split(' ')[0] ?? ''
}

function operandsOf(text: string): string[] {
  const space = text.indexOf(' ')
  return space < 0 ? [] : text.slice(space + 1).split(', ')
}

function isJump(text: string): boolean {
  return /^j[a-z]+ /.test(text)
}

function isFlagReset(text: string): boolean {
  const [first, second] = operandsOf(text)
  const plainRegister = /^[a-z][a-z0-9]*$/
  return (
    ['cmp', 'test'].includes(mnemonicOf(text)) &&
    first !== undefined &&
    second !== undefined &&
    plainRegister.test(first) &&
    plainRegister.test(second)
  )
}

function parseNumber(text: string): bigint {
  const negative = text.startsWith('-')
  const digits = negative ? text.slice(1) : text
  const size = BigInt(digits)
  return negative ? -size : size
}

/** The random part and what follows it: everything after the 16 opening lines. */
function afterOpening(program: FuzzProgram): Line[] {
  return program.lines.slice(16)
}

describe('fuzz generator: reproducible', () => {
  it('gives the same program for the same seed and number', () => {
    expect(emulatorBody(generateProgram(SEED, 17))).toBe(emulatorBody(generateProgram(SEED, 17)))
  })

  it('gives a different program for another seed or another number', () => {
    const body = emulatorBody(generateProgram(SEED, 17))
    expect(emulatorBody(generateProgram(SEED + 1, 17))).not.toBe(body)
    expect(emulatorBody(generateProgram(SEED, 18))).not.toBe(body)
  })

  it('does not let --count change a program', () => {
    const alone = generateProgram(SEED, 7)
    expect(emulatorBody(generatePrograms(SEED, 12)[7] ?? alone)).toBe(emulatorBody(alone))
    expect(PROGRAMS[7] && emulatorBody(PROGRAMS[7])).toBe(emulatorBody(alone))
  })
})

describe('fuzz generator: shape of a program', () => {
  it('starts by loading all 14 free registers, then points r15 at the scratch area', () => {
    for (const program of PROGRAMS) {
      const texts = program.lines.slice(0, 16).map((item) => item.text)
      FREE_64.forEach((name, position) => {
        expect(texts[position], program.id).toMatch(new RegExp(`^mov ${name}, (0x[0-9a-f]+|-1)$`))
      })
      expect(texts[14]).toBe('lea r15, scratch[rip]')
      expect(texts[15]).toBe('cmp rsp, rsp')
    }
  })

  it('has 15 to 45 random instructions, then only the pops that empty the stack', () => {
    for (const program of PROGRAMS) {
      expect(program.randomInstructions).toBeGreaterThanOrEqual(15)
      expect(program.randomInstructions).toBeLessThanOrEqual(45)
      const instructions = afterOpening(program).filter((item) => !isLabel(item))
      const extra = instructions.slice(program.randomInstructions)
      expect(extra.length, program.id).toBeLessThanOrEqual(6)
      for (const item of extra) expect(item.text, program.id).toMatch(/^pop r/)
    }
  })

  it('uses labels that are unique in the whole fixture', () => {
    const seen = new Set<string>()
    for (const program of PROGRAMS) {
      for (const item of program.lines) {
        if (item.step.op !== 'label') continue
        expect(item.text).toBe(`${item.step.name}:`)
        expect(item.step.name.startsWith(`${program.id}_`)).toBe(true)
        expect(seen.has(item.step.name)).toBe(false)
        seen.add(item.step.name)
      }
    }
  })

  it('differs for clang only in the spelling of movsx from 32 bits', () => {
    for (const program of PROGRAMS) {
      for (const item of program.lines) {
        if (item.native === item.text) continue
        expect(item.text).toMatch(/^movsxd? r[a-z0-9]+, (e[a-z]+|r\d+d|dword ptr .*)$/)
        expect(item.native).toBe(item.text.replace(/^movsx /, 'movsxd '))
      }
      expect(nativeBody(program).replaceAll('movsxd', 'movsx')).toBe(
        emulatorBody(program).replaceAll('movsxd', 'movsx'),
      )
    }
  })
})

describe('fuzz generator: nothing depends on the machine', () => {
  it('never names rsp or r15 outside the two opening lines and the memory base', () => {
    for (const program of PROGRAMS) {
      for (const item of afterOpening(program)) {
        expect(item.text, program.id).not.toMatch(/\b(rsp|esp|sp|spl)\b/)
        expect(item.text, program.id).not.toMatch(/\br15[dwb]\b/)
        // r15 may only appear as "[r15" (the base of a scratch operand).
        expect(item.text.replaceAll('[r15', ''), program.id).not.toMatch(/\br15\b/)
      }
    }
  })

  it('keeps every memory operand inside the scratch area', () => {
    let seen = 0
    for (const program of PROGRAMS) {
      for (const item of afterOpening(program)) {
        if (isLabel(item) || mnemonicOf(item.text) === 'lea') continue
        for (const operand of operandsOf(item.text)) {
          if (!operand.includes('[')) continue
          const match = MEMORY_OPERAND.exec(operand)
          expect(match, `${program.id}: ${item.text}`).not.toBeNull()
          const offset = Number(match?.[2] ?? match?.[3] ?? '0')
          expect(offset, `${program.id}: ${item.text}`).toBeLessThanOrEqual(248)
          seen += 1
        }
      }
    }
    expect(seen).toBeGreaterThan(1000)
  })

  it('builds lea addresses only from free registers', () => {
    for (const program of PROGRAMS) {
      for (const item of afterOpening(program)) {
        if (mnemonicOf(item.text) !== 'lea') continue
        const address = operandsOf(item.text)[1] ?? ''
        const names = address.match(/[a-z][a-z0-9]*/g) ?? []
        for (const name of names) {
          // "x" comes from hex numbers such as 0x1f.
          if (/^x[0-9a-f]*$/.test(name)) continue
          expect(FREE_64, `${program.id}: ${item.text}`).toContain(name)
        }
      }
    }
  })
})

describe('fuzz generator: only instructions a real assembler can encode', () => {
  it('never mixes ah/bh/ch/dh with a REX register, memory or a 64-bit register', () => {
    let seen = 0
    for (const program of PROGRAMS) {
      for (const item of afterOpening(program)) {
        const operands = operandsOf(item.text)
        if (!operands.some((operand) => HIGH_BYTES.includes(operand))) continue
        seen += 1
        for (const operand of operands) {
          expect(operand, `${program.id}: ${item.text}`).not.toContain('[')
          expect(operand, `${program.id}: ${item.text}`).not.toMatch(/^r\d+[dwb]?$/)
          expect(LOW_BYTES_NEEDING_REX, `${program.id}: ${item.text}`).not.toContain(operand)
          expect(FREE_64, `${program.id}: ${item.text}`).not.toContain(operand)
        }
      }
    }
    expect(seen).toBeGreaterThan(100)
  })

  it('keeps every immediate inside the range the assembler contract allows', () => {
    const SIGNED_32_MIN = -(2n ** 31n)
    const SIGNED_32_MAX = 2n ** 31n - 1n
    let seen = 0
    for (const program of PROGRAMS) {
      for (const item of program.lines) {
        const step = item.step
        if (!('src' in step) || step.src.kind !== 'imm') continue
        seen += 1
        const value = step.src.value
        // The text must say the same number as the data the model uses.
        expect(parseNumber(operandsOf(item.text).at(-1) ?? ''), item.text).toBe(value)
        if (step.op === 'push') {
          expect(value >= SIGNED_32_MIN && value <= SIGNED_32_MAX, item.text).toBe(true)
          continue
        }
        // Only movzx and movsx have no `size`, and they never take a number.
        if (!('size' in step)) throw new Error(`${item.text}: unexpected immediate`)
        const size = step.size
        if (size === 64 && step.op === 'mov' && step.dst.kind === 'reg') {
          expect(value >= -(2n ** 63n) && value <= 2n ** 64n - 1n, item.text).toBe(true)
        } else if (size === 64) {
          expect(value >= SIGNED_32_MIN && value <= SIGNED_32_MAX, item.text).toBe(true)
        } else {
          const lowest = -(2n ** BigInt(size - 1))
          const highest = 2n ** BigInt(size) - 1n
          expect(value >= lowest && value <= highest, item.text).toBe(true)
        }
      }
    }
    expect(seen).toBeGreaterThan(5000)
  })

  it('never writes a decimal number with a leading zero (gcc would read it as octal)', () => {
    let seen = 0
    for (const program of PROGRAMS) {
      for (const item of program.lines) {
        if (isLabel(item) || isJump(item.text)) continue
        // Every token that starts with a digit is a number (register names never do).
        for (const number of item.text.match(/(?<![a-z0-9_])\d[0-9a-fx]*/g) ?? []) {
          seen += 1
          expect(number, `${program.id}: ${item.text}`).toMatch(/^(0|[1-9]\d*|0x[0-9a-f]+)$/)
        }
      }
    }
    expect(seen).toBeGreaterThan(5000)
  })
})

describe('fuzz generator: jumps and the stack', () => {
  it('jumps only forward, over 1 to 3 instructions, and never nests jumps', () => {
    let jumps = 0
    for (const program of PROGRAMS) {
      const lines = afterOpening(program)
      lines.forEach((item, position) => {
        if (!isJump(item.text)) return
        jumps += 1
        const target = `${operandsOf(item.text)[0] ?? ''}:`
        const skipped: string[] = []
        let cursor = position + 1
        while (cursor < lines.length && lines[cursor]?.text !== target) {
          skipped.push(lines[cursor]?.text ?? '')
          cursor += 1
        }
        expect(cursor, `${program.id}: ${item.text} has no label after it`).toBeLessThan(
          lines.length,
        )
        expect(skipped.length, `${program.id}: ${item.text}`).toBeGreaterThanOrEqual(1)
        expect(skipped.length, `${program.id}: ${item.text}`).toBeLessThanOrEqual(3)
        for (const text of skipped) {
          expect(isJump(text) || text.endsWith(':'), `${program.id}: nested ${text}`).toBe(false)
        }
      })
    }
    expect(jumps).toBeGreaterThan(500)
  })

  it('balances push and pop, also inside every block a jump can skip', () => {
    for (const program of PROGRAMS) {
      const lines = afterOpening(program)
      let depth = 0
      let blockStart: number | null = null
      for (const item of lines) {
        const mnemonic = mnemonicOf(item.text)
        if (isJump(item.text)) blockStart = depth
        else if (isLabel(item)) {
          // Whether the jump was taken or not, the stack must be the same here.
          expect(depth, `${program.id}: unbalanced block before ${item.text}`).toBe(blockStart)
          blockStart = null
        } else if (mnemonic === 'push') depth += 1
        else if (mnemonic === 'pop') {
          depth -= 1
          expect(depth, `${program.id}: pop below the start`).toBeGreaterThanOrEqual(
            blockStart ?? 0,
          )
        }
      }
      expect(depth, `${program.id}: values left on the stack`).toBe(0)
    }
  })

  it('lets nothing see the flags of imul except a jump on CF or OF, then resets them', () => {
    let imuls = 0
    let probes = 0
    for (const program of PROGRAMS) {
      const lines = afterOpening(program)
      lines.forEach((item, position) => {
        if (mnemonicOf(item.text) !== 'imul') return
        imuls += 1
        let cursor = position + 1
        const following = lines[cursor]?.text ?? ''
        if (isJump(following)) {
          probes += 1
          expect(CARRY_OR_OVERFLOW_JUMPS, `${program.id}: ${following}`).toContain(
            mnemonicOf(following),
          )
          const target = `${operandsOf(following)[0] ?? ''}:`
          while (cursor < lines.length && lines[cursor]?.text !== target) cursor += 1
          cursor += 1
        }
        const reset = lines[cursor]?.text ?? ''
        expect(isFlagReset(reset), `${program.id}: after "${item.text}" comes "${reset}"`).toBe(
          true,
        )
      })
    }
    expect(imuls).toBeGreaterThan(200)
    expect(probes).toBeGreaterThan(50)
  })
})

describe('fuzz generator: reference model and coverage', () => {
  it('runs every program in the model without breaking a rule', () => {
    for (const program of PROGRAMS) expect(() => runModel(program)).not.toThrow()
  })

  it('covers every form, register name, width and jump outcome in 600 programs', () => {
    const programs = generatePrograms(SEED, 600)
    const stats = collectStats(
      programs,
      programs.map((program) => runModel(program)),
    )
    expect(coverageGaps(stats)).toEqual([])
    expect(stats.programs).toBe(600)
  })
})

describe('fuzz generator: the fixture in the repository', () => {
  const fixturePath = fileURLToPath(
    new URL('../../../src/emulator/__fixtures__/cpu-fuzz.json', import.meta.url),
  )

  // A change to the generator makes other programs. Then the fixture must be made again
  // (node scripts/make-cpu-fuzz-fixture.mjs), or the two no longer belong together.
  it.skipIf(!existsSync(fixturePath))('holds exactly the programs the generator makes', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      seed: number
      count: number
      programs: { id: string; body: string }[]
    }
    const programs = generatePrograms(fixture.seed, fixture.count)
    expect(fixture.programs).toHaveLength(programs.length)
    programs.forEach((program, position) => {
      expect(fixture.programs[position]?.id).toBe(program.id)
      expect(fixture.programs[position]?.body, program.id).toBe(emulatorBody(program))
    })
  })
})
