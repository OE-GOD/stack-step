import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChatStore, type AskFunction, type ChatStore } from './chatStore'
import type { TutorPayload } from './payload'
import type { AskOptions, AskResult, TutorFailure } from './tutorApi'
import type { TutorContext } from './context'

const CONTEXT: TutorContext = {
  page: 'stepper',
  code: 'push rbx',
  machine: 'rsp = 0x7ffffffddff0',
  problem: null,
}
const getContext = (): TutorContext => CONTEXT

const BUSY: TutorFailure = { kind: 'busy', message: 'The tutor is busy right now.' }

/** One call of the stand-in for `askTutor`: the test decides when and how it ends. */
interface Call {
  payload: TutorPayload
  options: AskOptions
  /** A piece of the reply arrives. */
  say: (textSoFar: string) => void
  finish: (result: AskResult) => void
}

/**
 * A store with a stand-in for `askTutor`. Like the real one, the stand-in ends with
 * "stopped" when its signal is aborted.
 */
function setup(): { store: ChatStore; calls: Call[]; last: () => Call } {
  const calls: Call[] = []
  const ask: AskFunction = (payload, options) =>
    new Promise<AskResult>((resolve) => {
      let said = ''
      const call: Call = {
        payload,
        options,
        say: (text) => {
          said = text
          options.onText(text)
        },
        finish: resolve,
      }
      options.signal.addEventListener('abort', () => resolve({ status: 'stopped', text: said }))
      calls.push(call)
    })
  const last = (): Call => {
    const call = calls[calls.length - 1]
    if (call === undefined) throw new Error('The tutor was not asked.')
    return call
  }
  return { store: createChatStore(ask), calls, last }
}

/** Let the promises of the store settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function answer(
  test: ReturnType<typeof setup>,
  question: string,
  reply: string,
): Promise<void> {
  expect(test.store.send(question, getContext)).toBe(true)
  test.last().say(reply)
  test.last().finish({ status: 'done', text: reply })
  await settle()
}

const rolesOf = (payload: TutorPayload): string[] => payload.messages.map((message) => message.role)

describe('a question and its reply', () => {
  it('starts empty and idle', () => {
    const { store } = setup()
    expect(store.getSnapshot()).toEqual({ turns: [], busy: false, waitSeconds: 0 })
  })

  it('goes from waiting to streaming to done', async () => {
    const test = setup()
    const { store } = test
    expect(store.send('  Why did rsp change?  ', getContext)).toBe(true)
    expect(store.getSnapshot()).toEqual({
      busy: true,
      waitSeconds: 0,
      turns: [
        { id: 1, question: 'Why did rsp change?', reply: '', state: 'waiting', failure: null },
      ],
    })

    test.last().say('Look at ')
    expect(store.getSnapshot().turns[0]).toMatchObject({ reply: 'Look at ', state: 'streaming' })
    expect(store.getSnapshot().busy).toBe(true)
    test.last().say('Look at line 3.')
    expect(store.getSnapshot().turns[0]?.reply).toBe('Look at line 3.')

    test.last().finish({ status: 'done', text: 'Look at line 3.' })
    await settle()
    expect(store.getSnapshot()).toEqual({
      busy: false,
      waitSeconds: 0,
      turns: [
        {
          id: 1,
          question: 'Why did rsp change?',
          reply: 'Look at line 3.',
          state: 'done',
          failure: null,
        },
      ],
    })
  })

  it('sends the question with the page data of that moment', () => {
    const test = setup()
    let step = 1
    const live = vi.fn((): TutorContext => ({
      ...CONTEXT,
      machine: `step ${step}`,
      code: `line ${step}`,
    }))
    test.store.send('First?', live)
    expect(live).toHaveBeenCalledTimes(1)
    expect(test.last().payload).toEqual({
      messages: [{ role: 'user', content: 'First?' }],
      context: { page: 'stepper', code: 'line 1', machine: 'step 1', problem: null },
    })
    // The page changes while the tutor answers: that reply was about the old page.
    step = 2
    expect(live).toHaveBeenCalledTimes(1)
  })

  it('does not send an empty question, or a second one while a reply is arriving', async () => {
    const test = setup()
    expect(test.store.send('', getContext)).toBe(false)
    expect(test.store.send('   \n ', getContext)).toBe(false)
    expect(test.calls).toHaveLength(0)

    expect(test.store.send('One?', getContext)).toBe(true)
    expect(test.store.send('Two?', getContext)).toBe(false)
    expect(test.calls).toHaveLength(1)
    expect(test.store.getSnapshot().turns).toHaveLength(1)

    test.last().finish({ status: 'done', text: 'Answer one.' })
    await settle()
    expect(test.store.send('Two?', getContext)).toBe(true)
    expect(test.calls).toHaveLength(2)
  })
})

describe('what the tutor is told about the conversation so far', () => {
  it('sends the finished questions and replies before the new question', async () => {
    const test = setup()
    await answer(test, 'One?', 'Answer one.')
    await answer(test, 'Two?', 'Answer two.')
    test.store.send('Three?', getContext)
    expect(test.last().payload.messages).toEqual([
      { role: 'user', content: 'One?' },
      { role: 'assistant', content: 'Answer one.' },
      { role: 'user', content: 'Two?' },
      { role: 'assistant', content: 'Answer two.' },
      { role: 'user', content: 'Three?' },
    ])
  })

  it('leaves out a question that failed, so the roles still take turns', async () => {
    const test = setup()
    await answer(test, 'One?', 'Answer one.')
    test.store.send('Two?', getContext)
    test.last().say('Half an ans')
    test.last().finish({ status: 'failed', text: 'Half an ans', failure: BUSY })
    await settle()
    expect(test.store.getSnapshot().turns[1]).toMatchObject({
      state: 'failed',
      reply: 'Half an ans',
      failure: BUSY,
    })

    test.store.send('Three?', getContext)
    expect(test.last().payload.messages).toEqual([
      { role: 'user', content: 'One?' },
      { role: 'assistant', content: 'Answer one.' },
      { role: 'user', content: 'Three?' },
    ])
    // The failed question is still shown to the student.
    expect(test.store.getSnapshot().turns.map((turn) => turn.question)).toEqual([
      'One?',
      'Two?',
      'Three?',
    ])
  })

  it('keeps a stopped reply that has text, and leaves out one that has none', async () => {
    const test = setup()
    test.store.send('One?', getContext)
    test.store.stop()
    await settle()
    expect(test.store.getSnapshot().turns[0]).toMatchObject({ state: 'stopped', reply: '' })

    test.store.send('Two?', getContext)
    test.last().say('The start of an answer')
    test.store.stop()
    await settle()
    expect(test.store.getSnapshot().turns[1]).toMatchObject({
      state: 'stopped',
      reply: 'The start of an answer',
    })

    test.store.send('Three?', getContext)
    expect(test.last().payload.messages).toEqual([
      { role: 'user', content: 'Two?' },
      { role: 'assistant', content: 'The start of an answer' },
      { role: 'user', content: 'Three?' },
    ])
  })

  it('sends the newest 12 messages at most, always starting with the student', async () => {
    const test = setup()
    for (let index = 1; index <= 9; index += 1) {
      await answer(test, `Question ${index}?`, `Answer ${index}.`)
      const sent = test.last().payload.messages
      expect(sent.length).toBeLessThanOrEqual(12)
      expect(sent[0]?.role).toBe('user')
      expect(sent[sent.length - 1]).toEqual({ role: 'user', content: `Question ${index}?` })
      expect(rolesOf(test.last().payload).join(' ')).toMatch(/^user( assistant user)*$/)
    }
    // The 9th question went out with the 5 pairs before it.
    expect(test.last().payload.messages).toHaveLength(11)
    expect(test.last().payload.messages[0]?.content).toBe('Question 4?')
    // The student still sees all nine.
    expect(test.store.getSnapshot().turns).toHaveLength(9)
  })
})

describe('Stop', () => {
  it('aborts the request and keeps what had arrived', async () => {
    const test = setup()
    test.store.send('One?', getContext)
    test.last().say('Look at')
    expect(test.last().options.signal.aborted).toBe(false)

    test.store.stop()
    expect(test.last().options.signal.aborted).toBe(true)
    await settle()
    expect(test.store.getSnapshot()).toEqual({
      busy: false,
      waitSeconds: 0,
      turns: [{ id: 1, question: 'One?', reply: 'Look at', state: 'stopped', failure: null }],
    })
  })

  it('does nothing when no reply is arriving', async () => {
    const test = setup()
    test.store.stop()
    await answer(test, 'One?', 'Answer one.')
    test.store.stop()
    expect(test.store.getSnapshot().turns[0]?.state).toBe('done')
  })
})

describe('Try again', () => {
  it('asks the last question again after a failure, with fresh page data', async () => {
    const test = setup()
    await answer(test, 'One?', 'Answer one.')
    test.store.send('Two?', getContext)
    test.last().finish({ status: 'failed', text: '', failure: BUSY })
    await settle()

    const later = vi.fn((): TutorContext => ({ ...CONTEXT, machine: 'after the failure' }))
    expect(test.store.retry(later)).toBe(true)
    expect(later).toHaveBeenCalledTimes(1)
    expect(test.store.getSnapshot()).toMatchObject({
      busy: true,
      turns: [
        { state: 'done' },
        { id: 2, question: 'Two?', reply: '', state: 'waiting', failure: null },
      ],
    })
    expect(test.calls).toHaveLength(3)
    expect(test.last().payload.messages).toEqual([
      { role: 'user', content: 'One?' },
      { role: 'assistant', content: 'Answer one.' },
      { role: 'user', content: 'Two?' },
    ])
    expect(test.last().payload.context.machine).toBe('after the failure')

    test.last().finish({ status: 'done', text: 'Answer two.' })
    await settle()
    expect(test.store.getSnapshot().turns[1]).toMatchObject({ state: 'done', reply: 'Answer two.' })
    // The same turn was answered: there is no second copy of the question.
    expect(test.store.getSnapshot().turns).toHaveLength(2)
  })

  it('also works after Stop, and throws the half reply away', async () => {
    const test = setup()
    test.store.send('One?', getContext)
    test.last().say('Half')
    test.store.stop()
    await settle()
    expect(test.store.retry(getContext)).toBe(true)
    expect(test.store.getSnapshot().turns[0]).toMatchObject({ reply: '', state: 'waiting' })
    expect(test.last().payload.messages).toEqual([{ role: 'user', content: 'One?' }])
  })

  it('is only for the last turn, when it failed or was stopped, and nothing is arriving', async () => {
    const test = setup()
    expect(test.store.retry(getContext)).toBe(false)

    await answer(test, 'One?', 'Answer one.')
    expect(test.store.retry(getContext)).toBe(false) // it is done

    test.store.send('Two?', getContext)
    expect(test.store.retry(getContext)).toBe(false) // it is still arriving
    test.last().finish({ status: 'failed', text: '', failure: BUSY })
    await settle()

    await answer(test, 'Three?', 'Answer three.')
    expect(test.store.retry(getContext)).toBe(false) // the failed one is not the last
    expect(test.calls).toHaveLength(3)
  })
})

describe('after the tutor said "please wait" (429)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const pleaseWait = (seconds: number): TutorFailure => ({
    kind: 'rate-limited',
    message: `You are asking very fast. Please wait ${seconds} seconds, then ask again.`,
    retryAfterSeconds: seconds,
  })

  /** The clock and the interval timer are fake; the promises of the store settle as usual. */
  function fakeClock(): void {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  }

  it('blocks questions and counts the wait down once a second', async () => {
    fakeClock()
    const test = setup()
    test.store.send('One?', getContext)
    test.last().finish({ status: 'failed', text: '', failure: pleaseWait(3) })
    await settle()
    expect(test.store.getSnapshot()).toMatchObject({ busy: false, waitSeconds: 3 })
    // Neither "Try again" nor a new question goes out: the tutor would only say no again.
    expect(test.store.retry(getContext)).toBe(false)
    expect(test.store.send('Two?', getContext)).toBe(false)
    expect(test.calls).toHaveLength(1)

    const seen: number[] = []
    test.store.subscribe(() => seen.push(test.store.getSnapshot().waitSeconds))
    vi.advanceTimersByTime(1000)
    vi.advanceTimersByTime(1000)
    expect(test.store.getSnapshot().waitSeconds).toBe(1)
    expect(test.store.send('Two?', getContext)).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([2, 1, 0])
    // Then the timer stops by itself.
    vi.advanceTimersByTime(5000)
    expect(seen).toEqual([2, 1, 0])
    expect(vi.getTimerCount()).toBe(0)

    expect(test.store.retry(getContext)).toBe(true)
    expect(test.calls).toHaveLength(2)
  })

  it('keeps the wait after New chat: the tutor would still say no', async () => {
    fakeClock()
    const test = setup()
    test.store.send('One?', getContext)
    test.last().finish({ status: 'failed', text: '', failure: pleaseWait(2) })
    await settle()
    test.store.reset()
    expect(test.store.getSnapshot()).toEqual({ turns: [], busy: false, waitSeconds: 2 })
    expect(test.store.send('Fresh?', getContext)).toBe(false)
    vi.advanceTimersByTime(2000)
    expect(test.store.getSnapshot().waitSeconds).toBe(0)
    expect(test.store.send('Fresh?', getContext)).toBe(true)
  })

  it('does not wait when the tutor did not say how long (a host’s own 429)', async () => {
    const test = setup()
    test.store.send('One?', getContext)
    const noTime: TutorFailure = { kind: 'rate-limited', message: 'Please wait a moment.' }
    test.last().finish({ status: 'failed', text: '', failure: noTime })
    await settle()
    expect(test.store.getSnapshot().waitSeconds).toBe(0)
    expect(test.store.retry(getContext)).toBe(true)
  })
})

describe('New chat', () => {
  it('forgets everything', async () => {
    const test = setup()
    await answer(test, 'One?', 'Answer one.')
    test.store.reset()
    expect(test.store.getSnapshot()).toEqual({ turns: [], busy: false, waitSeconds: 0 })

    test.store.send('Fresh?', getContext)
    expect(test.last().payload.messages).toEqual([{ role: 'user', content: 'Fresh?' }])
  })

  it('stops a reply that is arriving, and ignores whatever still comes from it', async () => {
    const test = setup()
    test.store.send('One?', getContext)
    const old = test.last()
    old.say('Half')
    test.store.reset()
    expect(old.options.signal.aborted).toBe(true)
    expect(test.store.getSnapshot()).toEqual({ turns: [], busy: false, waitSeconds: 0 })

    // A new conversation starts while the old request is still winding down.
    test.store.send('Two?', getContext)
    old.say('Half and more')
    old.finish({ status: 'done', text: 'An answer nobody asked for.' })
    await settle()
    expect(test.store.getSnapshot()).toEqual({
      busy: true,
      waitSeconds: 0,
      turns: [{ id: 2, question: 'Two?', reply: '', state: 'waiting', failure: null }],
    })
  })
})

describe('when something unexpected happens', () => {
  it('fails the turn when the page cannot say what it shows', async () => {
    const test = setup()
    const broken = (): TutorContext => {
      throw new Error('the page has a bug')
    }
    expect(test.store.send('One?', broken)).toBe(true)
    expect(test.calls).toHaveLength(0)
    expect(test.store.getSnapshot()).toMatchObject({
      busy: false,
      turns: [{ state: 'failed', failure: { kind: 'rejected' } }],
    })
    // The student can try again once the page works.
    expect(test.store.retry(getContext)).toBe(true)
    test.last().finish({ status: 'done', text: 'Fine now.' })
    await settle()
    expect(test.store.getSnapshot().turns[0]).toMatchObject({ state: 'done', reply: 'Fine now.' })
  })

  it('fails the turn when the page hands over something that is not text', () => {
    const test = setup()
    const broken = (): TutorContext => ({ ...CONTEXT, code: undefined as unknown as string })
    expect(test.store.send('One?', broken)).toBe(true)
    expect(test.calls).toHaveLength(0)
    expect(test.store.getSnapshot()).toMatchObject({
      busy: false,
      turns: [{ state: 'failed', failure: { kind: 'rejected' } }],
    })
  })

  it('fails the turn when the request itself throws', async () => {
    const store = createChatStore(() => Promise.reject(new Error('unexpected')))
    store.send('One?', getContext)
    await settle()
    expect(store.getSnapshot()).toMatchObject({
      busy: false,
      turns: [
        { state: 'failed', failure: { message: 'The tutor had a problem. Please try again.' } },
      ],
    })
  })
})

describe('listeners', () => {
  it('are told about every change, until they unsubscribe', async () => {
    const test = setup()
    const listener = vi.fn()
    const unsubscribe = test.store.subscribe(listener)

    test.store.send('One?', getContext)
    expect(listener).toHaveBeenCalledTimes(1)
    test.last().say('Look')
    expect(listener).toHaveBeenCalledTimes(2)
    test.last().finish({ status: 'done', text: 'Look.' })
    await settle()
    expect(listener).toHaveBeenCalledTimes(3)

    unsubscribe()
    test.store.reset()
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('get a new snapshot object for every change, and the same one in between', () => {
    const test = setup()
    const before = test.store.getSnapshot()
    expect(test.store.getSnapshot()).toBe(before)

    test.store.send('One?', getContext)
    const waiting = test.store.getSnapshot()
    expect(waiting).not.toBe(before)
    expect(test.store.getSnapshot()).toBe(waiting)

    test.last().say('Look')
    expect(test.store.getSnapshot()).not.toBe(waiting)
    // An earlier snapshot is never changed after the fact.
    expect(waiting.turns[0]?.reply).toBe('')
    expect(before.turns).toEqual([])
  })
})
