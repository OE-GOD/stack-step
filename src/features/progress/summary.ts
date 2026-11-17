/**
 * The numbers the progress page shows, worked out from the stored progress.
 *
 * Everything here is a pure function of `ProgressData`, so it is tested without a
 * browser. The page (ProgressPage.tsx) only turns these numbers into words and bars.
 */
import { LESSONS, type Lesson } from '../../content/lessonList'
import { TOPICS, topicById, type Topic, type TopicId } from '../../content/topics'
import {
  accuracy,
  isLessonDone,
  MASTERED_ATTEMPTS,
  MAX_QUIZZES,
  weakestTopics,
  type ProgressData,
  type QuizResult,
} from '../../lib/progress'

/** How many topics the "weakest topics" list shows at most. */
export const WEAK_TOPIC_COUNT = 3

/** A share from 0 to 1 as a whole percentage: 0.666 → 67. */
export function toPercent(share: number): number {
  return Math.round(Math.min(1, Math.max(0, share)) * 100)
}

/* ──────────────────────────────── Lessons ──────────────────────────────── */

export interface LessonRow {
  lesson: Lesson
  done: boolean
}

/** Every lesson of the course in order, with its done mark. */
export function lessonRows(progress: ProgressData): LessonRow[] {
  return LESSONS.map((lesson) => ({ lesson, done: isLessonDone(progress, lesson.id) }))
}

/**
 * How many lessons of the course are done. A stored id that is not a lesson of the
 * course (an old version of the site) is not counted.
 */
export function lessonsDone(progress: ProgressData): number {
  return lessonRows(progress).filter((row) => row.done).length
}

/* ──────────────────────────────── Practice ──────────────────────────────── */

export interface TopicRow {
  topic: Topic
  /** False until the topic has at least one recent answer. */
  tried: boolean
  /** All right and wrong answers ever given. */
  right: number
  wrong: number
  /** The recent answers (at most the last 20): how many, and how many were right. */
  recentCount: number
  recentRight: number
  /** Share of right answers among the recent ones, 0 to 1. Null when not tried. */
  accuracy: number | null
}

function topicRow(progress: ProgressData, id: TopicId): TopicRow {
  const stats = progress.practice[id]
  const share = accuracy(stats)
  if (stats === undefined || share === null) {
    return {
      topic: topicById(id),
      tried: false,
      right: 0,
      wrong: 0,
      recentCount: 0,
      recentRight: 0,
      accuracy: null,
    }
  }
  return {
    topic: topicById(id),
    tried: true,
    right: stats.right,
    wrong: stats.wrong,
    recentCount: stats.recent.length,
    recentRight: stats.recent.filter(Boolean).length,
    accuracy: share,
  }
}

/** One row per practice topic, in the order of the practice page. */
export function topicRows(progress: ProgressData): TopicRow[] {
  return TOPICS.map((topic) => topicRow(progress, topic.id))
}

/** True when at least one practice problem was answered. */
export function hasPracticeHistory(progress: ProgressData): boolean {
  return topicRows(progress).some((row) => row.tried)
}

/** True for a topic the progress store calls mastered: it is not a weak spot. */
export function isMastered(row: TopicRow): boolean {
  return row.accuracy === 1 && row.recentCount >= MASTERED_ATTEMPTS
}

/**
 * The topics to practice next, weakest first: three at most. The order is decided by the
 * progress store (`weakestTopics`), the same order as the practice pages' weak spots:
 * topics with mistakes, then topics not tried yet, then topics with only right answers.
 *
 * A mastered topic is never listed. The store gives one only when no other topic is left,
 * so the list is shorter then, and empty when every topic is mastered.
 */
export function weakTopicRows(progress: ProgressData): TopicRow[] {
  return weakestTopics(progress, WEAK_TOPIC_COUNT)
    .map((id) => topicRow(progress, id))
    .filter((row) => !isMastered(row))
}

/* ──────────────────────────────── Quizzes ──────────────────────────────── */

export interface QuizSummary {
  /** How many quiz results are stored: MAX_QUIZZES at most. */
  count: number
  /**
   * True when the store is full. Older results may then be gone, so `count` and `best`
   * cover only the newest MAX_QUIZZES quizzes, not every quiz ever taken.
   */
  onlyNewest: boolean
  /** The newest result. */
  latest: QuizResult
  /** The result with the highest share of right answers. Of two equal ones: the newer. */
  best: QuizResult
}

/** Share of right answers of one quiz, 0 to 1. A quiz with no questions counts as 0. */
export function quizShare(quiz: QuizResult): number {
  return quiz.total === 0 ? 0 : quiz.score / quiz.total
}

/** The latest and the best quiz, or null when no quiz was taken. */
export function quizSummary(progress: ProgressData): QuizSummary | null {
  const { quizzes } = progress
  if (quizzes.length === 0) return null
  // Stored oldest first, so `>=` lets a newer quiz win a tie.
  let best = quizzes[0]
  for (const quiz of quizzes) {
    if (quizShare(quiz) >= quizShare(best)) best = quiz
  }
  return {
    count: quizzes.length,
    onlyNewest: quizzes.length >= MAX_QUIZZES,
    latest: quizzes[quizzes.length - 1],
    best,
  }
}

/* ─────────────────────────────── The whole page ─────────────────────────────── */

/** True for a new student: no lesson done, no practice answer, no quiz. */
export function isEmptyProgress(progress: ProgressData): boolean {
  const answered = Object.values(progress.practice).some(
    (stats) => stats.right + stats.wrong + stats.recent.length > 0,
  )
  return lessonsDone(progress) === 0 && !answered && progress.quizzes.length === 0
}
