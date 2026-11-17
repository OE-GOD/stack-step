import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TutorPayload } from './payload'
import { TUTOR_ENDPOINT, fetchTutorEnabled } from './availability'
import {
  TUTOR_CLIENT_ID_HEADER,
  TUTOR_END_MARK,
  TUTOR_REFUSAL_TEXT,
  askTutor,
  tutorClientId,
  waitInWords,
} from './tutorApi'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const PAYLOAD: TutorPayload = {
  messages: [{ role: 'user', content: 'Why did rsp change?' }],
  context: { page: 'stepper', code: 'push rbx', machine: 'rsp = 0x7ffffffddff0', problem: null },
}

type FetchArguments = Parameters<typeof fetch>

/** A stand-in for fetch that answers with `respond` and remembers how it was called. */
function fakeFetch(respond: (...call: FetchArguments) => Response | Promise<Response>) {
  const calls: FetchArguments[] = []
  const fetchImpl: typeof fetch = (...call) => {
    calls.push(call)
    try {
      return Promise.resolve(respond(...call))
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
  return { fetchImpl, calls }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  })
}

function plain(body: BodyInit | null, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

const encoder = new TextEncoder()

/** A reply that arrives in the given pieces, one per read. */
function inPieces(pieces: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const left = [...pieces]
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = left.shift()
      if (next === undefined) controller.close()
      else controller.enqueue(typeof next === 'string' ? encoder.encode(next) : next)
    },
  })
}

async function ask(response: Response | (() => Response), signal = new AbortController().signal) {
  const seen: string[] = []
  const { fetchImpl, calls } = fakeFetch(() =>
    typeof response === 'function' ? response() : response,
  )
  const result = await askTutor(PAYLOAD, {
    signal,
    onText: (text) => seen.push(text),
    fetch: fetchImpl,
  })
  return { result, seen, calls }
}

describe('fetchTutorEnabled', () => {
  it('is true only for JSON that says enabled: true', async () => {
    const answer = (response: Response) => fetchTutorEnabled(fakeFetch(() => response).fetchImpl)
    expect(await answer(json(200, { enabled: true }))).toBe(true)
    expect(await answer(json(200, { enabled: false }))).toBe(false)
    expect(await answer(json(200, { enabled: 'true' }))).toBe(false)
    expect(await answer(json(200, { enabled: 1 }))).toBe(false)
    expect(await answer(json(200, {}))).toBe(false)
    expect(await answer(json(200, [true]))).toBe(false)
    expect(await answer(json(200, null))).toBe(false)
  })

  it('is false when there is no function (404), or when it fails', async () => {
    const answer = (response: Response) => fetchTutorEnabled(fakeFetch(() => response).fetchImpl)
    expect(await answer(new Response('Not found', { status: 404 }))).toBe(false)
    expect(await answer(json(404, { enabled: true }))).toBe(false)
    expect(await answer(json(500, { error: 'tutor-dev-error' }))).toBe(false)
    expect(await answer(json(503, { enabled: true }))).toBe(false)
  })

  it('is false when a static host answers with the HTML page of the site', async () => {
    const page = new Response('<!doctype html><html><body>Stack Step</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })
    expect(await fetchTutorEnabled(fakeFetch(() => page).fetchImpl)).toBe(false)
    // JSON in the body does not count when the host says it is something else.
    const mislabeled = new Response('{"enabled":true}', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })
    expect(await fetchTutorEnabled(fakeFetch(() => mislabeled).fetchImpl)).toBe(false)
  })

  it('is false when the body is not JSON after all, or the network fails', async () => {
    const broken = new Response('{"enabled":', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    expect(await fetchTutorEnabled(fakeFetch(() => broken).fetchImpl)).toBe(false)
    const offline = fakeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    expect(await fetchTutorEnabled(offline.fetchImpl)).toBe(false)
  })

  it('asks /api/tutor with a plain GET that is not cached', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { enabled: true }))
    await fetchTutorEnabled(fetchImpl)
    expect(calls).toHaveLength(1)
    const [url, init] = calls[0] ?? []
    expect(url).toBe('api/tutor')
    expect(TUTOR_ENDPOINT).toBe('api/tutor')
    expect(init?.method).toBeUndefined()
    expect(init?.cache).toBe('no-store')
    expect(init?.body).toBeUndefined()
  })
})

describe('TUTOR_ENDPOINT', () => {
  it('is next to the page: the root of a site, or its folder on GitHub Pages', () => {
    expect(new URL(TUTOR_ENDPOINT, 'https://stack-step.example/').href).toBe(
      'https://stack-step.example/api/tutor',
    )
    expect(new URL(TUTOR_ENDPOINT, 'https://someone.github.io/stack-step/').href).toBe(
      'https://someone.github.io/stack-step/api/tutor',
    )
  })
})

describe('askTutor: a reply', () => {
  it('posts the payload as JSON to /api/tutor', async () => {
    const { calls } = await ask(plain('ok'))
    expect(calls).toHaveLength(1)
    const [url, init] = calls[0] ?? []
    expect(url).toBe('api/tutor')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    const body = init?.body
    if (typeof body !== 'string') throw new Error('The body must be a JSON string.')
    expect(JSON.parse(body)).toEqual(PAYLOAD)
    expect(init?.cache).toBe('no-store')
  })

  it('sends the id of this page load with every question, the same id each time', async () => {
    const first = await ask(plain('ok'))
    const second = await ask(plain('ok'))
    const idOf = (call: FetchArguments | undefined) =>
      new Headers(call?.[1]?.headers).get(TUTOR_CLIENT_ID_HEADER)
    const id = idOf(first.calls[0])
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(idOf(second.calls[0])).toBe(id)
    expect(tutorClientId()).toBe(id)
    // The id is never stored: it lives in this module only, and a reload makes a new one.
    vi.resetModules()
    const reloaded = await import('./tutorApi')
    expect(reloaded.tutorClientId()).not.toBe(id)
  })

  it('makes a page id also where crypto.randomUUID is missing (plain http)', async () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => real.getRandomValues(bytes),
    })
    vi.resetModules()
    const fresh = await import('./tutorApi')
    const ids = new Set([fresh.tutorClientId(), fresh.tutorClientId()])
    expect(ids.size).toBe(1)
    expect([...ids][0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('reports the text as it grows, piece by piece', async () => {
    const { result, seen } = await ask(plain(inPieces(['Look at ', 'line 3. ', 'What changed?'])))
    expect(seen).toEqual(['Look at ', 'Look at line 3. ', 'Look at line 3. What changed?'])
    expect(result).toEqual({ status: 'done', text: 'Look at line 3. What changed?' })
  })

  it('keeps a character whole when its bytes arrive in two pieces', async () => {
    const bytes = encoder.encode('é 你 😀!')
    // Cut inside the two-byte é, inside the three-byte 你 and inside the four-byte emoji.
    const pieces = [
      bytes.slice(0, 1),
      bytes.slice(1, 4),
      bytes.slice(4, 8),
      bytes.slice(8, 9),
      bytes.slice(9),
    ]
    const { result, seen } = await ask(plain(inPieces(pieces)))
    expect(result).toEqual({ status: 'done', text: 'é 你 😀!' })
    // No piece ever showed a broken character.
    for (const text of seen) expect(text).not.toContain('�')
    expect(seen[seen.length - 1]).toBe('é 你 😀!')
  })

  it('reports nothing for an empty piece', async () => {
    const { seen } = await ask(plain(inPieces(['', 'a', '', 'b'])))
    expect(seen).toEqual(['a', 'ab'])
  })

  it('treats an empty reply as a failure', async () => {
    for (const body of ['', '  \n ']) {
      const { result } = await ask(plain(body))
      expect(result).toEqual({
        status: 'failed',
        text: '',
        failure: { kind: 'empty', message: 'The tutor sent an empty reply. Please try again.' },
      })
    }
  })

  it('does not take the HTML page of a static host for a reply', async () => {
    const page = () =>
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    const { result, seen } = await ask(page)
    expect(seen).toEqual([])
    expect(result).toMatchObject({
      status: 'failed',
      failure: {
        kind: 'not-set-up',
        message: 'The tutor is not available on this site right now.',
      },
    })
  })
})

describe('askTutor: a reply that the tutor function ended with the end mark', () => {
  const mark = TUTOR_END_MARK

  it('"interrupted": a failure that keeps the text, so the student can ask again', async () => {
    const { result, seen } = await ask(
      plain(inPieces(['Look at ', 'line 4.', `${mark}interrupted`])),
    )
    expect(seen).toEqual(['Look at ', 'Look at line 4.'])
    expect(result).toEqual({
      status: 'failed',
      text: 'Look at line 4.',
      failure: {
        kind: 'interrupted',
        message:
          'The tutor had a problem and stopped before the reply was finished. Please try again.',
      },
    })
  })

  it('"interrupted" before any text: a failure with no text', async () => {
    const { result, seen } = await ask(plain(`${mark}interrupted`))
    expect(seen).toEqual([])
    expect(result).toMatchObject({ status: 'failed', text: '', failure: { kind: 'interrupted' } })
  })

  it('"empty": the empty-reply failure', async () => {
    const { result } = await ask(plain(`${mark}empty`))
    expect(result).toEqual({
      status: 'failed',
      text: '',
      failure: { kind: 'empty', message: 'The tutor sent an empty reply. Please try again.' },
    })
  })

  it('"cut": the text stays, with a warning that the reply was cut off at its length limit', async () => {
    const { result, seen } = await ask(plain(inPieces(['First, look at ', 'line', `${mark}cut`])))
    expect(seen).toEqual(['First, look at ', 'First, look at line'])
    expect(result).toEqual({
      status: 'failed',
      text: 'First, look at line',
      failure: {
        kind: 'interrupted',
        message:
          'The reply was too long, so it was cut off. Try again, or ask about one thing at a time.',
      },
    })
  })

  it('"refused": one plain sentence in place of the reply, also of text that came first', async () => {
    expect(TUTOR_REFUSAL_TEXT).toBe("I can't help with that. Ask me about your assembly code.")
    const before = await ask(plain(`${mark}refused`))
    expect(before.result).toEqual({ status: 'done', text: TUTOR_REFUSAL_TEXT })
    const after = await ask(plain(inPieces(['First you ', `${mark}refused`])))
    expect(after.seen).toEqual(['First you '])
    expect(after.result).toEqual({ status: 'done', text: TUTOR_REFUSAL_TEXT })
  })

  it('reads the mark and its word also when they arrive in pieces', async () => {
    const { result, seen } = await ask(plain(inPieces(['Look', `${mark}inter`, 'rupted'])))
    expect(seen).toEqual(['Look'])
    expect(result).toMatchObject({
      status: 'failed',
      text: 'Look',
      failure: { kind: 'interrupted' },
    })
  })

  it('treats a word it does not know as "interrupted"', async () => {
    const { result } = await ask(plain(`Look${mark}something-new`))
    expect(result).toMatchObject({
      status: 'failed',
      text: 'Look',
      failure: { kind: 'interrupted' },
    })
  })

  it('never shows the mark, also when the connection breaks right after it', async () => {
    let reads = 0
    const breaking = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1
        if (reads === 1) controller.enqueue(encoder.encode(`Look at${mark}inter`))
        else controller.error(new TypeError('network error'))
      },
    })
    const { result, seen } = await ask(plain(breaking))
    expect(seen).toEqual(['Look at'])
    expect(result).toMatchObject({ status: 'failed', text: 'Look at' })
  })
})

describe('askTutor: what the student is told when it fails', () => {
  async function failureOf(response: Response) {
    const { result, seen } = await ask(response)
    expect(seen).toEqual([])
    if (result.status !== 'failed') throw new Error(`Expected a failure, got ${result.status}.`)
    expect(result.text).toBe('')
    return result.failure
  }

  it('429: the sentence of the function, with the wait time', async () => {
    const failure = await failureOf(
      json(
        429,
        {
          error: 'rate-limited',
          message: 'You are asking very fast. Please wait 12 seconds, then ask again.',
          retryAfterSeconds: 12,
        },
        { 'Retry-After': '12' },
      ),
    )
    expect(failure).toEqual({
      kind: 'rate-limited',
      message: 'You are asking very fast. Please wait 12 seconds, then ask again.',
      // The drawer counts this down before the question can be sent again.
      retryAfterSeconds: 12,
    })
  })

  it('429 without a sentence: the wait time from the body or from Retry-After', async () => {
    expect((await failureOf(json(429, { retryAfterSeconds: 7 }))).message).toBe(
      'The tutor is getting too many questions. Please wait 7 seconds, then ask again.',
    )
    const hostPage = new Response('<h1>Too Many Requests</h1>', {
      status: 429,
      headers: { 'Content-Type': 'text/html', 'Retry-After': '120' },
    })
    expect(await failureOf(hostPage)).toEqual({
      kind: 'rate-limited',
      message: 'The tutor is getting too many questions. Please wait 2 minutes, then ask again.',
      retryAfterSeconds: 120,
    })
    // No wait time at all (Netlify's own rate limit sends none): nothing to count down.
    expect(await failureOf(new Response(null, { status: 429 }))).toEqual({
      kind: 'rate-limited',
      message: 'The tutor is getting too many questions. Please wait a moment, then ask again.',
    })
    expect(await failureOf(json(429, { retryAfterSeconds: 0.2 }))).toEqual({
      kind: 'rate-limited',
      message: 'The tutor is getting too many questions. Please wait a moment, then ask again.',
    })
    const rounded = await failureOf(json(429, { retryAfterSeconds: 2.5 }))
    expect(rounded.message).toContain('wait 3 seconds')
    expect(rounded.retryAfterSeconds).toBe(3)
  })

  it('408: the question took too long to arrive', async () => {
    expect(
      await failureOf(
        json(408, {
          error: 'too-slow',
          message: 'The question took too long to arrive. Please send it again.',
        }),
      ),
    ).toEqual({
      kind: 'network',
      message: 'The question took too long to arrive. Please send it again.',
    })
    expect((await failureOf(new Response(null, { status: 408 }))).message).toBe(
      'The question took too long to reach the tutor. Please try again.',
    )
  })

  it('503: busy', async () => {
    const fromFunction = await failureOf(
      json(503, {
        error: 'tutor-busy',
        message: 'The tutor is busy right now. Please try again in a moment.',
      }),
    )
    expect(fromFunction).toEqual({
      kind: 'busy',
      message: 'The tutor is busy right now. Please try again in a moment.',
    })
    const fromHost = await failureOf(new Response('Service Unavailable', { status: 503 }))
    expect(fromHost).toEqual(fromFunction)
  })

  it('503 tutor-disabled: turned off', async () => {
    const failure = await failureOf(
      json(503, { error: 'tutor-disabled', message: 'The tutor is turned off.' }),
    )
    expect(failure).toEqual({ kind: 'not-set-up', message: 'The tutor is turned off right now.' })
  })

  it('503 tutor-limit-reached: the spend limit is used up, so the teacher has to act', async () => {
    const message = 'The tutor cannot answer more questions right now. Please tell your teacher.'
    expect(await failureOf(json(503, { error: 'tutor-limit-reached', message }))).toEqual({
      kind: 'not-set-up',
      message,
    })
    // Without a sentence of the function: the same words.
    expect(await failureOf(json(503, { error: 'tutor-limit-reached' }))).toEqual({
      kind: 'not-set-up',
      message,
    })
  })

  it('502: not set up, or a question that could not be answered', async () => {
    expect(
      await failureOf(
        json(502, {
          error: 'tutor-not-set-up',
          message: 'The tutor is not set up correctly. Please tell your teacher.',
        }),
      ),
    ).toEqual({
      kind: 'not-set-up',
      message: 'The tutor is not set up correctly. Please tell your teacher.',
    })
    expect(await failureOf(json(502, { error: 'tutor-not-set-up' }))).toEqual({
      kind: 'not-set-up',
      message: 'The tutor is not set up correctly. Please tell your teacher.',
    })
    expect(await failureOf(json(502, { error: 'tutor-error' }))).toEqual({
      kind: 'rejected',
      message: 'The tutor could not answer this question. Please ask it in another way.',
    })
    // A "Bad Gateway" page of the host: the function was not reached.
    expect(await failureOf(new Response('<h1>Bad Gateway</h1>', { status: 502 }))).toEqual({
      kind: 'busy',
      message: 'The tutor is busy right now. Please try again in a moment.',
    })
  })

  it('504, 400, 413, 404, 405 and anything else', async () => {
    const empty = (status: number) => new Response(null, { status })
    expect((await failureOf(empty(504))).message).toBe(
      'The tutor took too long to answer. Please try again.',
    )
    expect(await failureOf(json(400, { error: 'bad-request', message: 'messages[0]…' }))).toEqual({
      kind: 'rejected',
      message: 'The tutor could not read this question. Try a shorter question.',
    })
    expect((await failureOf(empty(413))).kind).toBe('rejected')
    expect(await failureOf(empty(404))).toEqual({
      kind: 'not-set-up',
      message: 'The tutor is not available on this site right now.',
    })
    expect((await failureOf(empty(405))).kind).toBe('not-set-up')
    expect(await failureOf(empty(500))).toEqual({
      kind: 'busy',
      message: 'The tutor had a problem. Please try again.',
    })
    expect((await failureOf(empty(418))).message).toBe('The tutor had a problem. Please try again.')
  })

  it('does not show a sentence that is not a short text', async () => {
    const long = await failureOf(json(503, { error: 'tutor-busy', message: 'x'.repeat(301) }))
    expect(long.message).toBe('The tutor is busy right now. Please try again in a moment.')
    const odd = await failureOf(json(503, { error: 'tutor-busy', message: { html: '<b>' } }))
    expect(odd.message).toBe('The tutor is busy right now. Please try again in a moment.')
  })

  it('a network failure', async () => {
    const offline = fakeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const result = await askTutor(PAYLOAD, {
      signal: new AbortController().signal,
      onText: () => undefined,
      fetch: offline.fetchImpl,
    })
    expect(result).toEqual({
      status: 'failed',
      text: '',
      failure: {
        kind: 'network',
        message: 'The tutor could not be reached. Check your internet connection, then try again.',
      },
    })
  })

  it('a reply that breaks off keeps the text that had arrived', async () => {
    let reads = 0
    const breaking = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1
        if (reads === 1) controller.enqueue(encoder.encode('Look at '))
        else controller.error(new TypeError('network error'))
      },
    })
    const { result, seen } = await ask(plain(breaking))
    expect(seen).toEqual(['Look at '])
    expect(result).toEqual({
      status: 'failed',
      text: 'Look at ',
      failure: {
        kind: 'interrupted',
        message: 'The connection was lost before the reply was finished. Please try again.',
      },
    })
  })
})

describe('askTutor: Stop', () => {
  it('is "stopped", not a failure, when the student stops before the reply starts', async () => {
    const stopper = new AbortController()
    const pending = fakeFetch((_url, init) => {
      // Like the real fetch: it rejects when its signal is aborted.
      stopper.abort()
      throw new DOMException(String(init?.signal?.aborted), 'AbortError')
    })
    const result = await askTutor(PAYLOAD, {
      signal: stopper.signal,
      onText: () => undefined,
      fetch: pending.fetchImpl,
    })
    expect(result).toEqual({ status: 'stopped', text: '' })
  })

  it('keeps the text that had arrived when the student stops in the middle', async () => {
    const stopper = new AbortController()
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1
        if (reads === 1) {
          controller.enqueue(encoder.encode('Look at line'))
          return
        }
        // The next piece never comes: the student presses Stop, and the read fails.
        stopper.abort()
        controller.error(new DOMException('The user aborted a request.', 'AbortError'))
      },
    })
    const { result, seen } = await ask(plain(body), stopper.signal)
    expect(seen).toEqual(['Look at line'])
    expect(result).toEqual({ status: 'stopped', text: 'Look at line' })
  })

  it('passes the signal on to fetch', async () => {
    const stopper = new AbortController()
    const { calls } = await ask(plain('ok'), stopper.signal)
    expect(calls[0]?.[1]?.signal).toBe(stopper.signal)
  })
})

describe('askTutor never throws', () => {
  it('whatever fetch does', async () => {
    const strange: (() => Response)[] = [
      () => {
        throw new Error('boom')
      },
      () => new Response(null, { status: 200 }),
      () => new Response('{"message": 5}', { status: 429 }),
      () => json(503, 'a string'),
      () => json(502, null),
    ]
    for (const respond of strange) {
      const onText = vi.fn()
      const result = await askTutor(PAYLOAD, {
        signal: new AbortController().signal,
        onText,
        fetch: fakeFetch(respond).fetchImpl,
      })
      expect(result.status).toBe('failed')
    }
  })
})

describe('waitInWords', () => {
  it('says seconds for a short wait and minutes for a long one', () => {
    expect(waitInWords(1)).toBe('1 second')
    expect(waitInWords(2)).toBe('2 seconds')
    expect(waitInWords(89)).toBe('89 seconds')
    expect(waitInWords(90)).toBe('2 minutes')
    expect(waitInWords(1800)).toBe('30 minutes')
    expect(waitInWords(1801)).toBe('31 minutes')
  })
})
