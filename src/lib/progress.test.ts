// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isLessonId, lessonById, LESSONS, type LessonId } from '../content/lessonList'
import { isTopicId, topicById, TOPICS, type TopicId } from '../content/topics'
import type * as ProgressModule from './progress'
import type { ProgressData, QuizResult, TopicStats } from './progress'

const KEY = 'stackstep:progress:v1'

/**
 * The store keeps its state in the module, so every test loads a new copy of the module
 * (the same thing a page reload does).
 */
async function loadModule(): Promise<typeof ProgressModule> {
  vi.resetModules()
  return import('./progress')
}

function store(value: unknown): void {
  window.localStorage.setItem(KEY, typeof value === 'string' ? value : JSON.stringify(value))
}

function stored(): unknown {
  const text = window.localStorage.getItem(KEY)
  return text === null ? null : (JSON.parse(text) as unknown)
}

function blocked(): never {
  throw new DOMException('The operation is insecure.', 'SecurityError')
}

/** Stats with `right` right answers followed by `wrong` wrong ones. */
function stats(right: number, wrong: number): TopicStats {
  return {
    right,
    wrong,
    recent: [...Array<boolean>(right).fill(true), ...Array<boolean>(wrong).fill(false)].slice(-20),
  }
}

function data(practice: Partial<Record<TopicId, TopicStats>>): ProgressData {
  return { version: 1, lessonsDone: {}, practice, quizzes: [] }
}

const EMPTY: ProgressData = { version: 1, lessonsDone: {}, practice: {}, quizzes: [] }
const ALL_TOPICS = TOPICS.map((topic) => topic.id)

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('fresh state', () => {
  it('starts empty when nothing is stored', async () => {
    const progress = await loadModule()
    expect(progress.getProgress()).toEqual(EMPTY)
  })

  it('returns the same object until something changes', async () => {
    const progress = await loadModule()
    const first = progress.getProgress()
    expect(progress.getProgress()).toBe(first)
    progress.markLessonDone('mov')
    const second = progress.getProgress()
    expect(second).not.toBe(first)
    expect(progress.getProgress()).toBe(second)
    // The old object was not changed in place.
    expect(first).toEqual(EMPTY)
  })

  it('does not write to storage just because it was read', async () => {
    const progress = await loadModule()
    progress.getProgress()
    expect(stored()).toBeNull()
  })

  it('loads what an earlier visit stored', async () => {
    const before = await loadModule()
    before.markLessonDone('mov')
    before.recordAttempt('rip', true)
    const saved = before.getProgress()

    const after = await loadModule()
    expect(after.getProgress()).toEqual(saved)
  })
})

describe('markLessonDone and isLessonDone', () => {
  it('stores the time the lesson was finished and saves it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'))
    const progress = await loadModule()
    progress.markLessonDone('mov')

    const now = progress.getProgress()
    expect(now.lessonsDone).toEqual({ mov: '2026-03-04T05:06:07.000Z' })
    expect(progress.isLessonDone(now, 'mov')).toBe(true)
    expect(progress.isLessonDone(now, 'lea-vs-mov')).toBe(false)
    expect(stored()).toEqual(now)
  })

  it('keeps the first date when a lesson is finished again, and tells nobody', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'))
    const progress = await loadModule()
    progress.markLessonDone('mov')
    const first = progress.getProgress()
    const listener = vi.fn()
    progress.subscribeProgress(listener)

    vi.setSystemTime(new Date('2026-09-09T09:09:09.000Z'))
    progress.markLessonDone('mov')
    expect(progress.getProgress()).toBe(first)
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps several lessons', async () => {
    const progress = await loadModule()
    progress.markLessonDone('mov')
    progress.markLessonDone('stack-and-rsp')
    expect(Object.keys(progress.getProgress().lessonsDone)).toEqual(['mov', 'stack-and-rsp'])
  })

  it('ignores an empty lesson id', async () => {
    const progress = await loadModule()
    progress.markLessonDone('')
    expect(progress.getProgress()).toEqual(EMPTY)
  })

  it('is not fooled by names that every object has', async () => {
    const progress = await loadModule()
    const fresh = progress.getProgress()
    expect(progress.isLessonDone(fresh, 'constructor')).toBe(false)
    expect(progress.isLessonDone(fresh, 'toString')).toBe(false)
    expect(progress.isLessonDone(fresh, '__proto__')).toBe(false)
    progress.markLessonDone('__proto__')
    expect(progress.getProgress()).toEqual(EMPTY)
    progress.markLessonDone('constructor')
    expect(progress.isLessonDone(progress.getProgress(), 'constructor')).toBe(true)
  })
})

describe('recordAttempt', () => {
  it('counts right and wrong answers and keeps them in order, newest last', async () => {
    const progress = await loadModule()
    progress.recordAttempt('rip', true)
    progress.recordAttempt('rip', false)
    progress.recordAttempt('rip', true)
    progress.recordAttempt('call-ret', false)

    const now = progress.getProgress()
    expect(now.practice.rip).toEqual({ right: 2, wrong: 1, recent: [true, false, true] })
    expect(now.practice['call-ret']).toEqual({ right: 0, wrong: 1, recent: [false] })
    expect(now.practice['mov-legality']).toBeUndefined()
    expect(stored()).toEqual(now)
  })

  it('keeps only the 20 newest results, but keeps counting all of them', async () => {
    const progress = await loadModule()
    // 5 wrong answers first, then 20 right ones: the wrong ones fall off the list.
    for (let i = 0; i < 5; i++) progress.recordAttempt('rip', false)
    for (let i = 0; i < 19; i++) progress.recordAttempt('rip', true)
    expect(progress.getProgress().practice.rip?.recent).toHaveLength(20)
    expect(progress.getProgress().practice.rip?.recent.slice(0, 2)).toEqual([false, true])

    progress.recordAttempt('rip', true)
    const rip = progress.getProgress().practice.rip
    expect(rip?.recent).toEqual(Array<boolean>(20).fill(true))
    expect(rip?.right).toBe(20)
    expect(rip?.wrong).toBe(5)
  })

  it('ignores a topic that does not exist', async () => {
    const progress = await loadModule()
    progress.recordAttempt('no-such-topic' as TopicId, true)
    expect(progress.getProgress()).toEqual(EMPTY)
  })
})

describe('recordQuiz', () => {
  const quiz = (score: number): QuizResult => ({
    score,
    total: 30,
    date: '2026-03-04T05:06:07.000Z',
    weakTopics: ['rip', 'call-ret'],
  })

  it('adds results, newest last, and saves them', async () => {
    const progress = await loadModule()
    progress.recordQuiz(quiz(9))
    progress.recordQuiz(quiz(12))
    const now = progress.getProgress()
    expect(now.quizzes).toEqual([quiz(9), quiz(12)])
    expect(stored()).toEqual(now)
  })

  it('keeps only the 20 newest results', async () => {
    const progress = await loadModule()
    for (let score = 1; score <= 23; score++) progress.recordQuiz(quiz(score))
    const scores = progress.getProgress().quizzes.map((result) => result.score)
    expect(scores).toHaveLength(20)
    expect(scores[0]).toBe(4)
    expect(scores[19]).toBe(23)
  })

  it('stores a copy, so later changes to the argument do not leak in', async () => {
    const progress = await loadModule()
    const mine = quiz(9)
    progress.recordQuiz(mine)
    mine.score = 0
    mine.weakTopics.push('rip')
    expect(progress.getProgress().quizzes).toEqual([quiz(9)])
  })

  it('ignores a result that makes no sense', async () => {
    const progress = await loadModule()
    progress.recordQuiz({ ...quiz(9), score: 31 })
    progress.recordQuiz({ ...quiz(9), score: -1 })
    progress.recordQuiz({ ...quiz(9), score: 1.5 })
    progress.recordQuiz({ ...quiz(9), date: 'yesterday' })
    expect(progress.getProgress()).toEqual(EMPTY)
  })
})

describe('resetProgress', () => {
  it('forgets lessons, practice and quizzes, and removes the stored copy', async () => {
    const progress = await loadModule()
    progress.markLessonDone('mov')
    progress.recordAttempt('rip', true)
    progress.recordQuiz({ score: 1, total: 2, date: '2026-03-04T05:06:07.000Z', weakTopics: [] })
    const listener = vi.fn()
    progress.subscribeProgress(listener)

    progress.resetProgress()
    expect(progress.getProgress()).toEqual(EMPTY)
    expect(window.localStorage.getItem(KEY)).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)

    const reloaded = await loadModule()
    expect(reloaded.getProgress()).toEqual(EMPTY)
  })
})

describe('stored data that cannot be trusted', () => {
  it.each([
    ['cut-off JSON', '{"version":1,"lessonsDone":{'],
    ['text that is not JSON', 'hello'],
    ['an empty string', ''],
    ['null', 'null'],
    ['a number', '7'],
    ['a list', '[]'],
    [
      'version 2',
      { version: 2, lessonsDone: { mov: '2026-01-01T00:00:00.000Z' }, practice: {}, quizzes: [] },
    ],
    ['a version written as text', { version: '1', lessonsDone: {}, practice: {}, quizzes: [] }],
    ['no version', { lessonsDone: {}, practice: {}, quizzes: [] }],
    ['lessonsDone as a list', { version: 1, lessonsDone: ['mov'], practice: {}, quizzes: [] }],
    ['practice missing', { version: 1, lessonsDone: {}, quizzes: [] }],
    ['quizzes as an object', { version: 1, lessonsDone: {}, practice: {}, quizzes: {} }],
  ])('starts fresh for %s, without throwing', async (_name, value) => {
    store(value)
    const progress = await loadModule()
    expect(progress.getProgress()).toEqual(EMPTY)
  })

  it('still works after a fresh start, and replaces the broken data on the next change', async () => {
    store('{"version":1,')
    const progress = await loadModule()
    progress.markLessonDone('mov')
    expect(progress.isLessonDone(progress.getProgress(), 'mov')).toBe(true)
    expect(stored()).toEqual(progress.getProgress())
  })

  it('drops single bad entries and keeps the good ones', async () => {
    store({
      version: 1,
      lessonsDone: {
        mov: '2026-01-01T00:00:00.000Z',
        'stack-and-rsp': 12345,
        'rip-cycle': 'not a date',
        '': '2026-01-01T00:00:00.000Z',
      },
      practice: {
        rip: { right: 2, wrong: 1, recent: [true, false, true] },
        'call-ret': { right: 1, wrong: 0, recent: [true, 'yes'] },
        'rsp-tracker': { right: -1, wrong: 0, recent: [] },
        'mov-legality': { right: 1.5, wrong: 0, recent: [true] },
        'register-names': 'lots',
        'no-such-topic': { right: 1, wrong: 0, recent: [true] },
      },
      quizzes: [
        { score: 3, total: 15, date: '2026-01-02T00:00:00.000Z', weakTopics: ['rip', 'nope', 7] },
        { score: 20, total: 15, date: '2026-01-02T00:00:00.000Z', weakTopics: [] },
        { score: 3, total: 15, date: 'soon', weakTopics: [] },
        { score: 3, total: 15, date: '2026-01-02T00:00:00.000Z' },
        'a quiz',
        null,
      ],
    })
    const progress = await loadModule()
    expect(progress.getProgress()).toEqual({
      version: 1,
      lessonsDone: { mov: '2026-01-01T00:00:00.000Z' },
      practice: { rip: { right: 2, wrong: 1, recent: [true, false, true] } },
      quizzes: [{ score: 3, total: 15, date: '2026-01-02T00:00:00.000Z', weakTopics: ['rip'] }],
    })
  })

  it('cuts lists that are too long down to the 20 newest', async () => {
    const recent = [...Array<boolean>(10).fill(false), ...Array<boolean>(20).fill(true)]
    const quizzes = Array.from({ length: 25 }, (_, i) => ({
      score: i,
      total: 30,
      date: '2026-01-02T00:00:00.000Z',
      weakTopics: [],
    }))
    store({
      version: 1,
      lessonsDone: {},
      practice: { rip: { right: 20, wrong: 10, recent } },
      quizzes,
    })
    const progress = await loadModule()
    const now = progress.getProgress()
    expect(now.practice.rip?.recent).toEqual(Array<boolean>(20).fill(true))
    expect(now.quizzes.map((quiz) => quiz.score)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 5),
    )
  })
})

describe('storage that is blocked', () => {
  it('starts fresh and works in memory when getItem throws', async () => {
    store({
      version: 1,
      lessonsDone: { mov: '2026-01-01T00:00:00.000Z' },
      practice: {},
      quizzes: [],
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    const progress = await loadModule()
    expect(progress.getProgress()).toEqual(EMPTY)

    progress.recordAttempt('rip', true)
    expect(progress.getProgress().practice.rip).toEqual({ right: 1, wrong: 0, recent: [true] })
  })

  it('keeps every change in memory when setItem throws', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    const progress = await loadModule()
    const listener = vi.fn()
    progress.subscribeProgress(listener)

    progress.markLessonDone('mov')
    progress.recordAttempt('rip', false)
    progress.recordQuiz({ score: 1, total: 2, date: '2026-03-04T05:06:07.000Z', weakTopics: [] })

    const now = progress.getProgress()
    expect(progress.isLessonDone(now, 'mov')).toBe(true)
    expect(now.practice.rip?.wrong).toBe(1)
    expect(now.quizzes).toHaveLength(1)
    expect(listener).toHaveBeenCalledTimes(3)
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it('works when even reading window.localStorage throws', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(blocked)
    const progress = await loadModule()
    expect(progress.getProgress()).toEqual(EMPTY)
    progress.markLessonDone('mov')
    progress.resetProgress()
    progress.recordAttempt('rip', true)
    expect(progress.getProgress().practice.rip?.right).toBe(1)
  })
})

describe('accuracy', () => {
  it('is null when there are no attempts', async () => {
    const { accuracy } = await loadModule()
    expect(accuracy(undefined)).toBeNull()
    expect(accuracy({ right: 0, wrong: 0, recent: [] })).toBeNull()
  })

  it('is the share of right answers among the recent ones', async () => {
    const { accuracy } = await loadModule()
    expect(accuracy({ right: 1, wrong: 0, recent: [true] })).toBe(1)
    expect(accuracy({ right: 0, wrong: 2, recent: [false, false] })).toBe(0)
    expect(accuracy({ right: 3, wrong: 1, recent: [true, false, true, true] })).toBe(0.75)
  })

  it('looks only at the recent list, not at the totals', async () => {
    const { accuracy } = await loadModule()
    // 100 old wrong answers, but the 20 newest are all right.
    expect(accuracy({ right: 20, wrong: 100, recent: Array<boolean>(20).fill(true) })).toBe(1)
  })
})

describe('recentAnswersWords', () => {
  it('says "of 1 answer" for one answer and "of your last N" for more', async () => {
    const { recentAnswersWords } = await loadModule()
    expect(recentAnswersWords(0, 1)).toBe('0 right of 1\u00a0answer')
    expect(recentAnswersWords(1, 1)).toBe('1 right of 1\u00a0answer')
    expect(recentAnswersWords(4, 5)).toBe('4 right of your last\u00a05')
  })

  it('never lets the number start a line alone (a space that does not break before it)', async () => {
    const { recentAnswersWords } = await loadModule()
    expect(recentAnswersWords(2, 3)).toMatch(/last\u00a03$/)
    expect(recentAnswersWords(2, 3).replaceAll('\u00a0', ' ')).toBe('2 right of your last 3')
  })
})

describe('weakestTopics', () => {
  it('lists untried topics in the order of TOPICS when nothing was tried', async () => {
    const { weakestTopics } = await loadModule()
    expect(weakestTopics(EMPTY, 3)).toEqual(ALL_TOPICS.slice(0, 3))
  })

  it('puts the lowest recent accuracy first', async () => {
    const { weakestTopics } = await loadModule()
    const progress = data({
      'register-names': stats(9, 1),
      rip: stats(1, 3),
      'call-ret': stats(2, 2),
    })
    expect(weakestTopics(progress, 3)).toEqual(['rip', 'call-ret', 'register-names'])
  })

  it('breaks a tie with more attempts first, then the order of TOPICS', async () => {
    const { weakestTopics } = await loadModule()
    const progress = data({
      'register-names': stats(1, 1),
      'rsp-tracker': stats(5, 5),
      rip: stats(1, 1),
    })
    expect(weakestTopics(progress, 3)).toEqual(['rsp-tracker', 'register-names', 'rip'])
  })

  it('fills up with untried topics, in the order of TOPICS', async () => {
    const { weakestTopics } = await loadModule()
    const progress = data({ 'call-ret': stats(1, 1) })
    expect(weakestTopics(progress, 3)).toEqual(['call-ret', 'register-names', 'subregister-writes'])
  })

  it('lists a topic with only right answers after the untried ones, also with few answers', async () => {
    const { weakestTopics } = await loadModule()
    // 4 right answers are not enough to count as mastered, but there is no mistake to
    // practise: the topics never tried come first.
    const progress = data({ 'call-ret': stats(4, 0), rip: stats(1, 1) })
    expect(weakestTopics(progress, 3)).toEqual(['rip', 'register-names', 'subregister-writes'])
    expect(weakestTopics(progress, TOPICS.length).at(-1)).toBe('call-ret')
  })

  it('puts the topics with only right answers in order: the fewest answers first', async () => {
    const { weakestTopics } = await loadModule()
    const practice: Partial<Record<TopicId, TopicStats>> = {}
    for (const id of ALL_TOPICS) practice[id] = stats(20, 0)
    practice['mov-legality'] = stats(3, 0)
    practice.rip = stats(6, 0)
    // Old mistakes are gone from the recent answers: 5 recent answers, all right.
    practice['call-ret'] = { right: 30, wrong: 9, recent: Array<boolean>(5).fill(true) }
    practice['register-names'] = stats(5, 0)
    expect(weakestTopics(data(practice), 4)).toEqual([
      'mov-legality',
      // Two with 5 recent answers: more answers in all first.
      'call-ret',
      'register-names',
      'rip',
    ])
  })

  it('gives the same order as the "weak spots" rule: mistakes, then untried, then all right', async () => {
    const { weakestTopics, accuracy } = await loadModule()
    // Many random students: the groups never mix, whatever the numbers.
    let seed = 12345
    const random = (below: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % below
    }
    for (let student = 0; student < 300; student += 1) {
      const practice: Partial<Record<TopicId, TopicStats>> = {}
      for (const id of ALL_TOPICS) {
        if (random(3) === 0) continue
        const recent = Array.from({ length: 1 + random(20) }, () => random(4) !== 0)
        const right = recent.filter(Boolean).length + random(5)
        practice[id] = { right, wrong: recent.length - recent.filter(Boolean).length, recent }
      }
      const order = weakestTopics(data(practice), TOPICS.length)
      const group = (id: TopicId): number => {
        const share = accuracy(practice[id])
        return share === null ? 1 : share < 1 ? 0 : 2
      }
      const groups = order.map(group)
      expect(groups, `student ${student}`).toEqual([...groups].sort((a, b) => a - b))
      // Inside the first group: the lowest accuracy first.
      const shares = order.filter((id) => group(id) === 0).map((id) => accuracy(practice[id]) ?? 0)
      expect(shares).toEqual([...shares].sort((a, b) => a - b))
      // Inside the last group: the fewest recent answers first.
      const counts = order.filter((id) => group(id) === 2).map((id) => practice[id]?.recent.length)
      expect(counts).toEqual([...counts].sort((a, b) => (a ?? 0) - (b ?? 0)))
    }
  })

  it('never lists a mastered topic while another candidate exists', async () => {
    const { weakestTopics } = await loadModule()
    const progress = data({ 'register-names': stats(5, 0), rip: stats(20, 0) })
    const picked = weakestTopics(progress, 6)
    expect(picked).toEqual(ALL_TOPICS.filter((id) => id !== 'register-names' && id !== 'rip'))
  })

  it('counts recent answers for mastery: old mistakes are forgiven', async () => {
    const { weakestTopics } = await loadModule()
    const forgiven: TopicStats = { right: 20, wrong: 9, recent: Array<boolean>(20).fill(true) }
    const picked = weakestTopics(data({ 'register-names': forgiven }), 7)
    expect(picked).not.toContain('register-names')
  })

  it('lists mastered topics last when nothing else is left', async () => {
    const { weakestTopics } = await loadModule()
    const practice: Partial<Record<TopicId, TopicStats>> = {}
    for (const id of ALL_TOPICS) practice[id] = stats(5, 0)
    practice.rip = stats(12, 0)
    practice['call-ret'] = stats(3, 1)
    const picked = weakestTopics(data(practice), 3)
    // The one topic that still needs work, then mastered ones: the fewest answers first,
    // so the topic with 12 answers comes last.
    expect(picked).toEqual(['call-ret', 'register-names', 'subregister-writes'])
    expect(weakestTopics(data(practice), TOPICS.length).at(-1)).toBe('rip')
  })

  it('exports the numbers that the progress page uses', async () => {
    const { MAX_QUIZZES, MASTERED_ATTEMPTS, recordQuiz, getProgress } = await loadModule()
    expect(MASTERED_ATTEMPTS).toBe(5)
    for (let day = 1; day <= MAX_QUIZZES + 3; day += 1) {
      recordQuiz({
        score: 1,
        total: 2,
        date: new Date(Date.UTC(2026, 0, day)).toISOString(),
        weakTopics: [],
      })
    }
    expect(getProgress().quizzes).toHaveLength(MAX_QUIZZES)
  })

  it('gives every topic once when asked for more than there are', async () => {
    const { weakestTopics } = await loadModule()
    const picked = weakestTopics(data({ rip: stats(0, 3), 'call-ret': stats(6, 0) }), 50)
    expect(picked).toHaveLength(TOPICS.length)
    expect(new Set(picked).size).toBe(TOPICS.length)
    expect(picked[0]).toBe('rip')
    expect(picked.at(-1)).toBe('call-ret')
  })

  it('gives nothing for a count of zero or less', async () => {
    const { weakestTopics } = await loadModule()
    expect(weakestTopics(EMPTY, 0)).toEqual([])
    expect(weakestTopics(EMPTY, -2)).toEqual([])
    expect(weakestTopics(EMPTY, Number.NaN)).toEqual([])
  })

  it('does not change the data it is given', async () => {
    const { weakestTopics } = await loadModule()
    const progress = data({ rip: stats(1, 3), 'call-ret': stats(2, 2) })
    const copy = structuredClone(progress)
    weakestTopics(progress, 3)
    expect(progress).toEqual(copy)
  })
})

describe('listeners', () => {
  it('are called once for every change', async () => {
    const progress = await loadModule()
    const listener = vi.fn()
    progress.subscribeProgress(listener)

    progress.markLessonDone('mov')
    expect(listener).toHaveBeenCalledTimes(1)
    progress.recordAttempt('rip', true)
    expect(listener).toHaveBeenCalledTimes(2)
    progress.recordQuiz({ score: 1, total: 2, date: '2026-03-04T05:06:07.000Z', weakTopics: [] })
    expect(listener).toHaveBeenCalledTimes(3)
    progress.resetProgress()
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('see the new data when they are called', async () => {
    const progress = await loadModule()
    const seen: boolean[] = []
    progress.subscribeProgress(() =>
      seen.push(progress.isLessonDone(progress.getProgress(), 'mov')),
    )
    progress.markLessonDone('mov')
    expect(seen).toEqual([true])
  })

  it('stop being called after they unsubscribe', async () => {
    const progress = await loadModule()
    const stays = vi.fn()
    const leaves = vi.fn()
    progress.subscribeProgress(stays)
    const unsubscribe = progress.subscribeProgress(leaves)

    progress.markLessonDone('mov')
    unsubscribe()
    progress.markLessonDone('lea-vs-mov')
    expect(stays).toHaveBeenCalledTimes(2)
    expect(leaves).toHaveBeenCalledTimes(1)
  })

  it('may unsubscribe while they are being called', async () => {
    const progress = await loadModule()
    const second = vi.fn()
    const unsubscribeFirst = progress.subscribeProgress(() => unsubscribeFirst())
    progress.subscribeProgress(second)
    expect(() => progress.markLessonDone('mov')).not.toThrow()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('other tabs', () => {
  /** What this tab sees when another tab saves `text` (null: the other tab removed the key). */
  function otherTabSaves(text: string | null): void {
    if (text === null) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, text)
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: text }))
  }

  const fromOtherTab: ProgressData = {
    version: 1,
    lessonsDone: { mov: '2026-01-01T00:00:00.000Z' },
    practice: { rip: { right: 1, wrong: 0, recent: [true] } },
    quizzes: [],
  }

  it('takes over a change that another tab saved', async () => {
    const progress = await loadModule()
    const listener = vi.fn()
    progress.subscribeProgress(listener)
    const before = progress.getProgress()

    otherTabSaves(JSON.stringify(fromOtherTab))

    expect(progress.getProgress()).toEqual(fromOtherTab)
    expect(progress.getProgress()).not.toBe(before)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('starts fresh when another tab reset the progress', async () => {
    const progress = await loadModule()
    progress.markLessonDone('mov')
    otherTabSaves(null)
    expect(progress.getProgress()).toEqual(EMPTY)
  })

  it('starts fresh when the whole storage was cleared', async () => {
    const progress = await loadModule()
    progress.markLessonDone('mov')
    window.localStorage.clear()
    window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }))
    expect(progress.getProgress()).toEqual(EMPTY)
  })

  it('ignores other keys, and events that change nothing', async () => {
    const progress = await loadModule()
    progress.markLessonDone('mov')
    const listener = vi.fn()
    progress.subscribeProgress(listener)
    const before = progress.getProgress()

    window.dispatchEvent(new StorageEvent('storage', { key: 'stackstep:theme', newValue: 'dark' }))
    otherTabSaves(JSON.stringify(before))

    expect(progress.getProgress()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not trust what the other tab wrote', async () => {
    const progress = await loadModule()
    progress.markLessonDone('mov')
    otherTabSaves('{"version":1,')
    expect(progress.getProgress()).toEqual(EMPTY)
  })

  it('hears other tabs even before anybody subscribes', async () => {
    const progress = await loadModule()
    progress.getProgress()
    otherTabSaves(JSON.stringify(fromOtherTab))
    expect(progress.isLessonDone(progress.getProgress(), 'mov')).toBe(true)
  })

  it('goes by what is stored now when two tabs save at almost the same moment', async () => {
    const progress = await loadModule()
    // This tab saves last …
    progress.markLessonDone('lea-vs-mov')
    const mine = progress.getProgress()
    // … and only then hears about the older save of the other tab.
    window.dispatchEvent(
      new StorageEvent('storage', { key: KEY, newValue: JSON.stringify(fromOtherTab) }),
    )
    expect(progress.getProgress()).toBe(mine)
  })

  it('uses the value the event carries when storage cannot be read in this tab', async () => {
    const progress = await loadModule()
    progress.getProgress()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    window.dispatchEvent(
      new StorageEvent('storage', { key: KEY, newValue: JSON.stringify(fromOtherTab) }),
    )
    expect(progress.getProgress()).toEqual(fromOtherTab)
  })
})

describe('useProgress', () => {
  it('gives the current progress and re-renders on change', async () => {
    const progress = await loadModule()
    const { result } = renderHook(() => progress.useProgress())
    expect(result.current).toEqual(EMPTY)

    act(() => progress.markLessonDone('mov'))
    expect(progress.isLessonDone(result.current, 'mov')).toBe(true)
    expect(result.current).toBe(progress.getProgress())

    act(() => progress.resetProgress())
    expect(result.current).toEqual(EMPTY)
  })
})

/*
 * The two lists that progress is built on. (They have no test file of their own.)
 */

/** One plain sentence: a single full stop, at the very end. Code in backticks comes in pairs. */
function expectOneSentence(text: string): void {
  const withoutCode = text.replace(/`[^`]*`/g, 'code')
  expect(withoutCode).not.toContain('`')
  expect(withoutCode.match(/[.!?](\s|$)/g)).toHaveLength(1)
  expect(withoutCode.endsWith('.')).toBe(true)
  expect(text.length).toBeLessThanOrEqual(120)
}

describe('TOPICS', () => {
  it('has the eight practice topics, each with its own id', () => {
    expect(TOPICS.map((topic) => topic.id)).toEqual([
      'register-names',
      'subregister-writes',
      'rsp-tracker',
      'rip',
      'call-ret',
      'indirect-addressing',
      'mov-legality',
      'homework-table',
    ])
  })

  it.each(TOPICS.map((topic) => [topic.id, topic] as const))(
    '%s has a title, a one-sentence blurb and lessons that exist',
    (_id, topic) => {
      expect(topic.title.trim()).toBe(topic.title)
      expect(topic.title).not.toBe('')
      expectOneSentence(topic.blurb)
      expect(topic.lessons.length).toBeGreaterThan(0)
      for (const lessonId of topic.lessons) expect(isLessonId(lessonId)).toBe(true)
    },
  )

  it('isTopicId knows the ids and nothing else', () => {
    for (const topic of TOPICS) expect(isTopicId(topic.id)).toBe(true)
    for (const other of ['', 'weak', 'quiz', 'RIP', 'rip ', 'toString', '__proto__']) {
      expect(isTopicId(other)).toBe(false)
    }
  })

  it('topicById finds a topic and refuses an unknown id', () => {
    expect(topicById('rip').title).toBe('Where is rip?')
    for (const topic of TOPICS) expect(topicById(topic.id)).toBe(topic)
    expect(() => topicById('weak' as TopicId)).toThrow('Unknown topic id: weak')
  })
})

describe('LESSONS', () => {
  it('has fourteen lessons, numbered 1 to 14 in order', () => {
    expect(LESSONS).toHaveLength(14)
    expect(LESSONS.map((lesson) => lesson.number)).toEqual(
      Array.from({ length: 14 }, (_, i) => i + 1),
    )
  })

  it('gives every lesson its own id, safe to use in an address', () => {
    const ids = LESSONS.map((lesson) => lesson.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it.each(LESSONS.map((lesson) => [lesson.id, lesson] as const))(
    '%s has a title and a one-sentence summary',
    (_id, lesson) => {
      expect(lesson.title.trim()).toBe(lesson.title)
      expect(lesson.title).not.toBe('')
      expect(lesson.title).not.toContain('`')
      expectOneSentence(lesson.summary)
    },
  )

  it('isLessonId knows the ids and nothing else', () => {
    for (const lesson of LESSONS) expect(isLessonId(lesson.id)).toBe(true)
    for (const other of ['', 'MOV', 'mov ', '5', 'constructor']) {
      expect(isLessonId(other)).toBe(false)
    }
  })

  it('lessonById finds a lesson and refuses an unknown id', () => {
    expect(lessonById('mov').number).toBe(5)
    expect(lessonById('mov').title).toBe('mov: copy a value')
    expect(() => lessonById('jmp' as LessonId)).toThrow('Unknown lesson id: jmp')
  })
})
