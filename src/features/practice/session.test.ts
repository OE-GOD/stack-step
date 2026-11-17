import { describe, expect, it, vi } from 'vitest'
import type { TopicId } from '../../content/topics'
import { makeProblem } from './generators'
import {
  blankQuestionNumbers,
  buildQuiz,
  EMPTY_SCORE,
  forgetRunningQuiz,
  freshSeed,
  gradeQuiz,
  isBlank,
  keepRunningQuiz,
  listOfNumbers,
  loadProblem,
  nextSeed,
  parseRunningQuiz,
  parseSeed,
  questionKey,
  planQuiz,
  quizRecord,
  readRunningQuiz,
  RUNNING_QUIZ_KEY,
  saveQuiz,
  scoreAfter,
  topicsToReview,
  type GradedQuestion,
  type ProblemMaker,
  type QuizQuestion,
} from './session'
import { QUIZ_LENGTH, quizTopicMix } from './topicMix'
import { MAX_ANSWER_LENGTH, type CheckResult, type Problem } from './types'

/** What a student types to get each field of a problem right. */
function rightAnswers(problem: Problem): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const field of problem.fields) {
    const id = field.kind.type === 'choice' || field.kind.type === 'chip'
    answers[field.id] = id ? field.expected : field.expectedDisplay
  }
  return answers
}

describe('seeds', () => {
  it('reads ?seed= as a whole number, or not at all', () => {
    expect(parseSeed(null)).toBeNull()
    expect(parseSeed('')).toBeNull()
    expect(parseSeed('abc')).toBeNull()
    expect(parseSeed('-3')).toBeNull()
    expect(parseSeed('1.5')).toBeNull()
    expect(parseSeed('7')).toBe(7)
    expect(parseSeed(' 12 ')).toBe(12)
    expect(parseSeed('4294967296')).toBe(0)
    expect(parseSeed('9'.repeat(16))).toBeNull()
  })

  it('never gives the same seed twice in a row', () => {
    const fixed = vi.fn(() => 5)
    expect(freshSeed(5, fixed)).toBe(6)
    expect(freshSeed(4, fixed)).toBe(5)
    expect(freshSeed(null, fixed)).toBe(5)
    let calls = 0
    expect(freshSeed(1, () => (calls++ === 0 ? 1 : 9))).toBe(9)
  })

  it('"Next problem" never shows the same question again, even from another seed', () => {
    // These two seeds make the same register-names question (a topic of about 200).
    const shown = makeProblem('register-names', 307056384)
    expect(questionKey(makeProblem('register-names', 404718107))).toBe(questionKey(shown))
    const seeds = [404718107, 404718107, 12]
    const next = () => seeds.shift() ?? 99
    const seed = nextSeed('register-names', { seed: 307056384, problem: shown }, makeProblem, next)
    expect(seed).toBe(12)
    expect(questionKey(makeProblem('register-names', seed))).not.toBe(questionKey(shown))
    // Nothing on the screen (a problem that failed): any new seed will do.
    expect(nextSeed('rip', { seed: 3, problem: null }, makeProblem, () => 3)).toBe(4)
  })
})

describe('loading a problem', () => {
  it('gives the problem when the generator works', () => {
    const load = loadProblem('register-names', 3)
    expect(load.kind).toBe('ready')
    if (load.kind === 'ready') expect(load.problem.id).toBe('register-names-3')
  })

  it('says "failed" for a generator bug, and never throws', () => {
    const broken: ProblemMaker = () => {
      throw new TypeError('a bug')
    }
    expect(loadProblem('rip', 4, broken)).toEqual({ kind: 'failed', topic: 'rip', seed: 4 })
  })
})

describe('the score', () => {
  it('counts right answers and the streak of right answers in a row', () => {
    let score = EMPTY_SCORE
    for (const correct of [true, true, false, true]) score = scoreAfter(score, correct)
    expect(score).toEqual({ right: 3, total: 4, streak: 1 })
    expect(scoreAfter(score, true)).toEqual({ right: 4, total: 5, streak: 2 })
    expect(scoreAfter(score, false).streak).toBe(0)
  })
})

describe('the quiz plan', () => {
  it('shuffles the questions and gives each a seed; the same quiz seed gives the same quiz', () => {
    const plan = planQuiz(11)
    expect(plan).toHaveLength(15)
    expect(planQuiz(11)).toEqual(plan)
    expect(planQuiz(12)).not.toEqual(plan)
    expect([...plan.map((slot) => slot.topic)].sort()).toEqual([...quizTopicMix()].sort())
    expect(new Set(plan.map((slot) => slot.seed)).size).toBe(15)
    // Not in the order of the topic list for every quiz.
    const inOrder = Array.from({ length: 20 }, (_, seed) => planQuiz(seed)).filter(
      (candidate) => candidate.map((slot) => slot.topic).join() === quizTopicMix().join(),
    )
    expect(inOrder).toHaveLength(0)
  })

  it('builds every question, numbered from 1, retrying a seed that fails', () => {
    const quiz = buildQuiz(3)
    expect(quiz.map((question) => question.number)).toEqual(
      Array.from({ length: QUIZ_LENGTH }, (_, index) => index + 1),
    )
    for (const question of quiz) expect(question.problem.topic).toBe(question.topic)

    let calls = 0
    const flaky: ProblemMaker = (_topic, seed) => {
      calls++
      if (calls % 2 === 0) throw new Error('a bug for this seed')
      return makeProblem('register-names', seed)
    }
    expect(buildQuiz(3, flaky)).toHaveLength(QUIZ_LENGTH)
  })

  it('keeps a quiz in progress in the tab, and reads back only what has the right shape', () => {
    // The browser review: a reload on question 4 started a different quiz and lost every
    // answer. The tab now keeps the seed, the question on the screen and the answers.
    const kept = new Map<string, string>()
    const storage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    }
    expect(readRunningQuiz(storage)).toBeNull()
    const quiz = { seed: 77, index: 3, answers: { 1: { rip: '0x4005' }, 4: { after: '' } } }
    keepRunningQuiz(quiz, storage)
    expect(readRunningQuiz(storage)).toEqual(quiz)
    forgetRunningQuiz(storage)
    expect(readRunningQuiz(storage)).toBeNull()

    // Without a usable seed and place there is no quiz to come back to.
    for (const value of [
      null,
      [],
      { seed: -1, index: 0, answers: {} },
      { seed: 1.5, index: 0, answers: {} },
      { seed: 3, index: -2, answers: {} },
      { seed: 3, index: 0, answers: [] },
    ]) {
      expect(parseRunningQuiz(value), JSON.stringify(value)).toBeNull()
    }
    // One strange answer is left out; the rest of the quiz comes back.
    expect(
      parseRunningQuiz({
        seed: 3,
        index: 1,
        answers: { x: {}, 1: { rip: '0x4005', bad: 5 }, 2: 'oops', 3: { after: '0x9' } },
      }),
    ).toEqual({ seed: 3, index: 1, answers: { 1: { rip: '0x4005' }, 3: { after: '0x9' } } })
    kept.set(RUNNING_QUIZ_KEY, '{not json')
    expect(readRunningQuiz(storage)).toBeNull()
    // Blocked storage: nothing is kept, and nothing throws.
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => keepRunningQuiz(quiz, blocked)).not.toThrow()
    expect(readRunningQuiz(blocked)).toBeNull()
    expect(() => forgetRunningQuiz(blocked)).not.toThrow()
  })

  it('one answer longer than an answer can be does not lose the quiz after a reload', () => {
    // The code review: one 201-character answer made `readRunningQuiz` return null, so a
    // reload started the quiz over and every answer was lost, without a word.
    const kept = new Map<string, string>()
    const storage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    }
    const long = '0x'.concat('1'.repeat(199))
    expect(long).toHaveLength(201)
    keepRunningQuiz(
      { seed: 9, index: 4, answers: { 1: { rip: long }, 2: { after: '0x9' } } },
      storage,
    )
    const back = readRunningQuiz(storage)
    expect(back).not.toBeNull()
    expect(back?.seed).toBe(9)
    expect(back?.index).toBe(4)
    expect(back?.answers[2]).toEqual({ after: '0x9' })
    // The long answer is cut to the longest answer a field takes.
    expect(back?.answers[1]?.rip).toBe(long.slice(0, MAX_ANSWER_LENGTH))
    expect(MAX_ANSWER_LENGTH).toBeGreaterThanOrEqual(64)
  })

  it('names the questions that have no answer yet', () => {
    const quiz = buildQuiz(9)
    const answers = Object.fromEntries(
      quiz
        .filter((question) => ![2, 7, 11].includes(question.number))
        .map((question) => [question.number, { [question.problem.fields[0]?.id ?? '']: 'x' }]),
    )
    expect(blankQuestionNumbers(quiz, answers)).toEqual([2, 7, 11])
    expect(listOfNumbers([2, 7, 11])).toBe('2, 7 and 11')
    expect(listOfNumbers([2, 7])).toBe('2 and 7')
    expect(listOfNumbers([4])).toBe('4')
    expect(listOfNumbers([])).toBe('')
  })

  it('never asks the same question twice in one quiz', () => {
    // Quiz 107 once asked one register-names question as question 5 and question 9.
    for (const quizSeed of [107, ...Array.from({ length: 150 }, (_, seed) => seed)]) {
      const quiz = buildQuiz(quizSeed)
      expect(quiz).toHaveLength(QUIZ_LENGTH)
      const keys = quiz.map((question) => questionKey(question.problem))
      expect(new Set(keys).size, `quiz ${quizSeed}`).toBe(QUIZ_LENGTH)
    }
    // A maker whose first seeds all make one question: the quiz tries the next seeds.
    const same: ProblemMaker = (_topic, seed) => makeProblem('register-names', seed % 3 ? seed : 0)
    const keys = buildQuiz(8, same).map((question) => questionKey(question.problem))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('grading a quiz', () => {
  const quiz = buildQuiz(21)

  it('counts the right answers; blanks are wrong', () => {
    const answers: Record<number, Record<string, string>> = {}
    for (const question of quiz.slice(0, 4))
      answers[question.number] = rightAnswers(question.problem)
    const grade = gradeQuiz(quiz, answers)
    expect(grade.total).toBe(QUIZ_LENGTH)
    expect(grade.score).toBe(4)
    expect(grade.questions[0]?.result.correct).toBe(true)
    const blank = grade.questions[QUIZ_LENGTH - 1]
    expect(blank?.result.correct).toBe(false)
    expect(blank?.result.mistake?.code).toBe('unanswered')
    expect(isBlank(blank?.answers)).toBe(true)
    expect(isBlank({ a: ' ', b: '' })).toBe(true)
    expect(isBlank({ a: 'x' })).toBe(false)
  })

  it('lists every topic with a wrong answer, weakest first', () => {
    const answers: Record<number, Record<string, string>> = {}
    for (const question of quiz) answers[question.number] = rightAnswers(question.problem)
    expect(gradeQuiz(quiz, answers).review).toEqual([])
    const allBlank = gradeQuiz(quiz, {})
    expect(allBlank.score).toBe(0)
    expect(new Set(allBlank.review.map((entry) => entry.topic))).toEqual(
      new Set(quiz.map((question) => question.topic)),
    )
  })

  it('orders the topics to review by share right, then wrong answers, then the topic list', () => {
    const graded = (topic: TopicId, correct: boolean): GradedQuestion => ({
      question: { number: 1, topic } as QuizQuestion,
      answers: {},
      result: { correct } as CheckResult,
    })
    const review = topicsToReview([
      graded('rip', true),
      graded('rip', false), // 1 of 2
      graded('call-ret', false), // 0 of 1
      graded('mov-legality', false),
      graded('mov-legality', false), // 0 of 2: more wrong than call-ret
      graded('register-names', true), // all right: not listed
      graded('subregister-writes', false),
      graded('subregister-writes', true), // 1 of 2, ties with rip: topic order
    ])
    expect(review.map((entry) => entry.topic)).toEqual([
      'mov-legality',
      'call-ret',
      'subregister-writes',
      'rip',
    ])
    expect(review[0]).toEqual({ topic: 'mov-legality', right: 0, wrong: 2 })
  })

  it('saves one attempt per question, then the quiz result', () => {
    const answers: Record<number, Record<string, string>> = {}
    const first = quiz[0]
    if (first !== undefined) answers[first.number] = rightAnswers(first.problem)
    const grade = gradeQuiz(quiz, answers)
    const date = new Date('2026-11-16T10:00:00.000Z')
    const calls: string[] = []
    saveQuiz(grade, date, {
      recordAttempt: (topic, correct) => calls.push(`${topic}:${correct}`),
      recordQuiz: (result) => calls.push(`quiz:${result.score}/${result.total}`),
    })
    expect(calls).toHaveLength(QUIZ_LENGTH + 1)
    expect(calls[0]).toBe(`${first?.topic}:true`)
    expect(calls.at(-1)).toBe(`quiz:1/${QUIZ_LENGTH}`)
    expect(quizRecord(grade, date)).toEqual({
      score: 1,
      total: QUIZ_LENGTH,
      date: '2026-11-16T10:00:00.000Z',
      weakTopics: grade.review.map((entry) => entry.topic),
    })
  })
})
