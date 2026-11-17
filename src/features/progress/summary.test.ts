/**
 * The numbers of the progress page, worked out without a browser.
 * (The page itself, the dialog and the stored data are tested in e2e/progress.spec.ts.)
 */
import { afterEach, describe, expect, it } from 'vitest'
import { LESSONS } from '../../content/lessonList'
import { TOPICS, type TopicId } from '../../content/topics'
import {
  getProgress,
  MASTERED_ATTEMPTS,
  MAX_QUIZZES,
  recordQuiz,
  resetProgress,
  weakestTopics,
  type ProgressData,
  type QuizResult,
  type TopicStats,
} from '../../lib/progress'
import {
  hasPracticeHistory,
  isEmptyProgress,
  isMastered,
  lessonRows,
  lessonsDone,
  quizShare,
  quizSummary,
  toPercent,
  topicRows,
  weakTopicRows,
  WEAK_TOPIC_COUNT,
} from './summary'

const DATE = '2026-11-10T09:00:00.000Z'

function progress(parts: Partial<Omit<ProgressData, 'version'>> = {}): ProgressData {
  return { version: 1, lessonsDone: {}, practice: {}, quizzes: [], ...parts }
}

/** "1101" → [true, true, false, true]. */
function results(pattern: string): boolean[] {
  return [...pattern].map((digit) => digit === '1')
}

function quiz(score: number, total: number, day: number): QuizResult {
  return {
    score,
    total,
    // Day 1 is November 1st; later days run on into December.
    date: new Date(Date.UTC(2026, 10, day, 9)).toISOString(),
    weakTopics: [],
  }
}

/** `count` answers in a topic, all of them right. */
function allRight(count: number): TopicStats {
  return { right: count, wrong: 0, recent: results('1'.repeat(count)) }
}

/** Every topic with the same stats. */
function everyTopic(stats: TopicStats): Partial<Record<TopicId, TopicStats>> {
  return Object.fromEntries(TOPICS.map((topic) => [topic.id, stats]))
}

// Some tests below use the real progress store. In this test runner there is no browser
// storage, so the store lives in memory; it is emptied after each test.
afterEach(() => {
  resetProgress()
})

describe('the numbers of the progress store that this page uses', () => {
  it(`the store keeps the newest ${MAX_QUIZZES} quiz results`, () => {
    for (let day = 1; day <= MAX_QUIZZES + 5; day++) recordQuiz(quiz(day % 15, 15, day))
    const kept = getProgress().quizzes
    expect(kept).toHaveLength(MAX_QUIZZES)
    // The five oldest are gone.
    expect(kept[0]).toEqual(quiz(6, 15, 6))
  })

  it(`a topic is mastered from ${MASTERED_ATTEMPTS} recent answers, all right`, () => {
    const masteredWith = (stats: TopicStats): boolean => {
      const row = topicRows(progress({ practice: { rip: stats } })).find(
        (candidate) => candidate.topic.id === 'rip',
      )
      if (row === undefined) throw new Error('No row for rip.')
      return isMastered(row)
    }
    expect(masteredWith(allRight(MASTERED_ATTEMPTS - 1))).toBe(false)
    expect(masteredWith(allRight(MASTERED_ATTEMPTS))).toBe(true)
  })
})

describe('toPercent', () => {
  it('rounds to a whole percentage', () => {
    expect(toPercent(0)).toBe(0)
    expect(toPercent(0.375)).toBe(38)
    expect(toPercent(2 / 3)).toBe(67)
    expect(toPercent(1)).toBe(100)
  })

  it('never goes below 0 or above 100', () => {
    expect(toPercent(-0.5)).toBe(0)
    expect(toPercent(1.5)).toBe(100)
  })
})

describe('lessons', () => {
  it('lists every lesson of the course in order, with its done mark', () => {
    const rows = lessonRows(progress({ lessonsDone: { mov: DATE, 'register-names': DATE } }))
    expect(rows.map((row) => row.lesson.id)).toEqual(LESSONS.map((lesson) => lesson.id))
    expect(rows.filter((row) => row.done).map((row) => row.lesson.id)).toEqual([
      'register-names',
      'mov',
    ])
  })

  it('counts only lessons of the course', () => {
    const data = progress({ lessonsDone: { mov: DATE, 'a-lesson-that-is-gone': DATE } })
    expect(lessonsDone(data)).toBe(1)
    expect(lessonsDone(progress())).toBe(0)
    const all = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, DATE]))
    expect(lessonsDone(progress({ lessonsDone: all }))).toBe(14)
  })
})

describe('practice', () => {
  const data = progress({
    practice: {
      rip: { right: 4, wrong: 1, recent: results('11011') },
      // More answers than are kept: Right and Wrong count all of them, accuracy the recent ones.
      'mov-legality': { right: 25, wrong: 3, recent: results('11111111111111111111') },
    },
  })

  it('has one row per topic, in the order of the practice page', () => {
    expect(topicRows(data).map((row) => row.topic.id)).toEqual(TOPICS.map((topic) => topic.id))
  })

  it('gives the numbers of a topic that was tried', () => {
    const rip = topicRows(data).find((row) => row.topic.id === 'rip')
    expect(rip).toMatchObject({
      tried: true,
      right: 4,
      wrong: 1,
      recentCount: 5,
      recentRight: 4,
      accuracy: 0.8,
    })
    const mov = topicRows(data).find((row) => row.topic.id === 'mov-legality')
    expect(mov).toMatchObject({ right: 25, wrong: 3, recentCount: 20, accuracy: 1 })
  })

  it('marks a topic that was never tried', () => {
    const row = topicRows(data).find((candidate) => candidate.topic.id === 'call-ret')
    expect(row).toMatchObject({ tried: false, right: 0, wrong: 0, recentCount: 0, accuracy: null })
  })

  it('knows when there is a practice history', () => {
    expect(hasPracticeHistory(data)).toBe(true)
    expect(hasPracticeHistory(progress())).toBe(false)
  })
})

describe('the weakest topics', () => {
  it('shows three topics, in the order of the progress store', () => {
    const data = progress({
      practice: {
        'subregister-writes': { right: 3, wrong: 5, recent: results('01001010') },
        'rsp-tracker': { right: 2, wrong: 2, recent: results('0101') },
        'call-ret': { right: 5, wrong: 5, recent: results('1010101010') },
        'indirect-addressing': { right: 2, wrong: 6, recent: results('00100100') },
      },
    })
    const rows = weakTopicRows(data)
    expect(WEAK_TOPIC_COUNT).toBe(3)
    expect(rows.map((row) => row.topic.id)).toEqual(weakestTopics(data, 3))
    // 25 %, 38 %, then the tie at 50 %: more answers first.
    expect(rows.map((row) => row.topic.id)).toEqual([
      'indirect-addressing',
      'subregister-writes',
      'call-ret',
    ])
    expect(rows.map((row) => row.accuracy)).toEqual([0.25, 0.375, 0.5])
  })

  it('fills up with topics that were not tried yet', () => {
    const data = progress({ practice: { rip: { right: 1, wrong: 1, recent: results('10') } } })
    const rows = weakTopicRows(data)
    expect(rows.map((row) => [row.topic.id, row.tried])).toEqual([
      ['rip', true],
      ['register-names', false],
      ['subregister-writes', false],
    ])
  })

  it('knows a mastered topic', () => {
    const rowOf = (stats: TopicStats) =>
      topicRows(progress({ practice: { rip: stats } })).find((row) => row.topic.id === 'rip')
    const mastered = rowOf(allRight(MASTERED_ATTEMPTS))
    const tooFew = rowOf(allRight(MASTERED_ATTEMPTS - 1))
    const oneWrong = rowOf({ right: 19, wrong: 1, recent: results(`0${'1'.repeat(19)}`) })
    if (mastered === undefined || tooFew === undefined || oneWrong === undefined) throw new Error()
    expect(isMastered(mastered)).toBe(true)
    expect(isMastered(tooFew)).toBe(false)
    expect(isMastered(oneWrong)).toBe(false)
  })

  it('never calls a mastered topic weak, even when the store has nothing else to give', () => {
    // Every topic mastered: the store still gives three topics, the page lists none.
    const all = progress({ practice: everyTopic(allRight(20)) })
    expect(weakestTopics(all, 3)).toHaveLength(3)
    expect(weakTopicRows(all)).toEqual([])

    // Six topics mastered and two never tried: the two untried topics, and no mastered one.
    const practice = everyTopic(allRight(MASTERED_ATTEMPTS))
    delete practice['call-ret']
    delete practice['homework-table']
    const rows = weakTopicRows(progress({ practice }))
    expect(rows.map((row) => [row.topic.id, row.tried])).toEqual([
      ['call-ret', false],
      ['homework-table', false],
    ])
  })

  it('still lists a topic at 100 % when it has too few answers to count as mastered', () => {
    const data = progress({ practice: everyTopic(allRight(MASTERED_ATTEMPTS)) })
    data.practice.rip = allRight(MASTERED_ATTEMPTS - 1)
    const rows = weakTopicRows(data)
    expect(rows.map((row) => [row.topic.id, row.accuracy])).toEqual([['rip', 1]])
  })

  it('agrees with the weak spots of the practice pages: a topic with no mistake comes last', () => {
    // A topic with 3 right answers out of 3 is not a weak spot yet: the topic with a
    // mistake comes first, then two topics that were never tried.
    const data = progress({
      practice: {
        rip: allRight(3),
        'call-ret': { right: 1, wrong: 1, recent: results('10') },
      },
    })
    expect(weakTopicRows(data).map((row) => [row.topic.id, row.tried])).toEqual([
      ['call-ret', true],
      ['register-names', false],
      ['subregister-writes', false],
    ])
  })
})

describe('mock quizzes', () => {
  it('has nothing to show before the first quiz', () => {
    expect(quizSummary(progress())).toBeNull()
  })

  it('gives the latest and the best quiz', () => {
    const quizzes = [quiz(9, 15, 10), quiz(12, 15, 12), quiz(11, 15, 14)]
    expect(quizSummary(progress({ quizzes }))).toEqual({
      count: 3,
      onlyNewest: false,
      latest: quizzes[2],
      best: quizzes[1],
    })
  })

  it(`says when the numbers may cover only the newest ${MAX_QUIZZES} quizzes`, () => {
    const many = (count: number) => Array.from({ length: count }, (_, day) => quiz(10, 15, day + 1))
    expect(quizSummary(progress({ quizzes: many(MAX_QUIZZES - 1) }))?.onlyNewest).toBe(false)
    expect(quizSummary(progress({ quizzes: many(MAX_QUIZZES) }))?.onlyNewest).toBe(true)
  })

  it('after 25 quizzes, the best is the best of the 20 the store kept', () => {
    // The very best quiz (15 of 15) is the second one, so the store drops it.
    for (let day = 1; day <= 25; day++)
      recordQuiz(quiz(day === 2 ? 15 : day === 18 ? 13 : 9, 15, day))
    const summary = quizSummary(getProgress())
    expect(summary).toMatchObject({ count: MAX_QUIZZES, onlyNewest: true })
    expect(summary?.best).toEqual(quiz(13, 15, 18))
    expect(summary?.latest).toEqual(quiz(9, 15, 25))
  })

  it('compares the share of right answers, and a newer quiz wins a tie', () => {
    const quizzes = [quiz(8, 10, 10), quiz(12, 15, 12), quiz(3, 5, 14)]
    // 8 of 10 and 12 of 15 are both 80 %.
    expect(quizSummary(progress({ quizzes }))?.best).toBe(quizzes[1])
  })

  it('counts a quiz with no questions as 0 %', () => {
    expect(quizShare(quiz(0, 0, 10))).toBe(0)
    expect(quizShare(quiz(3, 4, 10))).toBe(0.75)
  })
})

describe('a new student', () => {
  it('has empty progress', () => {
    expect(isEmptyProgress(progress())).toBe(true)
    // A lesson that is no longer part of the course does not count.
    expect(isEmptyProgress(progress({ lessonsDone: { 'a-lesson-that-is-gone': DATE } }))).toBe(true)
  })

  it('does not, after one lesson, one answer or one quiz', () => {
    expect(isEmptyProgress(progress({ lessonsDone: { mov: DATE } }))).toBe(false)
    const answer = { rip: { right: 0, wrong: 1, recent: [false] } }
    expect(isEmptyProgress(progress({ practice: answer }))).toBe(false)
    expect(isEmptyProgress(progress({ quizzes: [quiz(5, 15, 10)] }))).toBe(false)
  })
})
