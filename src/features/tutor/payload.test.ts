import { describe, expect, it } from 'vitest'
import { TUTOR_CLIENT_LIMITS as LIMITS } from './limits'
import { buildTutorPayload, clip, payloadBytes, type ChatMessage } from './payload'
import type { TutorContext } from './context'

const CONTEXT: TutorContext = {
  page: 'stepper',
  code: 'main:\n    push rbx\n    ret\n',
  machine: 'rsp = 0x7ffffffddff0',
  problem: null,
}

/** `pairs` finished questions with their replies, oldest first. */
function history(pairs: number, size = 20): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let index = 1; index <= pairs; index += 1) {
    messages.push(
      { role: 'user', content: `question ${index} `.padEnd(size, 'q') },
      { role: 'assistant', content: `reply ${index} `.padEnd(size, 'r') },
    )
  }
  return messages
}

describe('clip', () => {
  it('leaves a text alone that is short enough', () => {
    expect(clip('hello', 5)).toBe('hello')
    expect(clip('', 5, '…')).toBe('')
  })

  it('cuts a longer text to the limit, mark included', () => {
    expect(clip('abcdefghij', 6)).toBe('abcdef')
    expect(clip('abcdefghij', 6, '…')).toBe('abcde…')
    expect(clip('abcdefghij', 6, ' (cut)')).toBe(' (cut)')
    expect(clip('abcdefghij', 3, ' (cut)')).toHaveLength(3)
  })

  it('never leaves half of an emoji at the end', () => {
    const text = 'ab😀cd'
    // A cut after 3 characters would keep only the first half of the emoji.
    expect(clip(text, 3)).toBe('ab')
    expect(clip(text, 4)).toBe('ab😀')
    expect(clip(text, 4, '…')).toBe('ab…')
  })
})

describe('buildTutorPayload', () => {
  it('puts the question last, after the earlier messages, with the page data', () => {
    const payload = buildTutorPayload(history(2), 'And now?', CONTEXT)
    expect(payload.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ])
    expect(payload.messages[4]).toEqual({ role: 'user', content: 'And now?' })
    expect(payload.context).toEqual(CONTEXT)
    expect(Object.keys(payload).sort()).toEqual(['context', 'messages'])
  })

  it('works for the very first question', () => {
    const payload = buildTutorPayload([], 'First?', CONTEXT)
    expect(payload.messages).toEqual([{ role: 'user', content: 'First?' }])
  })

  it('sends the newest 12 messages at most, and starts with the student', () => {
    expect(LIMITS.maxMessages).toBe(12)
    // 5 pairs + the question = 11 messages: everything is sent.
    expect(buildTutorPayload(history(5), 'Q', CONTEXT).messages).toHaveLength(11)

    // 6 pairs + the question = 13. The newest 12 would start with a reply of the tutor,
    // so that reply goes too: 11 messages, starting with question 2.
    const more = buildTutorPayload(history(6), 'Q', CONTEXT).messages
    expect(more).toHaveLength(11)
    expect(more[0]?.role).toBe('user')
    expect(more[0]?.content).toMatch(/^question 2 /)
    expect(more[10]).toEqual({ role: 'user', content: 'Q' })

    const many = buildTutorPayload(history(40), 'Q', CONTEXT).messages
    expect(many).toHaveLength(11)
    expect(many[0]?.content).toMatch(/^question 36 /)
    for (const [index, message] of many.entries()) {
      expect(message.role).toBe(index % 2 === 0 ? 'user' : 'assistant')
    }
  })

  it('cuts a long reply of the tutor to the limit for one message', () => {
    const long: ChatMessage[] = [
      { role: 'user', content: 'Explain everything.' },
      { role: 'assistant', content: 'x'.repeat(5000) },
    ]
    const payload = buildTutorPayload(long, 'Thanks. And now?', CONTEXT)
    const reply = payload.messages[1]?.content ?? ''
    expect(reply).toHaveLength(LIMITS.maxMessageChars)
    expect(reply.endsWith(' …')).toBe(true)
  })

  it('cuts the code, the machine summary and the problem to their limits, and says so', () => {
    const payload = buildTutorPayload([], 'Q', {
      page: 'practice',
      code: 'mov eax, 1\n'.repeat(3000),
      machine: 'm'.repeat(9000),
      problem: 'p'.repeat(5000),
    })
    const { code, machine, problem } = payload.context
    expect(code).toHaveLength(LIMITS.maxCodeChars)
    expect(code.endsWith('# (The code is longer than this. The rest was cut off.)')).toBe(true)
    expect(machine).toHaveLength(LIMITS.maxMachineChars)
    expect(machine.endsWith('(The text is longer than this. The rest was cut off.)')).toBe(true)
    expect(problem).toHaveLength(LIMITS.maxProblemChars)
    expect(payload.context.page).toBe('practice')
  })

  it('does not touch page data that is short enough', () => {
    const exact = {
      page: 'practice' as const,
      code: 'c'.repeat(LIMITS.maxCodeChars),
      machine: 's'.repeat(LIMITS.maxMachineChars),
      problem: 'p'.repeat(LIMITS.maxProblemChars),
    }
    expect(buildTutorPayload([], 'Q', exact).context).toEqual(exact)
    expect(buildTutorPayload([], 'Q', { ...CONTEXT, problem: null }).context.problem).toBeNull()
  })

  it('does not change what it was given', () => {
    const given = history(8)
    const copy = structuredClone(given)
    const context = { ...CONTEXT, code: 'x'.repeat(20_000) }
    buildTutorPayload(given, 'Q', context)
    expect(given).toEqual(copy)
    expect(context.code).toHaveLength(20_000)
  })

  it('keeps the whole body under 64 kB by forgetting the oldest questions first', () => {
    // Chinese text takes 3 bytes per character: 11 full messages are about 66 kB.
    const wide = history(5).map((message) => ({ ...message, content: '汉'.repeat(2000) }))
    const question = '问'.repeat(2000)
    const payload = buildTutorPayload(wide, question, CONTEXT)

    expect(payloadBytes(payload)).toBeLessThanOrEqual(LIMITS.maxBodyBytes)
    // One whole pair was dropped, not more: the student still starts, the question is
    // still last, and the page data was left alone.
    expect(payload.messages).toHaveLength(9)
    expect(payload.messages[0]?.role).toBe('user')
    expect(payload.messages[8]).toEqual({ role: 'user', content: question })
    expect(payload.context).toEqual(CONTEXT)

    // The same conversation in English fits as it is.
    expect(buildTutorPayload(history(5, 2000), 'q'.repeat(2000), CONTEXT).messages).toHaveLength(11)
  })

  it('shortens the page data only when the question alone is still too large', () => {
    const huge: TutorContext = {
      page: 'practice',
      code: '😀'.repeat(6000), // 12 000 characters, 24 000 bytes
      machine: '汉'.repeat(6000), // 18 000 bytes
      problem: '汉'.repeat(3000), // 9 000 bytes
    }
    const small = buildTutorPayload([], 'Q', huge)
    expect(small.context).toEqual(huge)

    // Text that JSON has to escape doubles in size: 12 000 quotes are 24 000 bytes, and
    // the control character below takes 6 bytes each time.
    const worst: TutorContext = {
      page: 'practice',
      code: '\u0001'.repeat(12_000), // 72 000 bytes in JSON
      machine: '"'.repeat(6000),
      problem: null,
    }
    const payload = buildTutorPayload(history(5), 'Q', worst)
    expect(payloadBytes(payload)).toBeLessThanOrEqual(LIMITS.maxBodyBytes)
    expect(payload.messages).toEqual([{ role: 'user', content: 'Q' }])
    expect(payload.context.code.length).toBeLessThan(12_000)
    expect(payload.context.code.endsWith('The rest was cut off.)')).toBe(true)
    expect(payload.context.machine).toBe(worst.machine)
  })
})
