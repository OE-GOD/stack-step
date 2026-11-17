/**
 * The practice topics. The practice pages and the progress page share this list, so a
 * topic has the same id and the same name everywhere.
 *
 * `title` is plain text. `blurb` is one plain sentence; it may hold code in backticks, so
 * show it with <RichText> (src/components/ui/RichText). `lessons` are the lessons that
 * teach the topic (ids from lessonList.ts), the first one being the best place to start.
 */
import type { LessonId } from './lessonList'

export const TOPICS = [
  {
    id: 'register-names',
    title: 'Register names',
    blurb:
      'Match a name such as `eax` or `al` to its size and to the 64-bit register it is a part of.',
    lessons: ['register-names', 'registers-and-memory'],
  },
  {
    id: 'subregister-writes',
    title: 'Writing part of a register',
    blurb: 'Find what the whole register holds after a write to one part of it.',
    lessons: ['partial-writes'],
  },
  {
    id: 'rsp-tracker',
    title: 'Follow rsp',
    blurb: 'Say where rsp points after each `push`, `pop`, `call` and `ret`.',
    lessons: ['stack-and-rsp'],
  },
  {
    id: 'rip',
    title: 'Where is rip?',
    blurb: 'Say which address rip holds while an instruction runs, and after a jump.',
    lessons: ['rip-cycle'],
  },
  {
    id: 'call-ret',
    title: 'call and ret',
    blurb: 'Follow the return address onto the stack with `call` and back into rip with `ret`.',
    lessons: ['call-and-ret'],
  },
  {
    id: 'indirect-addressing',
    title: 'Address or contents?',
    blurb: 'Decide if an instruction gives you an address or the contents stored at that address.',
    lessons: ['indirect-addressing', 'lea-vs-mov'],
  },
  {
    id: 'mov-legality',
    title: 'Legal or illegal mov?',
    blurb: 'Decide if a `mov` instruction is allowed, and name the rule it breaks when it is not.',
    lessons: ['mov'],
  },
  {
    id: 'homework-table',
    title: 'Trace table',
    blurb:
      'Follow five lines of code and place a chip with each changed register and its new value.',
    lessons: ['partial-writes', 'mov', 'add-sub-flags'],
  },
] as const satisfies readonly {
  id: string
  title: string
  blurb: string
  lessons: readonly LessonId[]
}[]

export type Topic = (typeof TOPICS)[number]
export type TopicId = Topic['id']

export function isTopicId(value: string): value is TopicId {
  return TOPICS.some((topic) => topic.id === value)
}

export function topicById(id: TopicId): Topic {
  const found = TOPICS.find((topic) => topic.id === id)
  if (!found) throw new Error(`Unknown topic id: ${String(id)}`)
  return found
}
