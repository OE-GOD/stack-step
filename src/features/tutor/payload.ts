/**
 * Builds the body of a request to the tutor function, inside the function's limits.
 *
 * The function rejects a request that is too long, so everything is cut to size here:
 * each text to its own limit, the conversation to its newest messages, and the whole
 * body to 64 kB. Pure functions, no browser needed.
 */
import { TUTOR_CLIENT_LIMITS as LIMITS } from './limits'
import type { TutorContext } from './context'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** What is posted to /api/tutor. */
export interface TutorPayload {
  messages: ChatMessage[]
  context: TutorContext
}

/** Added to a text that was cut, so the tutor knows that it does not see all of it. */
const CODE_CUT = '\n# (The code is longer than this. The rest was cut off.)'
const TEXT_CUT = '\n(The text is longer than this. The rest was cut off.)'
const REPLY_CUT = ' …'

/**
 * Cut `text` to at most `limit` characters. A cut text ends with `mark`.
 * The cut never leaves half of a character pair (an emoji is two characters long).
 */
export function clip(text: string, limit: number, mark = ''): string {
  if (text.length <= limit) return text
  let end = Math.max(0, limit - mark.length)
  const lastKept = text.charCodeAt(end - 1)
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1
  return text.slice(0, end) + mark.slice(0, limit)
}

/** The size of the request body in bytes, as the function measures it. */
export function payloadBytes(payload: TutorPayload): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length
}

function clipContext(context: TutorContext): TutorContext {
  return {
    page: context.page,
    code: clip(context.code, LIMITS.maxCodeChars, CODE_CUT),
    machine: clip(context.machine, LIMITS.maxMachineChars, TEXT_CUT),
    problem:
      context.problem === null ? null : clip(context.problem, LIMITS.maxProblemChars, TEXT_CUT),
  }
}

/**
 * The request for one question.
 *
 * @param history  the finished part of the conversation, oldest first
 * @param question the student's new question
 * @param context  what the page shows right now
 */
export function buildTutorPayload(
  history: readonly ChatMessage[],
  question: string,
  context: TutorContext,
): TutorPayload {
  const asked: ChatMessage = { role: 'user', content: question }
  const all = [...history, asked].map((message): ChatMessage => ({
    role: message.role,
    content: clip(message.content, LIMITS.maxMessageChars, REPLY_CUT),
  }))

  // The newest messages only. The conversation must start with the student, so a reply
  // of the tutor that lost its question in the cut goes too.
  let messages = all.slice(-LIMITS.maxMessages)
  if (messages[0]?.role === 'assistant') messages = messages.slice(1)

  const payload: TutorPayload = { messages, context: clipContext(context) }

  // The whole body has a limit in bytes. Text in some languages takes three or four
  // bytes per character, so a body can be too large while every part is short enough.
  // First forget the oldest question and its reply, again and again.
  while (payload.messages.length > 1 && payloadBytes(payload) > LIMITS.maxBodyBytes) {
    payload.messages = payload.messages.slice(2)
  }
  // Then, for the rare page that is still too large, shorten what the page sent.
  for (const field of ['code', 'machine', 'problem'] as const) {
    while (payloadBytes(payload) > LIMITS.maxBodyBytes) {
      const text = payload.context[field]
      if (text === null || text.length <= 200) break
      const mark = field === 'code' ? CODE_CUT : TEXT_CUT
      payload.context = {
        ...payload.context,
        [field]: clip(text, Math.floor(text.length / 2), mark),
      }
    }
  }
  return payload
}
