/**
 * The optional AI tutor: one small function.
 *
 *   GET  /api/tutor   →  { "enabled": true | false }
 *   POST /api/tutor   →  the tutor's reply as plain text, streamed while it is written
 *
 * A reply that does not end normally ends with TUTOR_END_MARK and one word that says why:
 * 'refused', 'empty', 'cut' or 'interrupted'. The drawer cuts the reply at the mark and
 * shows a sentence of its own, so that a failure can be retried and is not mistaken for an
 * answer (src/features/tutor/tutorApi.ts).
 *
 * The same code runs on Vercel (api/tutor.ts), on Netlify (netlify/functions/tutor.ts)
 * and in the Vite dev server (server/devPlugin.ts): it only uses the web-standard
 * `Request` and `Response`.
 *
 * The API key is read from `env.ANTHROPIC_API_KEY`. It goes to the Anthropic client and
 * nowhere else: not into a response, not into a header, not into a log line.
 *
 * Relative imports in this folder end in `.js` (see api/tutor.ts for the reason).
 */
import Anthropic from '@anthropic-ai/sdk'
import {
  RateLimiter,
  clientIpFromHeaders,
  networkOf,
  type RateLimitDecision,
  type RateLimitScope,
} from './rateLimit.js'
import { TUTOR_SYSTEM_PROMPT, formatPageData, type TutorPageData } from './tutorPrompt.js'

/* ───────────────────────────── The contract ───────────────────────────── */

export interface TutorEnv {
  ANTHROPIC_API_KEY?: string
  /** Optional model override. Default: 'claude-opus-5-5'. */
  TUTOR_MODEL?: string
}

/** What is sent to the Messages API (the SDK's own type for a streamed beta message). */
export type TutorApiParams = Parameters<Anthropic['beta']['messages']['stream']>[0]

export type TutorStreamEvent = Anthropic.Beta.BetaRawMessageStreamEvent

/**
 * The one method of the Anthropic client that the tutor calls. The real client fits this
 * shape; tests pass a fake one.
 */
export interface TutorClient {
  beta: {
    messages: {
      stream(
        params: TutorApiParams,
        options?: { signal?: AbortSignal },
      ): AsyncIterable<TutorStreamEvent>
    }
  }
}

export interface TutorDeps {
  /** Injected in tests. Default: a real Anthropic client built from env.ANTHROPIC_API_KEY. */
  createClient?: (apiKey: string) => TutorClient
  /** Injected in tests. Default: Date.now. */
  now?: () => number
  /** Injected in tests. Default: one limiter for this function instance. */
  rateLimiter?: RateLimiter
  /**
   * The client's address, when the platform hands the function a trusted one (Netlify:
   * `context.ip`). Default: read from the request headers (see rateLimit.ts).
   */
  clientIp?: string
}

/** One message of the conversation, as the browser sends it. */
export interface TutorMessage {
  role: 'user' | 'assistant'
  content: string
}

/** The body of a POST, after it passed every check. */
export interface TutorRequest {
  messages: TutorMessage[]
  context: TutorPageData
}

/** The browser trims to the same numbers (src/features/tutor/limits.ts). */
export const TUTOR_LIMITS = {
  /** The browser sends the newest 12 messages; nothing needs more. */
  maxMessages: 12,
  maxMessageChars: 2000,
  maxCodeChars: 12_000,
  maxMachineChars: 6000,
  maxProblemChars: 3000,
  /** The whole request body, in bytes (64 kB). */
  maxBodyBytes: 64_000,
} as const

export const DEFAULT_TUTOR_MODEL = 'claude-opus-5-5'
/** Thinking counts toward this. The reply itself is asked to be short in the system prompt. */
export const TUTOR_MAX_TOKENS = 2000
/** Replies are short hints and must feel quick. */
export const TUTOR_EFFORT = 'low'
/** The beta that lets the API retry a declined request on another model by itself. */
export const TUTOR_FALLBACK_BETA = 'server-side-fallback-2026-07-01'
/** How long the SDK waits for the API to start answering, per try. */
export const TUTOR_API_TIMEOUT_MS = 45_000
/** One more try after a 5xx, a 529 or a broken connection. Never after a 429 (see below). */
export const TUTOR_API_MAX_RETRIES = 1
/**
 * The whole reply has to be done by now. The SDK's own timeout only covers the wait for
 * the first answer of each try, and the function must end before the platform ends it
 * (Netlify: 60 s for a streamed reply; Vercel: `maxDuration` in vercel.json).
 */
export const TUTOR_REPLY_DEADLINE_MS = 50_000
/** How long the function waits for the whole body of a question to arrive. */
export const TUTOR_BODY_TIMEOUT_MS = 10_000

/**
 * Marks the end of a reply that did not end normally; one of TUTOR_END_REASONS follows.
 * The character (BEL) is never part of a reply: it is taken out of the model's text.
 * The browser has the same list (src/features/tutor/tutorApi.ts); a test compares them.
 */
export const TUTOR_END_MARK = '\u0007'
/**
 * - refused:     the model (and its fallback) declined; any text before the mark is not an
 *                answer and is thrown away
 * - empty:       the model stopped without writing any text
 * - cut:         the reply reached the token limit (TUTOR_MAX_TOKENS) and stops in the
 *                middle; the text so far is kept, with a warning
 * - interrupted: the reply broke off (an error, or the reply deadline)
 */
export const TUTOR_END_REASONS = ['refused', 'empty', 'cut', 'interrupted'] as const
export type TutorEndReason = (typeof TUTOR_END_REASONS)[number]

/**
 * The header with the random id that the page makes once per page load. With it, the
 * students who share one internet address (a classroom) are counted one by one.
 */
export const TUTOR_CLIENT_ID_HEADER = 'x-tutor-client'
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * For the log. The SDK's stream iterator does not always throw when the stream fails: an
 * error that arrives while nobody waits for the next event (the reader of the reply is
 * slower than the API) only ends the iteration. A complete message always ends with a
 * `message_stop` event, so an iteration that ends without one is a failure.
 */
const ENDED_EARLY = 'The stream of the reply ended before the message was complete.'

/** The limiter of this function instance. See rateLimit.ts for what it can and cannot do. */
const instanceLimiter = new RateLimiter()

/* ───────────────────────────── Small helpers ───────────────────────────── */

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const

function json(status: number, body: Record<string, unknown>, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers },
  })
}

function badRequest(problem: string): Response {
  return json(400, { error: 'bad-request', message: problem })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Half of a surrogate pair on its own is not valid text for JSON. Replace it. */
function wellFormed(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '�',
  )
}

/**
 * "12 seconds", "1 second", "3 minutes". The drawer has the same words for its countdown
 * (waitInWords in src/features/tutor/tutorApi.ts); a test compares the two.
 */
export function waitInWords(seconds: number): string {
  if (seconds < 90) return seconds === 1 ? '1 second' : `${seconds} seconds`
  const minutes = Math.ceil(seconds / 60)
  return `${minutes} minutes`
}

/* ───────────────────────── Reading and checking ───────────────────────── */

type BodyResult = { ok: true; text: string } | { ok: false; status: 400 | 408; problem: string }

const TOO_LARGE = `The request is too large. The limit is ${TUTOR_LIMITS.maxBodyBytes} bytes.`
const TOO_SLOW = 'The question took too long to arrive. Please send it again.'

/**
 * Read the body as text. Stop as soon as it is longer than the limit, or when it has not
 * arrived after TUTOR_BODY_TIMEOUT_MS (a body that never ends must not keep the function
 * busy until the platform ends it).
 */
async function readBody(request: Request): Promise<BodyResult> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > TUTOR_LIMITS.maxBodyBytes) {
    return { ok: false, status: 400, problem: TOO_LARGE }
  }
  if (request.body === null) return { ok: true, text: '' }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const tooSlow = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TUTOR_BODY_TIMEOUT_MS)
  })
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), tooSlow])
      if (next === null) {
        void reader.cancel().catch(() => undefined)
        return { ok: false, status: 408, problem: TOO_SLOW }
      }
      if (next.done) break
      size += next.value.byteLength
      if (size > TUTOR_LIMITS.maxBodyBytes) {
        void reader.cancel().catch(() => undefined)
        return { ok: false, status: 400, problem: TOO_LARGE }
      }
      chunks.push(next.value)
    }
  } catch {
    return { ok: false, status: 400, problem: 'The request body could not be read.' }
  } finally {
    clearTimeout(timer)
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { ok: false, status: 400, problem: 'The request body is not valid UTF-8 text.' }
  }
}

type ParseResult = { ok: true; request: TutorRequest } | { ok: false; problem: string }

/**
 * Check the body of a POST. Every rule is strict, unknown fields are ignored, and nothing
 * here throws: a body that breaks a rule gets a sentence that says which one.
 */
export function parseTutorRequest(value: unknown): ParseResult {
  const fail = (problem: string): ParseResult => ({ ok: false, problem })
  if (!isRecord(value)) return fail('The body must be a JSON object.')

  const { messages: rawMessages, context: rawContext } = value
  if (!Array.isArray(rawMessages)) return fail('"messages" must be a list.')
  if (rawMessages.length < 1 || rawMessages.length > TUTOR_LIMITS.maxMessages) {
    return fail(`"messages" must hold 1 to ${TUTOR_LIMITS.maxMessages} messages.`)
  }

  const messages: TutorMessage[] = []
  for (const [index, raw] of rawMessages.entries()) {
    const where = `messages[${index}]`
    if (!isRecord(raw)) return fail(`${where} must be an object.`)
    const { role, content } = raw
    if (role !== 'user' && role !== 'assistant') {
      return fail(`${where}.role must be "user" or "assistant".`)
    }
    if (typeof content !== 'string') return fail(`${where}.content must be a string.`)
    if (content.trim() === '') return fail(`${where}.content must not be empty.`)
    if (content.length > TUTOR_LIMITS.maxMessageChars) {
      return fail(`${where}.content is longer than ${TUTOR_LIMITS.maxMessageChars} characters.`)
    }
    if (index > 0 && messages[index - 1]?.role === role) {
      return fail(`${where}.role must not be the same as the role before it.`)
    }
    messages.push({ role, content: wellFormed(content) })
  }
  if (messages[messages.length - 1]?.role !== 'user') {
    return fail('The last message must be from the user.')
  }

  if (!isRecord(rawContext)) return fail('"context" must be an object.')
  const { page, code, machine, problem } = rawContext
  if (page !== 'stepper' && page !== 'practice') {
    return fail('context.page must be "stepper" or "practice".')
  }
  if (typeof code !== 'string') return fail('context.code must be a string.')
  if (code.length > TUTOR_LIMITS.maxCodeChars) {
    return fail(`context.code is longer than ${TUTOR_LIMITS.maxCodeChars} characters.`)
  }
  if (typeof machine !== 'string') return fail('context.machine must be a string.')
  if (machine.length > TUTOR_LIMITS.maxMachineChars) {
    return fail(`context.machine is longer than ${TUTOR_LIMITS.maxMachineChars} characters.`)
  }
  if (problem !== null && typeof problem !== 'string') {
    return fail('context.problem must be a string or null.')
  }
  if (problem !== null && problem.length > TUTOR_LIMITS.maxProblemChars) {
    return fail(`context.problem is longer than ${TUTOR_LIMITS.maxProblemChars} characters.`)
  }

  return {
    ok: true,
    request: {
      messages,
      context: {
        page,
        code: wellFormed(code),
        machine: wellFormed(machine),
        problem: problem === null ? null : wellFormed(problem),
      },
    },
  }
}

/* ──────────────────────────── The API request ──────────────────────────── */

/** The shape of `fetch` that the SDK takes. */
export type TutorFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * A `fetch` for the SDK that keeps it from trying a rate-limited request again.
 *
 * After an API 429 the SDK waits for the whole Retry-After time and then tries once more.
 * The student would wait in silence (until the reply deadline, for a long wait) and then
 * be told to wait again. With `x-should-retry: false`, which the SDK obeys, the 429 comes
 * back at once with the API's wait time. A 5xx, a 529 or a broken connection is still
 * tried once more.
 */
export function withoutRateLimitRetry(fetchImpl: TutorFetch): TutorFetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init)
    if (response.status !== 429) return response
    const headers = new Headers(response.headers)
    headers.set('x-should-retry', 'false')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

/**
 * The real client. The key goes in here and nowhere else.
 * `options.fetch` is for tests; by default the global `fetch` is used, as the SDK does.
 */
export function createAnthropicClient(
  apiKey: string,
  options: { fetch?: TutorFetch } = {},
): TutorClient {
  return new Anthropic({
    apiKey,
    timeout: TUTOR_API_TIMEOUT_MS,
    maxRetries: TUTOR_API_MAX_RETRIES,
    fetch: withoutRateLimitRetry(options.fetch ?? ((input, init) => fetch(input, init))),
  })
}

/**
 * Everything that is sent to the Messages API for one question.
 *
 * - No `thinking` parameter: adaptive thinking is what this model does by default.
 * - `fallbacks: 'default'`: when the model's safety filters decline a request, the API
 *   tries it again on the model Anthropic recommends, inside the same call.
 * - The system prompt never changes, so it is marked for the prompt cache: all students'
 *   questions share it, and a cached read costs a small part of the normal input price.
 *   The page data goes in front of the newest question.
 */
export function buildApiParams(request: TutorRequest, env: TutorEnv): TutorApiParams {
  const { messages, context } = request
  // The API wants the conversation to start with the user. The browser sends the last
  // few messages, and that cut can begin with a reply of the tutor: leave it out.
  const earlier = messages.slice(messages[0]?.role === 'assistant' ? 1 : 0, -1)
  const question = messages[messages.length - 1]?.content ?? ''

  return {
    model: env.TUTOR_MODEL?.trim() || DEFAULT_TUTOR_MODEL,
    max_tokens: TUTOR_MAX_TOKENS,
    system: [{ type: 'text', text: TUTOR_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      ...earlier.map(({ role, content }) => ({ role, content })),
      {
        role: 'user',
        content: [
          { type: 'text', text: formatPageData(context) },
          { type: 'text', text: question },
        ],
      },
    ],
    output_config: { effort: TUTOR_EFFORT },
    betas: [TUTOR_FALLBACK_BETA],
    fallbacks: 'default',
  }
}

/* ───────────────────────────── When it fails ───────────────────────────── */

interface Failure {
  status: number
  error: string
  /** A sentence for the student. */
  message: string
  retryAfterSeconds?: number
}

const NOT_SET_UP: Failure = {
  status: 502,
  error: 'tutor-not-set-up',
  message: 'The tutor is not set up correctly. Please tell your teacher.',
}
const REJECTED: Failure = {
  status: 502,
  error: 'tutor-error',
  message: 'The tutor could not answer this question. Please ask it in another way.',
}
const BUSY: Failure = {
  status: 503,
  error: 'tutor-busy',
  message: 'The tutor is busy right now. Please try again in a moment.',
}
/**
 * The API account behind the key has reached a monthly spend limit: one that the person
 * who runs the site set, or the cap of the account's usage tier. Asking again does not
 * help until the limit is raised (or the month is over), and the question was fine.
 */
const LIMIT_REACHED: Failure = {
  status: 503,
  error: 'tutor-limit-reached',
  message: 'The tutor cannot answer more questions right now. Please tell your teacher.',
}
const CANCELLED: Failure = {
  status: 499,
  error: 'cancelled',
  message: 'The request was cancelled.',
}
const BROKEN: Failure = {
  status: 500,
  error: 'tutor-error',
  message: 'The tutor had a problem. Please try again.',
}

type ApiError = InstanceType<typeof Anthropic.APIError>

/** Any error that the SDK made from an answer of the API (or from a broken connection). */
function isApiError(error: unknown): error is ApiError {
  return error instanceof Anthropic.APIError
}

function apiRateLimited(error: ApiError): Failure {
  const header = Number(error.headers?.get('retry-after') ?? '')
  const seconds = Number.isFinite(header) && header >= 1 ? Math.min(Math.ceil(header), 600) : 20
  return {
    status: 429,
    error: 'rate-limited',
    message: `Many students are asking the tutor right now. Please wait ${waitInWords(seconds)}, then try again.`,
    retryAfterSeconds: seconds,
  }
}

/**
 * The cap of the account's usage tier: 429 with `error.details.error_code`
 * `enforced_spend_limit_reached` and no retry-after (the SDK reads the code into
 * `errorCode`). A spend limit that the person who runs the site set: 400
 * `invalid_request_error`, which has no code; its message starts "You have reached your
 * specified API usage limits" (or "…your specified workspace API usage limits"). Both
 * are described in the Claude API docs, "Rate limits" → "Spend limits".
 */
const OWN_SPEND_LIMIT = /^You have reached your specified (?:workspace )?API usage limits/i

function spendLimitReached(error: ApiError): boolean {
  if (error.errorCode === 'enforced_spend_limit_reached') return true
  return error.status === 400 && OWN_SPEND_LIMIT.test(error.apiMessage ?? '')
}

/** Turn an error of the SDK into what the student is told. Most specific class first. */
function describeFailure(error: unknown): Failure {
  if (error instanceof Anthropic.APIUserAbortError) return CANCELLED
  if (isApiError(error) && spendLimitReached(error)) return LIMIT_REACHED
  if (error instanceof Anthropic.RateLimitError) return apiRateLimited(error)
  if (error instanceof Anthropic.AuthenticationError) return NOT_SET_UP
  if (error instanceof Anthropic.PermissionDeniedError) return NOT_SET_UP
  // A model name that does not exist, or that this key may not use.
  if (error instanceof Anthropic.NotFoundError) return NOT_SET_UP
  if (error instanceof Anthropic.BadRequestError) return REJECTED
  if (error instanceof Anthropic.APIConnectionTimeoutError) return BUSY
  if (error instanceof Anthropic.APIConnectionError) return BUSY
  // 500 and above, which includes 529 "overloaded".
  if (error instanceof Anthropic.InternalServerError) return BUSY
  if (isApiError(error)) {
    // An error that arrived inside the stream has no status, only a type.
    if (error.type === 'rate_limit_error') return apiRateLimited(error)
    if (error.type === 'overloaded_error' || error.type === 'api_error') return BUSY
    if (error.type === 'timeout_error') return BUSY
    if (error.type === 'authentication_error' || error.type === 'permission_error') {
      return NOT_SET_UP
    }
    // 402: the account cannot pay.
    if (error.type === 'billing_error' || error.status === 402) return NOT_SET_UP
    if (error.status === undefined) return BUSY
    return REJECTED
  }
  return BROKEN
}

function failureResponse(failure: Failure): Response {
  const { status, error, message, retryAfterSeconds } = failure
  if (retryAfterSeconds === undefined) return json(status, { error, message })
  return json(
    status,
    { error, message, retryAfterSeconds },
    { 'Retry-After': String(retryAfterSeconds) },
  )
}

/**
 * One line for the server log: the status, the kind of error and the request id, which is
 * what the person who runs the site needs. The key is cut out of the text, in case an
 * error message ever repeats it.
 */
function logFailure(error: unknown, apiKey: string, when: string): void {
  let line: string
  if (isApiError(error)) {
    const status = error.status === undefined ? 'none' : String(error.status)
    const text = (error.apiMessage ?? error.message).slice(0, 300)
    line = `status=${status} type=${error.type ?? 'unknown'} request_id=${error.requestID ?? 'none'} message=${text}`
  } else if (error instanceof Error) {
    line = `${error.name}: ${error.message.slice(0, 300)}`
  } else {
    line = 'unknown error'
  }
  console.error(
    `[tutor] The Anthropic API call failed ${when}: ${line.split(apiKey).join('[key]')}`,
  )
}

/* ───────────────────────────── The reply ───────────────────────────── */

/**
 * Call the Messages API and pass the text of the reply on while it is written.
 *
 * The API reports a bad key, a rate limit or an overload before the first event of the
 * stream. So this waits for that first event: a failure up to there becomes a real HTTP
 * status. After that the reply is under way, and a failure can only end it with
 * TUTOR_END_MARK and a reason.
 */
async function streamReply(
  client: TutorClient,
  params: TutorApiParams,
  request: Request,
  apiKey: string,
): Promise<Response> {
  const upstream = new AbortController()
  let clientGone = false
  let tooLate = false
  const onClientGone = (): void => {
    clientGone = true
    upstream.abort()
  }
  if (request.signal.aborted) return failureResponse(CANCELLED)
  request.signal.addEventListener('abort', onClientGone, { once: true })
  const deadline = setTimeout(() => {
    tooLate = true
    upstream.abort()
  }, TUTOR_REPLY_DEADLINE_MS)
  const release = (): void => {
    clearTimeout(deadline)
    request.signal.removeEventListener('abort', onClientGone)
  }

  let events: AsyncIterator<TutorStreamEvent>
  /** An event that was read but not looked at yet (at first: the first event). */
  let waiting: IteratorResult<TutorStreamEvent> | null
  try {
    events = client.beta.messages
      .stream(params, { signal: upstream.signal })
      [Symbol.asyncIterator]()
    waiting = await events.next()
    if (waiting.done === true) throw new Error(ENDED_EARLY)
  } catch (error) {
    release()
    if (clientGone) return failureResponse(CANCELLED)
    logFailure(error, apiKey, 'before the reply started')
    return failureResponse(tooLate ? BUSY : describeFailure(error))
  }

  const encoder = new TextEncoder()
  let sentText = false
  let stopReason: string | null = null
  /** True once the API has said that the message is complete (`message_stop`). */
  let complete = false
  let cancelled = false

  /** The next piece of reply text, or null when the model has stopped. */
  const nextText = async (): Promise<string | null> => {
    for (;;) {
      const step = waiting ?? (await events.next())
      waiting = null
      if (step.done === true) {
        if (!complete) throw new Error(ENDED_EARLY)
        return null
      }
      const event = step.value
      if (event.type === 'message_stop') {
        complete = true
      } else if (event.type === 'message_delta') {
        stopReason = event.delta.stop_reason ?? stopReason
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        // The end mark must stay a signal of this function, never text of the model.
        const piece = event.delta.text.replaceAll(TUTOR_END_MARK, '')
        if (piece !== '') return piece
      }
    }
  }

  /** Why the reply did not end normally, once the model has stopped; usually nothing. */
  const ending = (): TutorEndReason | null => {
    // The model and its fallback declined. What was written so far is not an answer (the
    // API reference says to throw such a partial reply away), and the drawer does so.
    if (stopReason === 'refusal') return 'refused'
    // For example: the token limit was reached while the model was still thinking.
    if (!sentText) return 'empty'
    // The token limit stopped the reply in the middle: the student must not take half a
    // sentence for a whole reply.
    if (stopReason === 'max_tokens') return 'cut'
    return null
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let reason: TutorEndReason | null
      try {
        const text = await nextText()
        if (text !== null) {
          sentText = true
          controller.enqueue(encoder.encode(text))
          return
        }
        reason = ending()
      } catch (error) {
        // Nobody is listening any more: the browser went away or pressed Stop.
        if (cancelled || clientGone) {
          release()
          if (!cancelled) controller.close()
          return
        }
        logFailure(
          error,
          apiKey,
          tooLate ? 'after the reply started (it took too long)' : 'after the reply started',
        )
        reason = 'interrupted'
      }
      release()
      if (reason !== null) controller.enqueue(encoder.encode(TUTOR_END_MARK + reason))
      controller.close()
    },
    cancel() {
      cancelled = true
      upstream.abort()
      release()
    },
  })

  return new Response(body, {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      // Tells proxies such as nginx to pass every piece on at once.
      'X-Accel-Buffering': 'no',
    },
  })
}

/* ───────────────────────────── The function ───────────────────────────── */

const RATE_LIMIT_MESSAGES: Record<RateLimitScope, (wait: string) => string> = {
  'client-minute': (wait) => `You are asking very fast. Please wait ${wait}, then ask again.`,
  'client-hour': (wait) =>
    `You have asked many questions this hour. Please wait ${wait}, then ask again.`,
  'network-minute': (wait) =>
    `Many students on your internet connection are asking the tutor right now. Please wait ${wait}, then ask again.`,
  'network-hour': (wait) =>
    `Students on your internet connection have asked many questions this hour. Please wait ${wait}, then ask again.`,
  'global-hour': (wait) =>
    `Many students are using the tutor right now. Please wait ${wait}, then ask again.`,
}

function tooManyRequests(decision: Extract<RateLimitDecision, { allowed: false }>): Response {
  const { scope, retryAfterSeconds } = decision
  return failureResponse({
    status: 429,
    error: 'rate-limited',
    message: RATE_LIMIT_MESSAGES[scope](waitInWords(retryAfterSeconds)),
    retryAfterSeconds,
  })
}

/**
 * Who is asking, for the rate limiter: the network of the client's address (see
 * `networkOf`), and this browser on it when the page sent its id.
 */
export function rateLimitKeyOf(
  request: Request,
  trustedIp?: string,
): { client: string; network: string } {
  const network = networkOf(trustedIp?.trim() || clientIpFromHeaders(request.headers))
  const id = (request.headers.get(TUTOR_CLIENT_ID_HEADER) ?? '').trim().toLowerCase()
  return { network, client: CLIENT_ID.test(id) ? `${network}|${id}` : network }
}

/**
 * True for a request that a browser sent from a page of another site (or of another port
 * of the same host). The browser sets `Sec-Fetch-Site` itself, and a page cannot change
 * it. Without CORS headers a browser already keeps other sites from reading a reply; this
 * also keeps them from starting a call that costs money. It matters most in the Vite dev
 * server, which answers CORS checks from other localhost pages by itself. Tools such as
 * curl send no such header: they are let through, and the rate limit applies to them.
 */
function fromAnotherSite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  return site !== null && site !== 'same-origin' && site !== 'none'
}

async function answer(request: Request, env: TutorEnv, deps: TutorDeps): Promise<Response> {
  const apiKey = typeof env.ANTHROPIC_API_KEY === 'string' ? env.ANTHROPIC_API_KEY.trim() : ''
  const method = request.method.toUpperCase()

  if (fromAnotherSite(request)) {
    return json(403, { error: 'forbidden', message: 'The tutor answers only this site.' })
  }
  if (method === 'GET') return json(200, { enabled: apiKey !== '' })
  if (method !== 'POST') {
    return json(
      405,
      { error: 'method-not-allowed', message: 'Use GET or POST.' },
      { Allow: 'GET, POST' },
    )
  }
  if (apiKey === '') {
    return json(503, { error: 'tutor-disabled', message: 'The tutor is turned off.' })
  }

  // A JSON content type also keeps other websites out: a browser asks for permission
  // before it sends JSON to another site, and this function never gives it (no CORS).
  const contentType = (request.headers.get('content-type') ?? '').split(';')[0] ?? ''
  if (contentType.trim().toLowerCase() !== 'application/json') {
    return badRequest('Send the request as JSON (Content-Type: application/json).')
  }

  // A client that is over a limit hears so at once, before its question is read. A
  // request is counted only once it has passed every check below.
  const limiter = deps.rateLimiter ?? instanceLimiter
  const now = deps.now ?? Date.now
  const who = rateLimitKeyOf(request, deps.clientIp)
  const early = limiter.peek(who, now())
  if (!early.allowed) return tooManyRequests(early)

  const body = await readBody(request)
  if (!body.ok) {
    if (body.status === 408) return json(408, { error: 'too-slow', message: body.problem })
    return badRequest(body.problem)
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(body.text)
  } catch {
    return badRequest('The body is not valid JSON.')
  }
  const parsed = parseTutorRequest(parsedJson)
  if (!parsed.ok) return badRequest(parsed.problem)

  const decision = limiter.check(who, now())
  if (!decision.allowed) return tooManyRequests(decision)

  const createClient = deps.createClient ?? createAnthropicClient
  return streamReply(createClient(apiKey), buildApiParams(parsed.request, env), request, apiKey)
}

/**
 * The tutor function. It never throws and never lets the API key out.
 * Same-origin only: it sends no CORS headers, and it refuses a browser request that comes
 * from a page of another site.
 */
export async function handleTutorRequest(
  request: Request,
  env: TutorEnv,
  deps: TutorDeps = {},
): Promise<Response> {
  try {
    return await answer(request, env, deps)
  } catch (error) {
    // Nothing above is expected to throw. If it does, say as little as possible.
    console.error(`[tutor] Unexpected error: ${error instanceof Error ? error.name : 'unknown'}`)
    return failureResponse(BROKEN)
  }
}
