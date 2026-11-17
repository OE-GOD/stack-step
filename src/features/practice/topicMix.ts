/**
 * Which topics a practice session or a quiz takes its problems from, without building a
 * single problem: the "weak spots" mix and the mixed quiz's topics.
 *
 * This file imports no generator (and so not the emulator), so the practice hub can show
 * the mix and the quiz length without downloading them.
 */
import { TOPICS, type TopicId } from '../../content/topics'
import { accuracy, weakestTopics, type ProgressData } from '../../lib/progress'

/* ─────────────────────────── the weak spots ──────────────────────────── */

/** How many topics a "weak spots" session takes turns with. */
export const WEAK_TOPIC_COUNT = 3

/** True when the student has answered at least one practice problem. */
export function hasPracticeHistory(progress: ProgressData): boolean {
  return Object.values(progress.practice).some((stats) => stats.recent.length > 0)
}

/**
 * Why a topic is in a "weak spots" mix: some recent answers were wrong; it was never
 * tried; or every recent answer was right (only when there are not enough of the others).
 */
type WeakReason = 'mistakes' | 'untried' | 'all-right'

function weakReason(progress: ProgressData, topic: TopicId): WeakReason {
  const share = accuracy(progress.practice[topic])
  if (share === null) return 'untried'
  return share < 1 ? 'mistakes' : 'all-right'
}

const WEAK_RANK: Readonly<Record<WeakReason, number>> = { mistakes: 0, untried: 1, 'all-right': 2 }

/**
 * The topics of a "weak spots" session, three at most, in the site's one ranking
 * (`weakestTopics`, which the Progress page shows too): first the topics with wrong recent
 * answers (lowest accuracy first), then the topics never tried, then the topics with only
 * right answers (fewest answers first).
 */
export function weakRotation(progress: ProgressData): TopicId[] {
  return weakestTopics(progress, WEAK_TOPIC_COUNT)
}

/** How each group of topics in a mix is described, in the order of WEAK_RANK. */
const WEAK_GROUP_WORDS: Readonly<Record<WeakReason, string>> = {
  mistakes: 'your topics with the lowest accuracy',
  untried: 'topics you have not tried yet',
  'all-right': 'the topics you have practiced least',
}

/**
 * What a mix is made of, in words that are true for this rotation: "your topics with the
 * lowest accuracy, then topics you have not tried yet". '' for an empty rotation.
 */
export function weakMixWords(progress: ProgressData, rotation: readonly TopicId[]): string {
  const reasons = [...new Set(rotation.map((topic) => weakReason(progress, topic)))]
  return reasons
    .sort((a, b) => WEAK_RANK[a] - WEAK_RANK[b])
    .map((reason) => WEAK_GROUP_WORDS[reason])
    .join(', then ')
}

/** The topic of problem number `turn` (0, 1, 2, …) of a rotation: they take turns. */
export function topicInRotation(rotation: readonly TopicId[], turn: number): TopicId | null {
  if (rotation.length === 0) return null
  const index = ((Math.trunc(turn) % rotation.length) + rotation.length) % rotation.length
  return rotation[index] ?? null
}

/* ─────────────────────────────── the quiz ────────────────────────────── */

/** Topics shown as a trace table: one question each in a quiz (the others get two). */
const TRACE_TABLE_TOPICS: ReadonlySet<TopicId> = new Set(['homework-table'])

/** Two questions from each form topic and one trace table: 15 for the eight topics. */
export function quizTopicMix(): TopicId[] {
  return TOPICS.flatMap((topic) =>
    TRACE_TABLE_TOPICS.has(topic.id) ? [topic.id] : [topic.id, topic.id],
  )
}

/** How many questions a quiz has. */
export const QUIZ_LENGTH = quizTopicMix().length

/** How many topics give two questions to a quiz (all but the trace table): 7. */
export const QUIZ_FORM_TOPIC_COUNT = TOPICS.filter(
  (topic) => !TRACE_TABLE_TOPICS.has(topic.id),
).length
