// @vitest-environment jsdom
/**
 * The content checks for EVERY lesson file in `content/`, including the ones added later.
 *
 * Each file is loaded inside its own group of tests, so a broken file fails only its own
 * tests. The rules come from the lessons specification: the shape of a lesson, an example
 * that runs to the end, a question with exactly one right answer, the words to avoid, and
 * a short body.
 *
 *   npx vitest run src/features/lessons
 */
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it } from 'vitest'
import { LESSONS } from '../../content/lessonList'
import { isTopicId } from '../../content/topics'
import { createEmulator } from '../../emulator'
import { normalizeText } from './checkAnswer'
import { loadLesson, parseLessonFileName, readLessonModule } from './registry'
import type { CheckQuestion, LessonContent } from './types'

const FILES = import.meta.glob<{ default?: unknown }>(['./content/*.tsx', '!./content/*.test.tsx'])
const ENTRIES = Object.entries(FILES).sort(([a], [b]) => a.localeCompare(b))

/** Lesson ids that have a file. */
function idsWithFiles(): string[] {
  return ENTRIES.map(([path]) => parseLessonFileName(path)?.id).filter(
    (id): id is string => id !== undefined,
  )
}

/** Example programs may leave out `.intel_syntax noprefix` and `main:`; nothing else. */
const ALLOWED_WARNINGS = new Set(['no-main', 'missing-intel-syntax'])
const MAX_EXAMPLE_STEPS = 2000
const MAX_BODY_WORDS = 300

/**
 * The longest code line that fits on a 360 px phone without being cut off or making its
 * box scroll sideways, with code at 14 px (measured in a browser; see components/index.ts).
 * The MiniStepper's line numbers take one more character from 10 lines on.
 */
const MAX_EXAMPLE_LINE = 28
const MAX_EXAMPLE_LINE_TWO_DIGIT_NUMBERS = 27
const MAX_QUESTION_LINE = 27
const MAX_BODY_CODE_LINE = 31

/** Lesson code is indented by 2 spaces (not 4 as in the stepper's examples), to fit a phone. */
const INDENT = /^ {2}\S/

/** Words the lessons must not use (lessons specification, rule 4). */
const AVOIDED_WORDS: readonly { pattern: RegExp; name: string }[] = [
  { pattern: /\bdereferenc\w*/i, name: 'dereference' },
  { pattern: /\bclobber\w*/i, name: 'clobber' },
  { pattern: /\bimmediates?\b/i, name: 'immediate' },
  { pattern: /\beffective\s+address/i, name: 'effective address' },
  { pattern: /\btruncat\w*/i, name: 'truncate' },
]
/** Lesson 14 explains these two words; every lesson before it must not use them. */
const CALL_WORDS = /\b(caller|callee)s?\b/i
const LESSON_THAT_EXPLAINS_CALL_WORDS = 14

/**
 * A hex value of 8 or more digits must be written in groups of four, cut from the right,
 * as the machine panels show it: `0x0000 0000 0000 002a`, `0x7fff fffd dff8`. These find
 * one written without the gaps.
 */
const LONG_HEX_IN_TEXT = /\b0x[0-9a-f]{8,}\b/gi
const LONG_HEX_CODE = /^0x[0-9a-f]{8,}$/i

/**
 * The long hex values of a string that are written without gaps. Code in backticks counts
 * only when it is nothing but the number: `mov rax, 0x…` is code that must stay as the
 * assembler reads it.
 */
function ungroupedHex(text: string): string[] {
  return text
    .split('`')
    .flatMap((part, index) =>
      index % 2 === 1
        ? LONG_HEX_CODE.test(part)
          ? [part]
          : []
        : (part.match(LONG_HEX_IN_TEXT) ?? []),
    )
}

/** The same for the rendered body, with its code listings left out. */
function ungroupedHexInBody(box: HTMLElement): string[] {
  const copy = box.cloneNode(true) as HTMLElement
  for (const line of copy.querySelectorAll('[data-line]')) line.remove()
  const found: string[] = []
  for (const code of copy.querySelectorAll('code')) {
    const text = code.textContent ?? ''
    if (LONG_HEX_CODE.test(text)) found.push(text)
    code.remove()
  }
  return [...found, ...(textOf(copy).match(LONG_HEX_IN_TEXT) ?? [])]
}

/** `0x7fff fffd d798` → `0x7ffffffdd798`, so a value is found however it is written. */
function withoutGroupGaps(text: string): string {
  return text.replace(/\b0x[0-9a-f]{1,4}(?: [0-9a-f]{4})+\b/gi, (value) =>
    value.replaceAll(' ', ''),
  )
}

interface Text {
  where: string
  text: string
}

function questionTexts(check: CheckQuestion): Text[] {
  const texts: Text[] = [{ where: 'check.prompt', text: check.prompt }]
  for (const [index, line] of (check.code ?? []).entries()) {
    texts.push({ where: `check.code[${index}]`, text: line })
  }
  if (check.kind === 'choice') {
    for (const option of check.options) {
      texts.push({ where: `option ${option.id} label`, text: option.label })
      texts.push({ where: `option ${option.id} feedback`, text: option.feedback })
    }
    return texts
  }
  texts.push({ where: 'check.label', text: check.label })
  texts.push({ where: 'check.rightFeedback', text: check.rightFeedback })
  texts.push({ where: 'check.hint', text: check.hint })
  for (const [index, wrong] of (check.wrongAnswers ?? []).entries()) {
    texts.push({ where: `check.wrongAnswers[${index}].feedback`, text: wrong.feedback })
  }
  return texts
}

/** Every plain string of a lesson that a student reads. Code comments count too. */
function lessonTexts(content: LessonContent): Text[] {
  const { example } = content
  return [
    { where: 'idea', text: content.idea },
    { where: 'analogy.title', text: content.analogy.title },
    { where: 'analogy.text', text: content.analogy.text },
    { where: 'example.intro', text: example.intro },
    ...example.watchFor.map((text, index) => ({ where: `example.watchFor[${index}]`, text })),
    ...(example.stepper.title === undefined
      ? []
      : [{ where: 'example.stepper.title', text: example.stepper.title }]),
    { where: 'example.stepper.source', text: example.stepper.source },
    ...questionTexts(content.check),
    ...content.recap.map((text, index) => ({ where: `recap[${index}]`, text })),
  ]
}

/** The body as the page shows it, in a DOM element. */
function renderBody(content: LessonContent): HTMLElement {
  const box = document.createElement('div')
  box.innerHTML = renderToStaticMarkup(createElement(Fragment, null, content.body))
  return box
}

/**
 * The text of an element with a space between its pieces, so that two list items or two
 * table cells never run together into one word ("0 or 1.A byte").
 */
function textOf(box: HTMLElement): string {
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
  const pieces: string[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    pieces.push(node.textContent ?? '')
  }
  return pieces.join(' ')
}

/** The words a student reads: hidden parts (line numbers) left out. */
function visibleWords(box: HTMLElement): number {
  const copy = box.cloneNode(true) as HTMLElement
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"], .sr-only')) hidden.remove()
  const words = textOf(copy).split(/\s+/)
  return words.filter((word) => /[\p{L}\p{N}]/u.test(word)).length
}

describe('the lesson files', () => {
  it('are each named NN-<lessonId>.tsx, with the number of that lesson', () => {
    for (const [path] of ENTRIES) {
      const parsed = parseLessonFileName(path)
      expect(parsed, `${path}: the name must be NN-<lessonId>.tsx`).not.toBeNull()
      if (parsed === null) continue
      const lesson = LESSONS.find((candidate) => candidate.id === parsed.id)
      expect(lesson, `${path}: "${parsed.id}" is not an id in lessonList.ts`).toBeDefined()
      expect(parsed.number, `${path}: "${parsed.id}" is lesson ${lesson?.number}`).toBe(
        lesson?.number,
      )
    }
  })

  it('are one file per lesson', () => {
    const ids = idsWithFiles()
    expect(ids).toEqual([...new Set(ids)])
  })

  it('include all 14 lessons', () => {
    expect(idsWithFiles()).toEqual(LESSONS.map((lesson) => lesson.id))
  })
})

describe('the lesson registry', () => {
  it('reads the lesson id and number from a file name', () => {
    expect(parseLessonFileName('./content/01-registers-and-memory.tsx')).toEqual({
      number: 1,
      id: 'registers-and-memory',
    })
    expect(parseLessonFileName('./content/14-calling-convention.tsx')).toEqual({
      number: 14,
      id: 'calling-convention',
    })
    expect(parseLessonFileName('./content/1-mov.tsx')).toBeNull()
    expect(parseLessonFileName('./content/notes.md')).toBeNull()
  })

  it('loads every lesson, ready to show', async () => {
    for (const lesson of LESSONS) {
      const load = await loadLesson(lesson.id)
      expect(load.status, lesson.id).toBe('ready')
      expect(load.status === 'ready' && load.content.id).toBe(lesson.id)
    }
  })

  it('calls a file "broken" when it does not hold the lesson of its name', () => {
    const id = 'mov'
    expect(readLessonModule(id, {}).status).toBe('broken')
    expect(readLessonModule(id, { default: 5 }).status).toBe('broken')
    expect(readLessonModule(id, { default: { id: 'register-names', idea: 'x' } }).status).toBe(
      'broken',
    )
    expect(readLessonModule(id, { default: { id: 'mov' } }).status).toBe('broken')
  })
})

for (const [path, load] of ENTRIES) {
  const fileName = path.slice(path.lastIndexOf('/') + 1)
  const parsed = parseLessonFileName(path)
  const lessonNumber = parsed?.number ?? 0

  describe(fileName, () => {
    let content: LessonContent

    beforeAll(async () => {
      const file = await load()
      expect(file.default, `${fileName} must have a lesson as its default export`).toBeTypeOf(
        'object',
      )
      content = file.default as LessonContent
    })

    it('holds the lesson named in the file name', () => {
      expect(content.id).toBe(parsed?.id)
    })

    it('has an idea, an analogy, things to watch for and a recap', () => {
      expect(content.idea.trim()).not.toBe('')
      expect(content.analogy.title.trim()).not.toBe('')
      expect(content.analogy.text.trim()).not.toBe('')
      expect(content.example.intro.trim()).not.toBe('')

      expect(content.example.watchFor.length, 'watchFor has 2 to 4 entries').toBeGreaterThanOrEqual(
        2,
      )
      expect(content.example.watchFor.length, 'watchFor has 2 to 4 entries').toBeLessThanOrEqual(4)
      for (const item of content.example.watchFor) expect(item.trim()).not.toBe('')

      expect(content.recap.length, 'recap has 2 to 4 entries').toBeGreaterThanOrEqual(2)
      expect(content.recap.length, 'recap has 2 to 4 entries').toBeLessThanOrEqual(4)
      for (const line of content.recap) expect(line.trim()).not.toBe('')

      if (content.practiceTopic !== undefined) {
        expect(isTopicId(content.practiceTopic), 'practiceTopic is a topic id').toBe(true)
      }
    })

    it('closes every pair of backticks in its strings', () => {
      for (const { where, text } of lessonTexts(content)) {
        if (where === 'example.stepper.source') continue
        const count = text.split('`').length - 1
        expect(count % 2, `${where} has a backtick without a partner: ${text}`).toBe(0)
      }
    })

    it('has an example that assembles and runs to the end', () => {
      const { source, options, stdin } = content.example.stepper
      const made = createEmulator(source, {
        ...options,
        ...(stdin === undefined ? {} : { stdin }),
        maxSteps: MAX_EXAMPLE_STEPS,
      })
      expect(made.diagnostics.map((problem) => problem.message)).toEqual(
        made.diagnostics
          .filter((problem) => problem.severity === 'warning' && ALLOWED_WARNINGS.has(problem.code))
          .map((problem) => problem.message),
      )
      if (!made.ok) return
      const run = made.emulator.run()
      expect(run.reason, run.message).toBe('halted')
    })

    it('has code lines short enough for a phone', () => {
      const lines = content.example.stepper.source.replace(/\n$/, '').split('\n')
      const limit = lines.length >= 10 ? MAX_EXAMPLE_LINE_TWO_DIGIT_NUMBERS : MAX_EXAMPLE_LINE
      for (const [index, line] of lines.entries()) {
        expect(line.includes('\t'), `example line ${index + 1} has a tab`).toBe(false)
        expect(
          line.length,
          `example line ${index + 1} has ${line.length} characters (at most ${limit}): ${line}`,
        ).toBeLessThanOrEqual(limit)
      }
      for (const [index, line] of (content.check.code ?? []).entries()) {
        expect(line.includes('\t'), `question line ${index + 1} has a tab`).toBe(false)
        expect(
          line.length,
          `question line ${index + 1} has ${line.length} characters (at most ${MAX_QUESTION_LINE}): ${line}`,
        ).toBeLessThanOrEqual(MAX_QUESTION_LINE)
      }
      const bodyLines = [...renderBody(content).querySelectorAll('li[data-line] code')].map(
        (code) => (code.textContent ?? '').replace(/\s+$/, ''),
      )
      for (const line of bodyLines) {
        expect(
          line.length,
          `body code has ${line.length} characters (at most ${MAX_BODY_CODE_LINE}): ${line}`,
        ).toBeLessThanOrEqual(MAX_BODY_CODE_LINE)
      }
    })

    it('indents its code by 2 spaces', () => {
      const code = [
        ...content.example.stepper.source.split('\n'),
        ...(content.check.code ?? []),
        ...[...renderBody(content).querySelectorAll('li[data-line] code')].map(
          (line) => line.textContent ?? '',
        ),
      ]
      for (const line of code) {
        if (/^\s/.test(line) && line.trim() !== '') {
          expect(line, 'indent lesson code by 2 spaces').toMatch(INDENT)
        }
      }
    })

    it('does not print the answer of its hex question anywhere else on the page', () => {
      const { check } = content
      if (check.kind !== 'hex') return
      const digits = check.answer().toString(16)
      // The answer in hex, with or without zeros in front: `0x404040`, `0x0000000000000099`.
      const printed = new RegExp(`(?<![0-9a-z])0x0*${digits}(?![0-9a-f])`, 'i')
      const texts: Text[] = [
        { where: 'idea', text: content.idea },
        { where: 'analogy.text', text: content.analogy.text },
        { where: 'example.intro', text: content.example.intro },
        ...content.example.watchFor.map((text, index) => ({
          where: `example.watchFor[${index}]`,
          text,
        })),
        { where: 'body', text: textOf(renderBody(content)) },
        ...content.recap.map((text, index) => ({ where: `recap[${index}]`, text })),
      ]
      for (const { where, text } of texts) {
        expect(
          printed.test(withoutGroupGaps(text)),
          `${where} shows the answer 0x${digits}: ${text}`,
        ).toBe(false)
      }
    })

    it('writes long hex values in groups of four, as the panels show them', () => {
      const prose = lessonTexts(content).filter(
        ({ where }) => where !== 'example.stepper.source' && !where.startsWith('check.code'),
      )
      for (const { where, text } of prose) {
        expect(ungroupedHex(text), `${where}: write it as 0x0000 0000 0000 002a: ${text}`).toEqual(
          [],
        )
      }
      expect(ungroupedHexInBody(renderBody(content)), 'body').toEqual([])
    })

    it('has one well-formed check question', () => {
      const { check } = content
      expect(check.prompt.trim()).not.toBe('')

      if (check.kind === 'choice') {
        expect(check.options.length, 'a choice has 3 or 4 options').toBeGreaterThanOrEqual(3)
        expect(check.options.length, 'a choice has 3 or 4 options').toBeLessThanOrEqual(4)
        expect(check.options.filter((option) => option.correct === true)).toHaveLength(1)
        const ids = check.options.map((option) => option.id)
        const labels = check.options.map((option) => option.label)
        expect(new Set(ids).size, 'option ids are different').toBe(ids.length)
        expect(new Set(labels).size, 'option labels are different').toBe(labels.length)
        for (const option of check.options) {
          expect(option.id.trim(), 'every option has an id').not.toBe('')
          expect(option.label.trim(), `option ${option.id} has a label`).not.toBe('')
          expect(option.feedback.trim(), `option ${option.id} has feedback`).not.toBe('')
        }
        return
      }

      expect(check.label.trim()).not.toBe('')
      expect(check.rightFeedback.trim()).not.toBe('')
      expect(check.hint.trim()).not.toBe('')

      if (check.kind === 'hex') {
        // The answer comes from the emulator: answer() must run without throwing.
        const answer = check.answer()
        expect(typeof answer, 'answer() returns a bigint').toBe('bigint')
        expect(answer >= 0n, 'a typed hex answer is never negative').toBe(true)
        if (check.digits !== undefined) {
          expect(Number.isInteger(check.digits) && check.digits >= 1 && check.digits <= 16).toBe(
            true,
          )
          expect(
            answer < 16n ** BigInt(check.digits),
            `the answer fits in ${check.digits} digits`,
          ).toBe(true)
        }
        const values = new Set<bigint>()
        for (const [index, wrong] of (check.wrongAnswers ?? []).entries()) {
          const value = wrong.value()
          expect(typeof value, `wrongAnswers[${index}] returns a bigint`).toBe('bigint')
          expect(value, `wrongAnswers[${index}] differs from the answer`).not.toBe(answer)
          expect(values.has(value), `wrongAnswers[${index}] is listed once`).toBe(false)
          expect(wrong.feedback.trim(), `wrongAnswers[${index}] has feedback`).not.toBe('')
          values.add(value)
        }
        return
      }

      expect(check.answers.length, 'at least one accepted answer').toBeGreaterThanOrEqual(1)
      const accepted = new Set(check.answers.map(normalizeText))
      for (const answer of check.answers) {
        expect(
          answer,
          'accepted answers are written in lower case, without spaces at the ends',
        ).toBe(normalizeText(answer))
        expect(answer).not.toBe('')
      }
      for (const [index, wrong] of (check.wrongAnswers ?? []).entries()) {
        expect(
          accepted.has(normalizeText(wrong.value)),
          `wrongAnswers[${index}] is not accepted`,
        ).toBe(false)
        expect(wrong.feedback.trim(), `wrongAnswers[${index}] has feedback`).not.toBe('')
      }
    })

    it('uses none of the words to avoid', () => {
      const texts = [...lessonTexts(content), { where: 'body', text: textOf(renderBody(content)) }]
      for (const { where, text } of texts) {
        for (const { pattern, name } of AVOIDED_WORDS) {
          expect(pattern.test(text), `${where} uses "${name}": ${text}`).toBe(false)
        }
        if (lessonNumber !== LESSON_THAT_EXPLAINS_CALL_WORDS) {
          expect(
            CALL_WORDS.test(text),
            `${where} uses caller/callee before lesson 14: ${text}`,
          ).toBe(false)
        }
      }
    })

    it(`has a body under ${MAX_BODY_WORDS} words`, () => {
      const words = visibleWords(renderBody(content))
      expect(words).toBeGreaterThan(0)
      expect(words).toBeLessThan(MAX_BODY_WORDS)
    })
  })
}
