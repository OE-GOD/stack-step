import { describe, expect, it } from 'vitest'
import { canonicalAnswer, checkProblem } from './check'
import type { Field, Mistake, Problem } from './types'

const hexField: Field = {
  id: 'value',
  label: 'rsp after step 1',
  kind: { type: 'hex' },
  expected: '1f8',
  expectedDisplay: '0x1f8',
}

const fullField: Field = {
  id: 'after',
  label: 'rdi',
  kind: { type: 'hex', digits: 16 },
  expected: '9',
  expectedDisplay: '0x0000000000000009',
}

const textField: Field = {
  id: 'name',
  label: 'name',
  kind: { type: 'text' },
  expected: 'r9w',
  expectedDisplay: 'r9w',
}

const decimalField: Field = {
  id: 'bytes',
  label: 'bytes',
  kind: { type: 'decimal' },
  expected: '2',
  expectedDisplay: '2',
}

const choiceField: Field = {
  id: 'verdict',
  label: 'Legal or illegal?',
  kind: {
    type: 'choice',
    choices: [
      { id: 'legal', label: 'Legal' },
      { id: 'memory-to-memory', label: 'Illegal: memory to memory' },
    ],
  },
  expected: 'memory-to-memory',
  expectedDisplay: 'Illegal: memory to memory',
}

function problemWith(
  fields: Field[],
  diagnose: (answers: Readonly<Record<string, string>>) => Mistake | null = () => null,
): Problem {
  return {
    id: 'rsp-tracker-1',
    topic: 'rsp-tracker',
    seed: 1,
    view: 'form',
    prompt: [{ type: 'text', text: 'A test problem.' }],
    fields,
    reason: 'push makes rsp go down by 8.',
    stepper: { code: 'ret\n' },
    diagnose,
  }
}

describe('canonicalAnswer', () => {
  it('returns an empty string for blank input', () => {
    expect(canonicalAnswer(hexField, '')).toBe('')
    expect(canonicalAnswer(hexField, '   ')).toBe('')
    expect(canonicalAnswer(textField, '\t')).toBe('')
  })

  it('reads hex with or without a prefix, in any case, with spaces or underscores', () => {
    for (const typed of ['1f8', '0x1f8', '0X1F8', ' 0x1F8 ', '1 f8', '0x01f8', '0x0000_01F8']) {
      expect(canonicalAnswer(hexField, typed), typed).toBe('1f8')
    }
    expect(canonicalAnswer(hexField, '0')).toBe('0')
    expect(canonicalAnswer(hexField, '0x0000')).toBe('0')
    expect(canonicalAnswer(fullField, '0000 0000 0000 0009')).toBe('9')
    expect(canonicalAnswer(fullField, '0x7FFF FFFF DDFF 8000')).toBe('7fffffffddff8000')
  })

  it('keeps text that is not hex, lower-cased, so it can never match', () => {
    expect(canonicalAnswer(hexField, 'Hello')).toBe('hello')
    expect(canonicalAnswer(hexField, '0x1g8')).toBe('0x1g8')
  })

  it('reads decimal numbers', () => {
    expect(canonicalAnswer(decimalField, '2')).toBe('2')
    expect(canonicalAnswer(decimalField, ' 002 ')).toBe('2')
    expect(canonicalAnswer(decimalField, '+16')).toBe('16')
    expect(canonicalAnswer(decimalField, '-8')).toBe('-8')
    expect(canonicalAnswer(decimalField, '1,024')).toBe('1024')
    expect(canonicalAnswer(decimalField, 'two')).toBe('two')
    expect(canonicalAnswer(decimalField, '0x10')).toBe('0x10')
  })

  it('reads a decimal number with the unit word the field asks for', () => {
    for (const typed of ['2 bytes', '2bytes', '2 byte', '2 BYTES', ' 2  bytes ']) {
      expect(canonicalAnswer(decimalField, typed), typed).toBe('2')
    }
    // The other unit is never the right answer, even with the right number.
    expect(canonicalAnswer(decimalField, '2 bits')).toBe('2 bits')
    expect(canonicalAnswer(decimalField, '16bits')).toBe('16 bits')
    // A field whose label names no unit takes either word.
    const plain: Field = { ...decimalField, label: 'Answer' }
    expect(canonicalAnswer(plain, '2 bits')).toBe('2')
    expect(canonicalAnswer(decimalField, '2 kilobytes')).toBe('2 kilobytes')
  })

  it('normalises text answers', () => {
    expect(canonicalAnswer(textField, ' R9W ')).toBe('r9w')
    expect(canonicalAnswer(textField, 'r9 w')).toBe('r9w')
  })

  it('passes choice and chip ids through', () => {
    expect(canonicalAnswer(choiceField, 'legal')).toBe('legal')
  })
})

describe('checkProblem', () => {
  it('accepts a right answer in any accepted spelling', () => {
    const problem = problemWith([hexField])
    for (const typed of ['1f8', '0x1F8', ' 0x01f8']) {
      const result = checkProblem(problem, { value: typed })
      expect(result.correct, typed).toBe(true)
      expect(result.mistake).toBeNull()
      expect(result.reason).toBe(problem.reason)
      expect(result.fields).toEqual([
        { fieldId: 'value', correct: true, given: typed.trim(), expectedDisplay: '0x1f8' },
      ])
    }
  })

  it('rejects a wrong answer and reports what was typed and what was expected', () => {
    const result = checkProblem(problemWith([hexField]), { value: '0x208' })
    expect(result.correct).toBe(false)
    expect(result.fields[0]).toEqual({
      fieldId: 'value',
      correct: false,
      given: '0x208',
      expectedDisplay: '0x1f8',
    })
  })

  it('needs every field to be right', () => {
    const problem = problemWith([textField, decimalField])
    expect(checkProblem(problem, { name: 'r9w', bytes: '2' }).correct).toBe(true)
    const half = checkProblem(problem, { name: 'r9w', bytes: '16' })
    expect(half.correct).toBe(false)
    expect(half.fields.map((field) => field.correct)).toEqual([true, false])
  })

  it('names a blank part before anything else', () => {
    const diagnose = () => ({ code: 'wrong-part', message: 'never reached' }) as Mistake
    const problem = problemWith([textField, decimalField], diagnose)
    const result = checkProblem(problem, { name: 'r9w' })
    expect(result.correct).toBe(false)
    expect(result.mistake?.code).toBe('unanswered')
    expect(result.mistake?.message).toContain('"bytes"')
    expect(result.fields[1]?.given).toBe('')
  })

  it('says so when nothing was typed at all', () => {
    const one = checkProblem(problemWith([hexField]), {})
    expect(one.mistake).toEqual({ code: 'unanswered', message: 'You did not type an answer yet.' })
    const many = checkProblem(problemWith([textField, decimalField]), { name: ' ', bytes: '' })
    expect(many.mistake?.code).toBe('unanswered')
    // A choice is chosen, not typed.
    expect(checkProblem(problemWith([choiceField]), {}).mistake).toEqual({
      code: 'unanswered',
      message: 'You did not choose an answer yet.',
    })
  })

  it('lists several blank parts', () => {
    const problem = problemWith([hexField, textField, decimalField])
    const result = checkProblem(problem, { value: '1f8' })
    expect(result.mistake?.code).toBe('unanswered')
    expect(result.mistake?.message).toContain('2 parts')
    expect(result.mistake?.message).toContain('"name"')
    expect(result.mistake?.message).toContain('"bytes"')
  })

  it('wants all 16 digits when the field says so', () => {
    const problem = problemWith([fullField])
    expect(checkProblem(problem, { after: '0x0000000000000009' }).correct).toBe(true)
    expect(checkProblem(problem, { after: '0000 0000 0000 0009' }).correct).toBe(true)

    const short = checkProblem(problem, { after: '0x9' })
    expect(short.correct).toBe(false)
    expect(short.mistake?.code).toBe('missing-digits')
    expect(short.mistake?.message).toContain('16')
    expect(short.mistake?.message).toContain('You typed 1')

    const long = checkProblem(problem, { after: '0x00000000000000009' })
    expect(long.correct).toBe(false)
    expect(long.mistake?.code).toBe('missing-digits')
    expect(long.mistake?.message).toBe('Type exactly 16 hex digits for "rdi". You typed 17.')
    expect(short.mistake?.message).toBe('Type all 16 hex digits for "rdi". You typed 1.')
  })

  it('accepts a size typed with the unit the question asks for', () => {
    const problem = problemWith([{ ...decimalField, label: 'Size in bytes' }])
    for (const typed of ['2', '2 bytes', '2bytes', '2 byte']) {
      expect(checkProblem(problem, { bytes: typed }).correct, typed).toBe(true)
    }
  })

  it('names bits-vs-bytes when a size is typed in the other unit', () => {
    const inBytes = problemWith([{ ...decimalField, label: 'Size in bytes', expected: '4' }])
    const bits = checkProblem(inBytes, { bytes: '32 bits' })
    expect(bits.correct).toBe(false)
    expect(bits.mistake).toEqual({
      code: 'bits-vs-bytes',
      message:
        '"Size in bytes" asks for bytes, but you wrote bits. A byte is 8 bits, so 32 bits are 4 bytes.',
    })
    // The right number with the wrong unit is not right either.
    const sameNumber = checkProblem(inBytes, { bytes: '4 bits' })
    expect(sameNumber.correct).toBe(false)
    expect(sameNumber.mistake?.message).toBe(
      '"Size in bytes" asks for bytes, but you wrote bits. A byte is 8 bits.',
    )

    const inBits = problemWith([
      { ...decimalField, id: 'bits', label: 'Size in bits', expected: '8' },
    ])
    expect(checkProblem(inBits, { bits: '1 byte' }).mistake?.message).toBe(
      '"Size in bits" asks for bits, but you wrote bytes. A byte is 8 bits, so 1 byte is 8 bits.',
    )
    expect(checkProblem(inBits, { bits: '8 bits' }).correct).toBe(true)
  })

  it('reports missing digits even when the value is also wrong', () => {
    const result = checkProblem(problemWith([fullField]), { after: '0x1234' })
    expect(result.correct).toBe(false)
    expect(result.mistake?.code).toBe('missing-digits')
  })

  it('asks the problem to name the mistake, with canonical answers', () => {
    const seen: Record<string, string>[] = []
    const diagnose = (answers: Readonly<Record<string, string>>): Mistake | null => {
      seen.push({ ...answers })
      return answers.value === '208'
        ? { code: 'rsp-wrong-direction', message: 'rsp moved the wrong way.' }
        : null
    }
    const problem = problemWith([hexField], diagnose)

    const known = checkProblem(problem, { value: ' 0X208 ' })
    expect(known.mistake).toEqual({
      code: 'rsp-wrong-direction',
      message: 'rsp moved the wrong way.',
    })
    expect(seen).toEqual([{ value: '208' }])

    expect(checkProblem(problem, { value: '0x100' }).mistake).toBeNull()
  })

  it('does not ask the problem when the answer is right', () => {
    let calls = 0
    const problem = problemWith([hexField], () => {
      calls += 1
      return null
    })
    expect(checkProblem(problem, { value: '0x1f8' }).correct).toBe(true)
    expect(calls).toBe(0)
  })

  it('survives a diagnose function that throws', () => {
    const problem = problemWith([hexField], () => {
      throw new Error('generator bug')
    })
    const result = checkProblem(problem, { value: '0x1' })
    expect(result.correct).toBe(false)
    expect(result.mistake).toBeNull()
  })

  it('shows the label of a chosen option', () => {
    const problem = problemWith([choiceField])
    const wrong = checkProblem(problem, { verdict: 'legal' })
    expect(wrong.correct).toBe(false)
    expect(wrong.fields[0]?.given).toBe('Legal')
    expect(wrong.fields[0]?.expectedDisplay).toBe('Illegal: memory to memory')
    expect(checkProblem(problem, { verdict: 'memory-to-memory' }).correct).toBe(true)
  })

  it('treats text that is not a number as wrong, not as blank', () => {
    const result = checkProblem(problemWith([hexField]), { value: 'xyz' })
    expect(result.correct).toBe(false)
    expect(result.mistake).toBeNull()
    expect(result.fields[0]?.given).toBe('xyz')
  })
})
