/**
 * The conversation with the tutor: what was asked, what was answered, and what is being
 * answered right now.
 *
 * It lives in memory only. A reload clears it; nothing is saved anywhere.
 * It is a small store outside React (subscribe + getSnapshot), so the logic can be
 * tested without a browser, and so the conversation is still there when the student
 * closes the drawer or moves to another page of the site.
 */
import { buildTutorPayload, type ChatMessage, type TutorPayload } from './payload'
import { askTutor, type AskOptions, type AskResult, type TutorFailure } from './tutorApi'
import type { TutorContext } from './context'

/**
 * - waiting:   the question was sent, no text has arrived yet
 * - streaming: the reply is arriving
 * - done:      the reply is complete
 * - stopped:   the student pressed Stop (the reply may hold the text that had arrived)
 * - failed:    it went wrong (see `failure`); the reply may hold the text that had arrived
 */
export type TurnState = 'waiting' | 'streaming' | 'done' | 'stopped' | 'failed'

/** One question of the student and the tutor's reply to it. */
export interface Turn {
  id: number
  question: string
  reply: string
  state: TurnState
  failure: TutorFailure | null
}

export interface ChatSnapshot {
  turns: readonly Turn[]
  /** True while a reply is awaited or arriving. */
  busy: boolean
  /**
   * After the tutor said "please wait" (429): the whole seconds until a question may be
   * sent again. 0 when a question can be sent now. It counts down once a second.
   */
  waitSeconds: number
}

export interface ChatStore {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => ChatSnapshot
  /**
   * Ask a question. `getContext` is called right now, so the tutor sees the page as it
   * is at this moment. Returns false when nothing was sent (an empty question, a reply
   * that is still arriving, or a wait that the tutor asked for).
   */
  send: (question: string, getContext: () => TutorContext) => boolean
  /** Ask the last question again, after it failed or was stopped. */
  retry: (getContext: () => TutorContext) => boolean
  /** Stop the reply that is arriving. What has arrived stays. */
  stop: () => void
  /** Forget the whole conversation ("New chat"). A wait that the tutor asked for stays. */
  reset: () => void
}

/** `askTutor`, or a stand-in for it in tests. */
export type AskFunction = (payload: TutorPayload, options: AskOptions) => Promise<AskResult>

/** Shown when the page could not say what it shows (that would be a bug of the page). */
const PAGE_PROBLEM: TutorFailure = {
  kind: 'rejected',
  message: 'The tutor could not read this page. Please reload the page, then try again.',
}

/** The messages of the turns that have a reply worth keeping, oldest first. */
function historyOf(turns: readonly Turn[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const turn of turns) {
    const kept = turn.state === 'done' || turn.state === 'stopped'
    if (!kept || turn.reply.trim() === '') continue
    messages.push(
      { role: 'user', content: turn.question },
      { role: 'assistant', content: turn.reply },
    )
  }
  return messages
}

export function createChatStore(ask: AskFunction = askTutor): ChatStore {
  let snapshot: ChatSnapshot = { turns: [], busy: false, waitSeconds: 0 }
  let nextId = 1
  /** Stops the request that is running; null when none is. */
  let running: AbortController | null = null
  /** Until this time (ms) no question is sent, because the tutor said "please wait". */
  let waitUntil = 0
  /** The timer that counts the wait down; null when there is no wait. */
  let ticking: ReturnType<typeof setInterval> | null = null
  const listeners = new Set<() => void>()

  const secondsLeft = (): number => Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000))

  const publish = (turns: readonly Turn[]): void => {
    snapshot = { turns, busy: running !== null, waitSeconds: secondsLeft() }
    for (const listener of [...listeners]) listener()
  }

  const change = (id: number, part: Partial<Turn>): void => {
    publish(snapshot.turns.map((turn) => (turn.id === id ? { ...turn, ...part } : turn)))
  }

  /** The tutor asked for a wait: block questions until then, and count down every second. */
  const waitFor = (seconds: number): void => {
    waitUntil = Date.now() + seconds * 1000
    if (ticking !== null) clearInterval(ticking)
    ticking = setInterval(() => {
      if (secondsLeft() === 0 && ticking !== null) {
        clearInterval(ticking)
        ticking = null
      }
      publish(snapshot.turns)
    }, 1000)
  }

  /** Send the question of turn `id` (the last turn) and follow the reply. */
  const run = (id: number, question: string, getContext: () => TutorContext): void => {
    const controller = new AbortController()
    running = controller
    const earlier = snapshot.turns.filter((turn) => turn.id !== id)
    publish(snapshot.turns)

    const finish = (part: Partial<Turn>): void => {
      // A reset or a newer request has taken over: this reply is no longer wanted.
      if (running !== controller) return
      running = null
      const wait = part.failure?.retryAfterSeconds
      if (wait !== undefined && wait > 0) waitFor(wait)
      change(id, part)
    }

    // If the page cannot say what it shows, or says something that is not text, that is
    // a bug of the page. The student still gets an answer: a failure that can be retried.
    let payload: TutorPayload
    try {
      payload = buildTutorPayload(historyOf(earlier), question, getContext())
    } catch {
      finish({ state: 'failed', failure: PAGE_PROBLEM })
      return
    }

    void ask(payload, {
      signal: controller.signal,
      onText: (reply) => {
        if (running === controller) change(id, { reply, state: 'streaming' })
      },
    }).then(
      (result) => {
        if (result.status === 'failed') {
          finish({ state: 'failed', reply: result.text, failure: result.failure })
        } else {
          finish({ state: result.status, reply: result.text, failure: null })
        }
      },
      () => {
        // `ask` never rejects. If it ever does, the student still gets a way out.
        finish({
          state: 'failed',
          failure: { kind: 'busy', message: 'The tutor had a problem. Please try again.' },
        })
      },
    )
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    getSnapshot: () => snapshot,

    send(question, getContext) {
      const text = question.trim()
      if (text === '' || running !== null || secondsLeft() > 0) return false
      const turn: Turn = { id: nextId, question: text, reply: '', state: 'waiting', failure: null }
      nextId += 1
      snapshot = { ...snapshot, turns: [...snapshot.turns, turn] }
      run(turn.id, text, getContext)
      return true
    },

    retry(getContext) {
      const last = snapshot.turns[snapshot.turns.length - 1]
      if (last === undefined || running !== null || secondsLeft() > 0) return false
      if (last.state !== 'failed' && last.state !== 'stopped') return false
      snapshot = {
        ...snapshot,
        turns: snapshot.turns.map((turn) =>
          turn.id === last.id ? { ...turn, reply: '', state: 'waiting', failure: null } : turn,
        ),
      }
      run(last.id, last.question, getContext)
      return true
    },

    stop() {
      running?.abort()
    },

    reset() {
      const controller = running
      running = null
      controller?.abort()
      publish([])
    },
  }
}

/** The one conversation of this page load. */
export const tutorChat = createChatStore()
