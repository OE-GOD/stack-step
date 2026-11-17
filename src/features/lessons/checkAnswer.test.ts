import { describe, expect, it } from 'vitest'
import { createEmulator } from '../../emulator'
import {
  checkChoice,
  checkHex,
  checkText,
  makeHexKey,
  normalizeText,
  type HexKey,
} from './checkAnswer'
import type { ChoiceQuestion, HexQuestion, TextQuestion } from './types'

const CHOICE: ChoiceQuestion = {
  kind: 'choice',
  prompt: 'Which one?',
  options: [
    { id: 'a', label: 'A', feedback: 'A is the size in bytes.' },
    { id: 'b', label: 'B', correct: true, feedback: 'Right: B.' },
    { id: 'c', label: 'C', feedback: 'C is the size in bits.' },
  ],
}

describe('checkChoice', () => {
  it('gives the chosen option its own feedback', () => {
    expect(checkChoice(CHOICE, 'b')).toEqual({ result: 'right', message: 'Right: B.' })
    expect(checkChoice(CHOICE, 'a')).toEqual({
      result: 'wrong',
      message: 'A is the size in bytes.',
    })
    expect(checkChoice(CHOICE, 'c')).toEqual({ result: 'wrong', message: 'C is the size in bits.' })
  })

  it('asks for a choice when nothing (or an unknown id) is chosen', () => {
    expect(checkChoice(CHOICE, null).result).toBe('retry')
    expect(checkChoice(CHOICE, 'zzz').result).toBe('retry')
  })
})

/** rax after a 32-bit write onto a full register: the answer comes from the emulator. */
function raxAfter(source: string): bigint {
  const made = createEmulator(source)
  if (!made.ok) throw new Error('The program does not assemble.')
  made.emulator.run()
  return made.emulator.readRegister('rax')
}

const HEX: HexQuestion = {
  kind: 'hex',
  prompt: 'What is in rax?',
  label: 'rax =',
  digits: 16,
  answer: () => raxAfter('    mov rax, -1\n    mov eax, 7\n    ret\n'),
  wrongAnswers: [
    { value: () => 0xffffffff00000007n, feedback: 'You kept the top half.' },
    { value: () => 7n, feedback: 'This one equals the answer and is left out.' },
    {
      value: () => {
        throw new Error('broken')
      },
      feedback: 'Never used.',
    },
  ],
  rightFeedback: 'Right: a 32-bit write clears the top half.',
  hint: 'Think about the top 32 bits.',
}

function keyOf(question: HexQuestion): HexKey {
  const made = makeHexKey(question)
  if (!made.ok) throw new Error('makeHexKey failed')
  return made.key
}

describe('makeHexKey', () => {
  it('runs answer() and keeps only the usable wrong answers', () => {
    const key = keyOf(HEX)
    expect(key.answer).toBe(7n)
    expect(key.wrongAnswers).toEqual([
      { value: 0xffffffff00000007n, feedback: 'You kept the top half.' },
    ])
  })

  it('reports an answer() that throws, instead of throwing', () => {
    const broken: HexQuestion = {
      ...HEX,
      answer: () => {
        throw new Error('the program does not assemble')
      },
    }
    const made = makeHexKey(broken)
    expect(made.ok).toBe(false)
  })
})

describe('checkHex', () => {
  const key = keyOf(HEX)
  const check = (typed: string) => checkHex(HEX, key, typed)

  it('accepts the right answer with or without 0x, in any case, with spaces or underscores', () => {
    for (const typed of [
      '0x0000000000000007',
      '0000000000000007',
      '0X0000000000000007',
      '  0x0000 0000 0000 0007  ',
      '0x0000_0000_0000_0007',
    ]) {
      expect(check(typed), typed).toEqual({
        result: 'right',
        message: 'Right: a 32-bit write clears the top half.',
      })
    }
  })

  it('asks for all the digits when fewer are typed, even if the value is right', () => {
    const verdict = check('0x7')
    expect(verdict.result).toBe('retry')
    expect(verdict.message).toContain('Type all 16 hex digits')
    expect(verdict.message).toContain('You typed 1.')
  })

  it('asks for exactly the digits when more are typed', () => {
    const verdict = check('0x00000000000000007')
    expect(verdict).toEqual({
      result: 'retry',
      message: 'Type exactly 16 hex digits. You typed 17.',
    })
  })

  it('gives a known wrong value its own feedback, upper case too', () => {
    expect(check('0xFFFFFFFF00000007')).toEqual({
      result: 'wrong',
      message: 'You kept the top half.',
    })
  })

  it('gives any other wrong value the hint', () => {
    expect(check('0x0000000000000008')).toEqual({
      result: 'wrong',
      message: 'Think about the top 32 bits.',
    })
  })

  it('asks again for a blank answer or text that is not hex', () => {
    expect(check('').result).toBe('retry')
    expect(check('   ').result).toBe('retry')
    const notHex = check('0x12g4')
    expect(notHex.result).toBe('retry')
    expect(notHex.message).toContain('not a hex number')
    expect(check('0x').result).toBe('retry')
  })

  it('accepts any number of digits when the question does not fix them', () => {
    const free: HexQuestion = { ...HEX, digits: undefined }
    const freeKey = keyOf(free)
    expect(checkHex(free, freeKey, '0x7').result).toBe('right')
    expect(checkHex(free, freeKey, '7').result).toBe('right')
    expect(checkHex(free, freeKey, '0x0007').result).toBe('right')
  })

  it('asks for the whole value when only its last digits are typed', () => {
    const rsp: HexQuestion = {
      ...HEX,
      digits: undefined,
      answer: () => 0x7ffffffdd798n,
      wrongAnswers: [{ value: () => 0x98n, feedback: 'A known slip wins.' }],
    }
    const rspKey = keyOf(rsp)
    expect(checkHex(rsp, rspKey, 'd798')).toEqual({
      result: 'retry',
      message: 'Type the whole value, not only its last digits. You typed 4.',
    })
    expect(checkHex(rsp, rspKey, '0xfdd798').result).toBe('retry')
    // A typed 0 at the start counts: 0dd798 is not how the answer ends.
    expect(checkHex(rsp, rspKey, '0x0dd798').result).toBe('wrong')
    // A known wrong value keeps its own feedback, and other endings are just wrong.
    expect(checkHex(rsp, rspKey, '98')).toEqual({ result: 'wrong', message: 'A known slip wins.' })
    expect(checkHex(rsp, rspKey, 'd799')).toEqual({
      result: 'wrong',
      message: 'Think about the top 32 bits.',
    })
    expect(checkHex(rsp, rspKey, '7ffffffdd798').result).toBe('right')
  })
})

const TEXT: TextQuestion = {
  kind: 'text',
  prompt: 'The 16-bit part of r10?',
  label: 'Name',
  answers: ['r10w'],
  wrongAnswers: [{ value: 'r10d', feedback: 'r10d is the 32-bit part.' }],
  rightFeedback: 'Right: r10w.',
  hint: 'Look at the r8 pattern.',
}

describe('checkText', () => {
  it('compares without regard to letter case, spaces or a period at the end', () => {
    expect(normalizeText('  R10W ')).toBe('r10w')
    expect(normalizeText('r10 w.')).toBe('r10w')
    expect(checkText(TEXT, 'r10w')).toEqual({ result: 'right', message: 'Right: r10w.' })
    expect(checkText(TEXT, ' R10W\t').result).toBe('right')
    expect(checkText(TEXT, 'r10 w').result).toBe('right')
    expect(checkText(TEXT, 'r10w.').result).toBe('right')
  })

  it('gives a known wrong answer its own feedback, and anything else the hint', () => {
    expect(checkText(TEXT, 'R10D')).toEqual({
      result: 'wrong',
      message: 'r10d is the 32-bit part.',
    })
    expect(checkText(TEXT, 'r10 d.')).toEqual({
      result: 'wrong',
      message: 'r10d is the 32-bit part.',
    })
    expect(checkText(TEXT, 'r10x')).toEqual({
      result: 'wrong',
      message: 'Look at the r8 pattern.',
    })
  })

  it('asks again for a blank answer', () => {
    expect(checkText(TEXT, '').result).toBe('retry')
    expect(checkText(TEXT, '   ').result).toBe('retry')
    expect(checkText(TEXT, ' . ').result).toBe('retry')
  })
})
