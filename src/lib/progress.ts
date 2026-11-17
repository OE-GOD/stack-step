/**
 * The student's progress: lessons finished, practice results per topic, quiz results.
 *
 * - Kept in localStorage under `stackstep:progress:v1`, and loaded on first use.
 * - Stored data is checked before it is trusted. Unknown or broken data means a fresh
 *   start; nothing here ever throws.
 * - Every change makes a NEW object, saves it and tells the listeners. `getProgress()`
 *   returns the same object until the next change, so it is safe for
 *   `useSyncExternalStore`.
 * - When storage is blocked, everything still works in memory (progress then lasts until
 *   the tab closes).
 * - Other tabs of the site stay in sync through the browser's `storage` event.
 */
import { useSyncExternalStore } from 'react'
import { isTopicId, TOPICS, type TopicId } from '../content/topics'
import { loadText, removeKey, saveJSON } from './storage'

export const PROGRESS_KEY = 'stackstep:progress:v1'

/** How many recent practice results are kept per topic. */
const MAX_RECENT = 20
/** How many quiz results are kept: the oldest is dropped when a new one comes. */
export const MAX_QUIZZES = 20
/** A topic counts as mastered when all its recent answers are right and there are this many. */
export const MASTERED_ATTEMPTS = 5

export interface TopicStats {
  right: number
  wrong: number
  /** Most recent results, newest last, at most 20. */
  recent: boolean[]
}

export interface QuizResult {
  score: number
  total: number
  /** ISO date-time. */
  date: string
  weakTopics: TopicId[]
}

export interface ProgressData {
  version: 1
  /** lessonId → ISO date-time it was finished. */
  lessonsDone: Record<string, string>
  practice: Partial<Record<TopicId, TopicStats>>
  /** Newest last, at most 20. */
  quizzes: QuizResult[]
}

/* ───────────────────────── Checking stored data ───────────────────────── */

function emptyProgress(): ProgressData {
  return { version: 1, lessonsDone: {}, practice: {}, quizzes: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 0, 1, 2, … */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isDateText(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function cleanStats(value: unknown): TopicStats | null {
  if (!isRecord(value)) return null
  const { right, wrong, recent } = value
  if (!isCount(right) || !isCount(wrong) || !Array.isArray(recent)) return null
  const results: unknown[] = recent
  if (!results.every((item): item is boolean => typeof item === 'boolean')) return null
  return { right, wrong, recent: results.slice(-MAX_RECENT) }
}

function cleanQuiz(value: unknown): QuizResult | null {
  if (!isRecord(value)) return null
  const { score, total, date, weakTopics } = value
  if (!isCount(score) || !isCount(total) || score > total) return null
  if (!isDateText(date) || !Array.isArray(weakTopics)) return null
  const topics: unknown[] = weakTopics
  return {
    score,
    total,
    date,
    weakTopics: topics.filter(
      (topic): topic is TopicId => typeof topic === 'string' && isTopicId(topic),
    ),
  }
}

/**
 * Turn anything into valid progress data.
 * The wrong overall shape (or another version) gives a fresh start. Inside the right
 * shape, single bad entries are dropped and the rest is kept.
 */
function cleanProgress(value: unknown): ProgressData {
  if (!isRecord(value) || value.version !== 1) return emptyProgress()
  const { lessonsDone, practice, quizzes } = value
  if (!isRecord(lessonsDone) || !isRecord(practice) || !Array.isArray(quizzes)) {
    return emptyProgress()
  }

  const data = emptyProgress()
  for (const [lessonId, date] of Object.entries(lessonsDone)) {
    if (lessonId !== '' && lessonId !== '__proto__' && isDateText(date)) {
      data.lessonsDone[lessonId] = date
    }
  }
  for (const topic of TOPICS) {
    const stats = Object.hasOwn(practice, topic.id) ? cleanStats(practice[topic.id]) : null
    if (stats !== null) data.practice[topic.id] = stats
  }
  const results: unknown[] = quizzes
  data.quizzes = results
    .map(cleanQuiz)
    .filter((quiz) => quiz !== null)
    .slice(-MAX_QUIZZES)
  return data
}

/** Stored text (or null when there is none) → valid progress data. */
function parseProgress(text: string | null): ProgressData {
  if (text === null) return emptyProgress()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return emptyProgress()
  }
  return cleanProgress(value)
}

/* ─────────────────────────────── The store ────────────────────────────── */

let current: ProgressData | null = null
const listeners = new Set<() => void>()
let watchingOtherTabs = false

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function commit(next: ProgressData): void {
  current = next
  // When storage is blocked or full this returns false, and progress lives in memory.
  saveJSON(PROGRESS_KEY, next)
  notify()
}

/** Another tab changed the stored progress: take over its version. */
function handleStorageEvent(event: StorageEvent): void {
  // `key` is null when the whole storage was cleared.
  if (event.key !== null && event.key !== PROGRESS_KEY) return
  // Use what is stored NOW, not the value the event carries: when two tabs save at almost
  // the same moment, both then end up with the save that came last. Only when storage
  // cannot be read in this tab does the event's own value have to do.
  const carried = event.key === null ? null : event.newValue
  const next = parseProgress(loadText(PROGRESS_KEY) ?? carried)
  if (current !== null && JSON.stringify(next) === JSON.stringify(current)) return
  current = next
  notify()
}

function watchOtherTabs(): void {
  if (watchingOtherTabs || typeof window === 'undefined') return
  watchingOtherTabs = true
  window.addEventListener('storage', handleStorageEvent)
}

/** Current progress. Same object until something changes (safe for useSyncExternalStore). */
export function getProgress(): ProgressData {
  if (current === null) {
    current = parseProgress(loadText(PROGRESS_KEY))
    watchOtherTabs()
  }
  return current
}

export function subscribeProgress(listener: () => void): () => void {
  watchOtherTabs()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** React hook: current progress, re-renders on change. */
export function useProgress(): ProgressData {
  return useSyncExternalStore(subscribeProgress, getProgress, getProgress)
}

/* ─────────────────────────────── Changes ──────────────────────────────── */

/** Mark a lesson as finished now. A lesson that is already done keeps its first date. */
export function markLessonDone(lessonId: string): void {
  const data = getProgress()
  if (lessonId === '' || lessonId === '__proto__' || isLessonDone(data, lessonId)) return
  commit({ ...data, lessonsDone: { ...data.lessonsDone, [lessonId]: new Date().toISOString() } })
}

export function isLessonDone(data: ProgressData, lessonId: string): boolean {
  return Object.hasOwn(data.lessonsDone, lessonId)
}

/** Count one practice answer for a topic. */
export function recordAttempt(topic: TopicId, correct: boolean): void {
  if (!isTopicId(topic)) return
  const data = getProgress()
  const before = data.practice[topic] ?? { right: 0, wrong: 0, recent: [] }
  const after: TopicStats = {
    right: before.right + (correct ? 1 : 0),
    wrong: before.wrong + (correct ? 0 : 1),
    recent: [...before.recent, correct].slice(-MAX_RECENT),
  }
  commit({ ...data, practice: { ...data.practice, [topic]: after } })
}

/** Add one quiz result. A result that does not have the QuizResult shape is ignored. */
export function recordQuiz(result: QuizResult): void {
  // Stored as a checked copy, so memory always holds exactly what a reload would give.
  const quiz = cleanQuiz(result)
  if (quiz === null) return
  const data = getProgress()
  commit({ ...data, quizzes: [...data.quizzes, quiz].slice(-MAX_QUIZZES) })
}

/** Forget everything (lessons, practice, quizzes). */
export function resetProgress(): void {
  current = emptyProgress()
  removeKey(PROGRESS_KEY)
  notify()
}

/* ─────────────────────────────── Reading ──────────────────────────────── */

/** Share of right answers among the recent ones (0…1); null when there are no attempts. */
export function accuracy(stats: TopicStats | undefined): number | null {
  if (stats === undefined || stats.recent.length === 0) return null
  const right = stats.recent.filter(Boolean).length
  return right / stats.recent.length
}

/**
 * The recent answers in words, the same on the practice hub and the Progress page:
 * "4 right of your last 5", or "0 right of 1 answer". The space before the last word
 * does not break, so a line never starts with the number alone.
 */
export function recentAnswersWords(right: number, count: number): string {
  return count === 1
    ? `${right} right of 1\u00a0answer`
    : `${right} right of your last\u00a0${count}`
}

/**
 * The `count` topics to practise next, in three groups:
 * 1. topics with a wrong answer among the recent ones: the lowest recent accuracy first;
 * 2. topics never tried, in the order of TOPICS;
 * 3. topics whose recent answers are all right: the fewest recent answers first, so a
 *    mastered topic (MASTERED_ATTEMPTS answers, all right) comes after one with fewer.
 * Ties: more answers in all first, then the order of TOPICS.
 *
 * This is the one ranking of the site: the Progress page ("Your weakest topics") and the
 * practice pages ("Practice my weak spots") both use it, so they always agree.
 */
export function weakestTopics(data: ProgressData, count: number): TopicId[] {
  interface Tried {
    id: TopicId
    accuracy: number
    recent: number
    attempts: number
  }
  const withMistakes: Tried[] = []
  const untried: TopicId[] = []
  const allRight: Tried[] = []

  for (const topic of TOPICS) {
    const stats = data.practice[topic.id]
    const share = accuracy(stats)
    if (stats === undefined || share === null) {
      untried.push(topic.id)
      continue
    }
    const tried: Tried = {
      id: topic.id,
      accuracy: share,
      recent: stats.recent.length,
      attempts: stats.right + stats.wrong,
    }
    if (share < 1) withMistakes.push(tried)
    else allRight.push(tried)
  }

  // The sorts are stable, so full ties stay in the order of TOPICS.
  const moreAttemptsFirst = (a: Tried, b: Tried): number => b.attempts - a.attempts
  withMistakes.sort((a, b) => a.accuracy - b.accuracy || moreAttemptsFirst(a, b))
  allRight.sort((a, b) => a.recent - b.recent || moreAttemptsFirst(a, b))
  const ordered = [
    ...withMistakes.map((tried) => tried.id),
    ...untried,
    ...allRight.map((tried) => tried.id),
  ]
  return ordered.slice(0, Math.max(0, Math.floor(count)))
}
