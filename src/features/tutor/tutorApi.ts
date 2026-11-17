/**
 * Sends a question to the tutor function (`POST /api/tutor`) and reads the reply while
 * it is written.
 *
 * Nothing here throws. Whatever goes wrong becomes a `TutorFailure` with a sentence that
 * a student can read.
 *
 * (The question "is the tutor on?" is in availability.ts. It is kept apart so that a
 * page without a tutor downloads only those few lines.)
 */
import { TUTOR_ENDPOINT } from './availability'
import type { TutorPayload } from './payload'

export type TutorFailureKind =
  /** Too many questions: the student has to wait. */
  | 'rate-limited'
  /** The tutor (or the service behind it) is busy or down for a moment. */
  | 'busy'
  /** The person who runs the site has to fix something. */
  | 'not-set-up'
  /** This one question could not be answered. */
  | 'rejected'
  /** The request did not reach the tutor. */
  | 'network'
  /** The reply started and then broke off. */
  | 'interrupted'
  /** The reply was empty. */
  | 'empty'

export interface TutorFailure {
  kind: TutorFailureKind
  /** One or two plain sentences for the student. */
  message: string
  /** For 'rate-limited': how many seconds to wait before asking again, when the tutor said. */
  retryAfterSeconds?: number
}

export type AskResult =
  | { status: 'done'; text: string }
  /** The student stopped the reply. `text` is what had arrived. */
  | { status: 'stopped'; text: string }
  /** `text` is what had arrived before it went wrong (often nothing). */
  | { status: 'failed'; text: string; failure: TutorFailure }

export interface AskOptions {
  /** Abort it to stop the reply (the Stop button). */
  signal: AbortSignal
  /** Called with the whole reply so far, every time it grows. */
  onText: (textSoFar: string) => void
  /** For tests. Default: the browser's fetch. */
  fetch?: typeof fetch
}

/**
 * The tutor function ends a reply that did not end normally with this character and one
 * of these words (server/tutorCore.ts has the same list; a test compares the two). The
 * text before the mark is shown; the mark and the word never are.
 */
export const TUTOR_END_MARK = '\u0007'
export const TUTOR_END_REASONS = ['refused', 'empty', 'cut', 'interrupted'] as const

/** What the tutor says when it declined to answer. It takes the place of any partial text. */
export const TUTOR_REFUSAL_TEXT = "I can't help with that. Ask me about your assembly code."

/** The header that carries `tutorClientId()`. */
export const TUTOR_CLIENT_ID_HEADER = 'X-Tutor-Client'

let clientId: string | null = null

/**
 * A random id, made once per page load and kept in memory only (never stored). The tutor
 * function counts each id on its own, so the students who share one internet address (a
 * classroom, a campus Wi-Fi) do not share one limit. A reload makes a new id.
 */
export function tutorClientId(): string {
  clientId ??= randomId()
  return clientId
}

function randomId(): string {
  // randomUUID works only on a secure page (https, localhost). The dev server can also be
  // opened over plain http from another computer of the network.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** "12 seconds", "1 second", "3 minutes". */
export function waitInWords(seconds: number): string {
  if (seconds < 90) return seconds === 1 ? '1 second' : `${seconds} seconds`
  return `${Math.ceil(seconds / 60)} minutes`
}

const NETWORK: TutorFailure = {
  kind: 'network',
  message: 'The tutor could not be reached. Check your internet connection, then try again.',
}
/** The connection broke while the reply was arriving. */
const INTERRUPTED: TutorFailure = {
  kind: 'interrupted',
  message: 'The connection was lost before the reply was finished. Please try again.',
}
/** The tutor function said that the reply broke off on its side. */
const STOPPED_EARLY: TutorFailure = {
  kind: 'interrupted',
  message: 'The tutor had a problem and stopped before the reply was finished. Please try again.',
}
const EMPTY: TutorFailure = {
  kind: 'empty',
  message: 'The tutor sent an empty reply. Please try again.',
}
/** The reply reached the tutor's length limit and stops in the middle. */
const CUT_OFF: TutorFailure = {
  kind: 'interrupted',
  message:
    'The reply was too long, so it was cut off. Try again, or ask about one thing at a time.',
}
const BUSY: TutorFailure = {
  kind: 'busy',
  message: 'The tutor is busy right now. Please try again in a moment.',
}

/** The sentence for a reply that is not "200 OK". */
async function failureOf(response: Response): Promise<TutorFailure> {
  let data: unknown = null
  try {
    data = await response.json()
  } catch {
    // Not JSON: an error page of the host, for example. The status alone decides.
  }
  const body = isRecord(data) ? data : {}
  // The function writes its messages for students, so they are shown as they are.
  const said =
    typeof body.message === 'string' && body.message !== '' && body.message.length <= 300
      ? body.message
      : null

  switch (response.status) {
    case 429: {
      const fromBody = typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : NaN
      const fromHeader = Number(response.headers.get('retry-after') ?? '')
      const found = [fromBody, fromHeader].find((value) => Number.isFinite(value) && value >= 1)
      const seconds = found === undefined ? undefined : Math.ceil(found)
      const wait = seconds === undefined ? 'a moment' : waitInWords(seconds)
      const failure: TutorFailure = {
        kind: 'rate-limited',
        message:
          said ?? `The tutor is getting too many questions. Please wait ${wait}, then ask again.`,
      }
      if (seconds !== undefined) failure.retryAfterSeconds = seconds
      return failure
    }
    case 503:
      if (body.error === 'tutor-disabled') {
        return { kind: 'not-set-up', message: 'The tutor is turned off right now.' }
      }
      // The account behind the tutor reached its spend limit: only the teacher can help.
      if (body.error === 'tutor-limit-reached') {
        return {
          kind: 'not-set-up',
          message:
            said ?? 'The tutor cannot answer more questions right now. Please tell your teacher.',
        }
      }
      return { kind: 'busy', message: said ?? BUSY.message }
    case 502:
      if (body.error === 'tutor-not-set-up') {
        return {
          kind: 'not-set-up',
          message: said ?? 'The tutor is not set up correctly. Please tell your teacher.',
        }
      }
      if (body.error === 'tutor-error') {
        return {
          kind: 'rejected',
          message:
            said ?? 'The tutor could not answer this question. Please ask it in another way.',
        }
      }
      // A 502 that is not from the function: the host could not reach it.
      return BUSY
    case 504:
      return { kind: 'busy', message: 'The tutor took too long to answer. Please try again.' }
    case 408:
      return {
        kind: 'network',
        message: said ?? 'The question took too long to reach the tutor. Please try again.',
      }
    case 400:
    case 413:
      return {
        kind: 'rejected',
        message: 'The tutor could not read this question. Try a shorter question.',
      }
    case 404:
    case 405:
      return { kind: 'not-set-up', message: 'The tutor is not available on this site right now.' }
    default:
      return { kind: 'busy', message: 'The tutor had a problem. Please try again.' }
  }
}

/** The part of a reply that the student sees: everything before the end mark. */
function shownPart(text: string): string {
  const mark = text.indexOf(TUTOR_END_MARK)
  return mark === -1 ? text : text.slice(0, mark)
}

/** What a reply that arrived in full comes to. */
function outcomeOf(text: string): AskResult {
  const mark = text.indexOf(TUTOR_END_MARK)
  if (mark === -1) {
    if (text.trim() === '') return { status: 'failed', text: '', failure: EMPTY }
    return { status: 'done', text }
  }
  const reason = text.slice(mark + TUTOR_END_MARK.length).trim()
  // The model declined. Text that came before is not an answer: it is thrown away.
  if (reason === 'refused') return { status: 'done', text: TUTOR_REFUSAL_TEXT }
  if (reason === 'empty') return { status: 'failed', text: '', failure: EMPTY }
  // The length limit stopped the reply in the middle: the text stays, with a warning.
  if (reason === 'cut') return { status: 'failed', text: text.slice(0, mark), failure: CUT_OFF }
  // 'interrupted', or a word that this page does not know: the reply is not complete.
  return { status: 'failed', text: text.slice(0, mark), failure: STOPPED_EARLY }
}

/**
 * Post one question and read the reply piece by piece.
 * The promise always resolves: with the whole reply, or with what happened instead.
 */
export async function askTutor(payload: TutorPayload, options: AskOptions): Promise<AskResult> {
  const { signal, onText } = options
  const fetchImpl = options.fetch ?? fetch
  let text = ''

  let response: Response
  try {
    response = await fetchImpl(TUTOR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TUTOR_CLIENT_ID_HEADER]: tutorClientId() },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal,
    })
  } catch {
    return signal.aborted
      ? { status: 'stopped', text }
      : { status: 'failed', text, failure: NETWORK }
  }

  if (!response.ok) return { status: 'failed', text, failure: await failureOf(response) }
  // The reply is plain text. Anything else is not the tutor (a static host that answers
  // every address with the site's HTML page, for example).
  if (!(response.headers.get('content-type') ?? '').includes('text/plain') || !response.body) {
    return {
      status: 'failed',
      text,
      failure: {
        kind: 'not-set-up',
        message: 'The tutor is not available on this site right now.',
      },
    }
  }

  const reader = response.body.getReader()
  // `stream: true` keeps a character whole when its bytes arrive in two pieces.
  const decoder = new TextDecoder()
  let shown = ''
  /** Tell the page about the visible text, when it has grown. */
  const show = (): void => {
    const visible = shownPart(text)
    if (visible === shown) return
    shown = visible
    onText(visible)
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      show()
    }
    text += decoder.decode()
    show()
  } catch {
    return signal.aborted
      ? { status: 'stopped', text: shownPart(text) }
      : { status: 'failed', text: shownPart(text), failure: INTERRUPTED }
  }

  return outcomeOf(text)
}
