/**
 * Properties that EVERY registered generator must have, run over the registry
 * (`GENERATORS`), so a new topic is covered the moment it is registered.
 *
 * The tests of each generator check its own answers and mistakes. These check the
 * contract that the pages rely on.
 */
import { describe, expect, it } from 'vitest'
import { assemble, createEmulator } from '../../../emulator'
import { TOPICS, type TopicId } from '../../../content/topics'
import { createRng } from '../../../lib/rng'
import { decodePayload, encodePayload, type StepperPayload } from '../../../lib/share'
import { canonicalAnswer, checkProblem } from '../check'
import type { Field, Problem } from '../types'
import { GENERATORS } from './index'

const SEED_COUNT = 300
const SEEDS = Array.from({ length: SEED_COUNT }, (_, seed) => seed)

/** Topics whose "Show me" program may fail to assemble on purpose. */
const MAY_NOT_ASSEMBLE: ReadonlySet<TopicId> = new Set(['mov-legality'])

/**
 * Warnings a "Show me" program may have. The questions of these topics name line numbers
 * ("the `call` on line 4") next to a listing, and the stepper program must number its
 * lines the same way, so there is no room for `.intel_syntax noprefix` (or `main:`) above
 * the first line the question shows. The stepper page hides exactly these two notes for a
 * program from a practice link: a link whose payload has a `note` (every practice payload
 * has one, see below).
 */
const ALLOWED_WARNINGS: Partial<Record<TopicId, readonly string[]>> = {
  rip: ['missing-intel-syntax', 'no-main'],
  'call-ret': ['missing-intel-syntax'],
}

/** What a student types to get each field right: the answer as the page shows it. */
function rightAnswers(problem: Problem): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const field of problem.fields) {
    const typed = field.kind.type === 'choice' || field.kind.type === 'chip'
    answers[field.id] = typed ? field.expected : field.expectedDisplay
  }
  return answers
}

/** The answers in the canonical form that `diagnose` receives. */
function canonicalRight(problem: Problem): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const field of problem.fields) answers[field.id] = field.expected
  return answers
}

/** Junk a student (or a cat on the keyboard) could type. */
const JUNK = [
  '',
  ' ',
  '0',
  '-1',
  '0x',
  'x',
  'zz',
  'NaN',
  'undefined',
  'null',
  '__proto__',
  'constructor',
  '1e9',
  '0xffffffffffffffffffffffff',
  '😀',
  'r9w r9w',
  '`',
  '\n',
  'a'.repeat(5000),
]

function junkAnswers(problem: Problem, seed: number): Record<string, string>[] {
  const rng = createRng(seed)
  const ids = problem.fields.map((field) => field.id)
  const pickJunk = (): string =>
    rng.chance(0.3) ? (problem.fields[rng.int(0, ids.length - 1)]?.expected ?? '') : rng.pick(JUNK)
  const maps: Record<string, string>[] = [{}, { unknownField: 'x' }]
  for (let round = 0; round < 6; round++) {
    const answers: Record<string, string> = {}
    for (const id of ids) if (rng.chance(0.85)) answers[id] = pickJunk()
    maps.push(answers)
  }
  return maps
}

/** The payload with the parts that a link does not carry (empty note, empty options) left out. */
function meaningful(payload: StepperPayload): StepperPayload {
  const result: StepperPayload = { code: payload.code }
  if (payload.note !== undefined && payload.note !== '') result.note = payload.note
  if (payload.options === undefined) return result
  const options: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload.options) as [string, unknown][]) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length > 0) options[key] = value
    } else if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      if (entries.length > 0) options[key] = Object.fromEntries(entries)
    } else {
      options[key] = value
    }
  }
  if (Object.keys(options).length > 0) result.options = options
  return result
}

function allText(problem: Problem): string {
  return JSON.stringify(
    [problem.prompt, problem.fields, problem.chips ?? [], problem.reason, problem.stepper.note],
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString(16) : value),
  )
}

function isCanonical(field: Field): boolean {
  return field.expected !== '' && canonicalAnswer(field, field.expected) === field.expected
}

it('has a generator for every topic', () => {
  expect(Object.keys(GENERATORS).sort()).toEqual(TOPICS.map((topic) => topic.id).sort())
})

for (const { id: topic } of TOPICS) {
  describe(`generator: ${topic}`, () => {
    // Built once, on first use. A seed that throws is reported by the first test only.
    let built: { seed: number; problem: Problem }[] | null = null
    const failures: { seed: number; error: unknown }[] = []
    const problems = (): { seed: number; problem: Problem }[] => {
      if (built !== null) return built
      built = []
      for (const seed of SEEDS) {
        try {
          built.push({ seed, problem: GENERATORS[topic](seed) })
        } catch (error) {
          failures.push({ seed, error })
        }
      }
      return built
    }
    const each = (check: (problem: Problem, seed: number) => void) => {
      const list = problems()
      expect(list.length, 'no problem could be generated').toBeGreaterThan(0)
      for (const { seed, problem } of list) check(problem, seed)
    }

    it('generates a problem for seeds 0…299 without throwing', () => {
      problems()
      const first = failures[0]
      expect(failures.length, first ? `seed ${first.seed}: ${String(first.error)}` : '').toBe(0)
    })

    it('sets the id, topic, seed and view', () => {
      each((problem, seed) => {
        expect(problem.id).toBe(`${topic}-${seed}`)
        expect(problem.topic).toBe(topic)
        expect(problem.seed).toBe(seed)
        expect(['form', 'trace-table']).toContain(problem.view)
        expect(problem.prompt.length, problem.id).toBeGreaterThan(0)
        expect(problem.fields.length, problem.id).toBeGreaterThan(0)
      })
    })

    it('has unique field ids, labels and canonical expected answers', () => {
      each((problem) => {
        const ids = problem.fields.map((field) => field.id)
        expect(new Set(ids).size, problem.id).toBe(ids.length)
        for (const field of problem.fields) {
          expect(field.label.trim(), `${problem.id} ${field.id}`).not.toBe('')
          expect(isCanonical(field), `${problem.id} ${field.id}: '${field.expected}'`).toBe(true)
          const kind = field.kind
          if (kind.type === 'hex' || kind.type === 'text' || kind.type === 'decimal') {
            // The answer the page shows is accepted when typed.
            expect(canonicalAnswer(field, field.expectedDisplay), `${problem.id} ${field.id}`).toBe(
              field.expected,
            )
          }
          if (kind.type === 'hex' && kind.digits !== undefined) {
            expect(field.expectedDisplay, `${problem.id} ${field.id}`).toMatch(
              new RegExp(`^0x[0-9a-f]{${kind.digits}}$`),
            )
          }
          if (kind.type === 'choice') {
            const right = kind.choices.find((choice) => choice.id === field.expected)
            expect(right?.label, `${problem.id} ${field.id}`).toBe(field.expectedDisplay)
          }
          if (kind.type === 'chip') {
            const chip = problem.chips?.find((candidate) => candidate.id === field.expected)
            expect(chip?.label, `${problem.id} ${field.id}`).toBe(field.expectedDisplay)
          }
        }
      })
    })

    it('fits its view: trace blocks name real fields, chips only in the trace table', () => {
      each((problem) => {
        const ids = new Set(problem.fields.map((field) => field.id))
        for (const block of problem.prompt) {
          if (block.type !== 'trace') continue
          for (const row of block.rows) expect(ids.has(row.fieldId), problem.id).toBe(true)
        }
        const chipFields = problem.fields.filter((field) => field.kind.type === 'chip')
        if (problem.view === 'trace-table') {
          const labels = (problem.chips ?? []).map((chip) => chip.label)
          expect(labels.length, problem.id).toBeGreaterThan(0)
          expect(new Set(labels).size, `${problem.id}: chip labels are unique`).toBe(labels.length)
        } else {
          expect(chipFields, problem.id).toEqual([])
        }
      })
    })

    it('marks the right answers correct and names no mistake in them', () => {
      each((problem) => {
        const result = checkProblem(problem, rightAnswers(problem))
        expect(result.correct, problem.id).toBe(true)
        expect(result.mistake, problem.id).toBeNull()
        // No predicted wrong answer may equal the right one (never accuse a correct student).
        expect(problem.diagnose(canonicalRight(problem)), problem.id).toBeNull()
      })
    })

    it('marks all-blank answers wrong with the "unanswered" message', () => {
      each((problem) => {
        const result = checkProblem(problem, {})
        expect(result.correct, problem.id).toBe(false)
        expect(result.mistake?.code, problem.id).toBe('unanswered')
      })
    })

    it('never throws in diagnose, whatever the student types', () => {
      each((problem, seed) => {
        for (const answers of junkAnswers(problem, seed)) {
          let mistake: ReturnType<Problem['diagnose']> = null
          expect(
            () => {
              mistake = problem.diagnose(answers)
            },
            `${problem.id} ${JSON.stringify(answers).slice(0, 200)}`,
          ).not.toThrow()
          if (mistake !== null) {
            const { code, message } = mistake as { code: unknown; message: unknown }
            expect(typeof code).toBe('string')
            expect(typeof message === 'string' && message.trim() !== '', problem.id).toBe(true)
          }
        }
      })
    })

    it('gives a one-line reason under 220 characters and clean text', () => {
      each((problem) => {
        expect(problem.reason.trim(), problem.id).not.toBe('')
        expect(problem.reason, problem.id).not.toMatch(/[\r\n]/)
        expect(problem.reason.length, `${problem.id}: ${problem.reason}`).toBeLessThan(220)
        expect(allText(problem), problem.id).not.toMatch(/undefined|NaN|\[object/)
      })
    })

    it('makes a "Show me" payload that survives a share link', () => {
      each((problem) => {
        const decoded = decodePayload(encodePayload(problem.stepper))
        expect(decoded, problem.id).not.toBeNull()
        expect(decoded, problem.id).toEqual(meaningful(problem.stepper))
      })
    })

    it('gives every "Show me" payload a note: what to watch (the stepper also knows a practice link by it)', () => {
      each((problem) => {
        expect(problem.stepper.note?.trim() ?? '', problem.id).not.toBe('')
        expect(problem.stepper.note, problem.id).not.toMatch(/[\r\n]/)
      })
    })

    if (!MAY_NOT_ASSEMBLE.has(topic)) {
      it('makes a "Show me" program that assembles with no warning the student did not cause', () => {
        const allowed = ALLOWED_WARNINGS[topic] ?? []
        each((problem) => {
          const result = assemble(problem.stepper.code, problem.stepper.options)
          const errors = result.diagnostics.filter((item) => item.severity === 'error')
          expect(
            errors.map((item) => item.message),
            problem.id,
          ).toEqual([])
          const warnings = result.diagnostics
            .filter((item) => item.severity === 'warning' && !allowed.includes(item.code))
            .map((item) => item.message)
          expect(warnings, problem.id).toEqual([])
        })
      })

      it('makes a "Show me" program that runs to its end with no warning note on any step', () => {
        // For example the stepper's alignment warning: rsp starts as on a real machine
        // (ending in 8), so a correct program never meets it.
        each((problem) => {
          const made = createEmulator(problem.stepper.code, problem.stepper.options ?? {})
          if (!made.ok) throw new Error(`${problem.id}: "Show me" does not assemble`)
          const notes: string[] = []
          for (
            let step = 0;
            step < 200 && made.emulator.getSnapshot().status === 'running';
            step++
          ) {
            const result = made.emulator.step()
            if (!result.executed) break
            for (const note of result.notes) if (note.kind === 'warning') notes.push(note.text)
          }
          expect(notes, problem.id).toEqual([])
          expect(made.emulator.getSnapshot().status, problem.id).toBe('halted')
        })
      })
    }

    it('generates a problem in under 20 ms on average', () => {
      problems()
      const start = performance.now()
      for (const seed of SEEDS) {
        try {
          GENERATORS[topic](seed)
        } catch {
          // Reported by the first test.
        }
      }
      const average = (performance.now() - start) / SEED_COUNT
      expect(average).toBeLessThan(20)
    })
  })
}
