/**
 * The logic of a practice session and of the mixed quiz, without React:
 *
 * - loading a problem safely (a generator with a bug gives a friendly state instead of a
 *   crash);
 * - the score and the streak of a session;
 * - the quiz: its plan, grading, the topics to review, and what is saved.
 *
 * Which topics a session or a quiz draws from (the "weak spots" mix, the quiz's topics)
 * is in `topicMix.ts`, which the practice hub can use without the generators. The pages
 * (PracticeSessionPage, QuizPage) only turn these into screens.
 */
import { TOPICS, type TopicId } from '../../content/topics'
import { joinAnd } from '../../emulator'
import { recordAttempt, recordQuiz, type QuizResult } from '../../lib/progress'
import { createRng, randomSeed } from '../../lib/rng'
import { checkProblem } from './check'
import { makeProblem, normalizeSeed } from './generators'
import { quizTopicMix } from './topicMix'
import { MAX_ANSWER_LENGTH, type CheckResult, type Problem } from './types'

/* ──────────────────────────────── seeds ──────────────────────────────── */

/** The largest seed a new problem gets (seeds stay short in a link). */
const MAX_NEW_SEED = 0x7fff_fffe

/**
 * Read `?seed=N`. Any whole number is folded into the seed range (as `makeProblem`
 * does); null when the query has no seed or it is not a whole number.
 */
export function parseSeed(text: string | null): number | null {
  if (text === null) return null
  const trimmed = text.trim()
  if (!/^\d{1,15}$/.test(trimmed)) return null
  return normalizeSeed(Number(trimmed))
}

/** A new random seed that is not `previous` (so "Next problem" never repeats the problem). */
export function freshSeed(previous: number | null, next: () => number = randomSeed): number {
  for (let attempt = 0; attempt < 10; attempt++) {
    const seed = next()
    if (seed !== previous) return seed
  }
  return previous === null ? 0 : (previous + 1) % MAX_NEW_SEED
}

/**
 * What a student sees of a problem: two problems with the same key are the same question
 * (some topics have only a few hundred questions, so two seeds can make the same one).
 */
export function questionKey(problem: Problem): string {
  return JSON.stringify([problem.topic, problem.prompt, problem.fields, problem.chips ?? []])
}

/**
 * The seed of the next problem of a session: new, and not the same question as the one
 * on the screen now (tries a few seeds; a topic always has many questions).
 */
export function nextSeed(
  topic: TopicId,
  current: { seed: number; problem: Problem | null },
  make: ProblemMaker = makeProblem,
  next: () => number = randomSeed,
): number {
  const shown = current.problem === null ? null : questionKey(current.problem)
  let seed = freshSeed(current.seed, next)
  for (let attempt = 0; attempt < 10 && shown !== null; attempt++) {
    const load = loadProblem(topic, seed, make)
    if (load.kind !== 'ready' || questionKey(load.problem) !== shown) break
    seed = freshSeed(seed, next)
  }
  return seed
}

/* ─────────────────────────── loading a problem ───────────────────────── */

export type ProblemLoad =
  | { kind: 'ready'; problem: Problem }
  /** The generator threw for this seed: a bug, never the student's fault. */
  | { kind: 'failed'; topic: TopicId; seed: number }

/** Builds a problem: the registry's `makeProblem` (tests pass their own). */
export type ProblemMaker = (topic: TopicId, seed: number) => Problem

/** Build a problem without ever throwing. */
export function loadProblem(
  topic: TopicId,
  seed: number,
  make: ProblemMaker = makeProblem,
): ProblemLoad {
  try {
    return { kind: 'ready', problem: make(topic, seed) }
  } catch {
    return { kind: 'failed', topic, seed }
  }
}

/* ───────────────────────────── the score ─────────────────────────────── */

export interface SessionScore {
  /** Problems answered right in this session. */
  right: number
  /** Problems checked in this session. */
  total: number
  /** Right answers one after another, up to the latest one (0 after a wrong answer). */
  streak: number
}

export const EMPTY_SCORE: SessionScore = { right: 0, total: 0, streak: 0 }

export function scoreAfter(score: SessionScore, correct: boolean): SessionScore {
  return {
    right: score.right + (correct ? 1 : 0),
    total: score.total + 1,
    streak: correct ? score.streak + 1 : 0,
  }
}

/* ─────────────────────────────── the quiz ────────────────────────────── */

export interface QuizSlot {
  topic: TopicId
  seed: number
}

/**
 * The questions of a quiz: the quiz's topic mix (`quizTopicMix`) in a shuffled order, each
 * with its own seed. The same quiz seed gives the same quiz.
 */
export function planQuiz(quizSeed: number): QuizSlot[] {
  const rng = createRng(quizSeed)
  return rng.shuffle(quizTopicMix()).map((topic) => ({ topic, seed: rng.int(0, MAX_NEW_SEED) }))
}

export interface QuizQuestion {
  /** 1, 2, 3, … */
  number: number
  topic: TopicId
  problem: Problem
}

/** How many seeds a quiz tries before it gives up on one question. */
const QUIZ_TRIES = 5

/**
 * Build every question of a quiz. A generator bug for one seed makes it try the next
 * seed, and so does a seed that makes a question the quiz already asks.
 */
export function buildQuiz(quizSeed: number, make: ProblemMaker = makeProblem): QuizQuestion[] {
  const questions: QuizQuestion[] = []
  const asked = new Set<string>()
  for (const slot of planQuiz(quizSeed)) {
    let repeat: Problem | null = null
    for (let attempt = 0; attempt < QUIZ_TRIES; attempt++) {
      const load = loadProblem(slot.topic, slot.seed + attempt, make)
      if (load.kind !== 'ready') continue
      if (asked.has(questionKey(load.problem))) {
        repeat ??= load.problem
        continue
      }
      repeat = null
      asked.add(questionKey(load.problem))
      questions.push({ number: questions.length + 1, topic: slot.topic, problem: load.problem })
      break
    }
    // Only repeats came out (never seen in practice): keep the quiz its full length.
    if (repeat !== null) {
      questions.push({ number: questions.length + 1, topic: slot.topic, problem: repeat })
    }
  }
  return questions
}

/** The student's answers: question number → (field id → what was typed). */
export type QuizAnswers = Readonly<Record<number, Readonly<Record<string, string>>>>

export interface GradedQuestion {
  question: QuizQuestion
  answers: Readonly<Record<string, string>>
  result: CheckResult
}

export interface TopicReview {
  topic: TopicId
  right: number
  wrong: number
}

export interface QuizGrade {
  questions: GradedQuestion[]
  /** Questions answered right. */
  score: number
  total: number
  /** Every topic with at least one wrong answer, weakest first. */
  review: TopicReview[]
}

/** True when nothing at all was typed for a question. */
export function isBlank(answers: Readonly<Record<string, string>> | undefined): boolean {
  return answers === undefined || Object.values(answers).every((text) => text.trim() === '')
}

/**
 * Weakest first: the smallest share of right answers; then the most wrong answers; then
 * the order of the topic list.
 */
function weakestFirst(a: TopicReview, b: TopicReview): number {
  const share = (entry: TopicReview) => entry.right / (entry.right + entry.wrong)
  const order = (entry: TopicReview) => TOPICS.findIndex((topic) => topic.id === entry.topic)
  return share(a) - share(b) || b.wrong - a.wrong || order(a) - order(b)
}

/** The topics with at least one wrong answer, weakest first. */
export function topicsToReview(graded: readonly GradedQuestion[]): TopicReview[] {
  const byTopic = new Map<TopicId, TopicReview>()
  for (const { question, result } of graded) {
    const entry = byTopic.get(question.topic) ?? { topic: question.topic, right: 0, wrong: 0 }
    if (result.correct) entry.right++
    else entry.wrong++
    byTopic.set(question.topic, entry)
  }
  return [...byTopic.values()].filter((entry) => entry.wrong > 0).sort(weakestFirst)
}

export function gradeQuiz(questions: readonly QuizQuestion[], answers: QuizAnswers): QuizGrade {
  const graded = questions.map((question) => {
    const given = answers[question.number] ?? {}
    return { question, answers: given, result: checkProblem(question.problem, given) }
  })
  return {
    questions: graded,
    score: graded.filter((entry) => entry.result.correct).length,
    total: graded.length,
    review: topicsToReview(graded),
  }
}

/** The quiz result as the progress store keeps it. */
export function quizRecord(grade: QuizGrade, date: Date): QuizResult {
  return {
    score: grade.score,
    total: grade.total,
    date: date.toISOString(),
    weakTopics: grade.review.map((entry) => entry.topic),
  }
}

/* ─────────────────────────── a quiz in progress ──────────────────────────── */

/**
 * A quiz the student has not finished, kept in this browser tab (sessionStorage), so a
 * reload or a visit to a lesson does not lose the answers. The questions are not kept:
 * the same seed builds the same quiz again.
 */
export interface RunningQuiz {
  seed: number
  /** The question on the screen (0-based). */
  index: number
  answers: QuizAnswers
}

export const RUNNING_QUIZ_KEY = 'stackstep:quiz-running:v1'

/** The storage of this tab, or null when the browser blocks it. Never throws. */
function tabStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Anything → a running quiz, or null when it has no usable seed and place. An answer that
 * is not a text, or a question that is not a list of answers, is left out; a text longer
 * than an answer field takes is cut to that length. So one strange entry never costs the
 * student every other answer.
 */
export function parseRunningQuiz(value: unknown): RunningQuiz | null {
  if (!isPlainRecord(value)) return null
  const { seed, index, answers } = value
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    return null
  }
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= 100) {
    return null
  }
  if (!isPlainRecord(answers)) return null
  const clean: Record<number, Record<string, string>> = {}
  for (const [number, fields] of Object.entries(answers)) {
    if (!/^\d{1,3}$/.test(number) || !isPlainRecord(fields)) continue
    const texts: Record<string, string> = {}
    for (const [fieldId, text] of Object.entries(fields)) {
      if (typeof text === 'string') texts[fieldId] = text.slice(0, MAX_ANSWER_LENGTH)
    }
    clean[Number(number)] = texts
  }
  return { seed, index, answers: clean }
}

export function readRunningQuiz(storage = tabStorage()): RunningQuiz | null {
  if (storage === null) return null
  try {
    const text = storage.getItem(RUNNING_QUIZ_KEY)
    return text === null ? null : parseRunningQuiz(JSON.parse(text))
  } catch {
    return null
  }
}

export function keepRunningQuiz(quiz: RunningQuiz, storage = tabStorage()): void {
  try {
    storage?.setItem(RUNNING_QUIZ_KEY, JSON.stringify(quiz))
  } catch {
    // Storage is blocked or full: the quiz still works, it just cannot survive a reload.
  }
}

export function forgetRunningQuiz(storage = tabStorage()): void {
  try {
    storage?.removeItem(RUNNING_QUIZ_KEY)
  } catch {
    // Nothing was kept.
  }
}

/** "2, 7 and 11": the numbers of the questions that have no answer yet. */
export function blankQuestionNumbers(
  questions: readonly QuizQuestion[],
  answers: QuizAnswers,
): number[] {
  return questions
    .filter((question) => isBlank(answers[question.number]))
    .map((question) => question.number)
}

/** "2", "2 and 7", "2, 7 and 11". */
export function listOfNumbers(numbers: readonly number[]): string {
  return joinAnd(numbers.map(String))
}

export interface ProgressWriter {
  recordAttempt: (topic: TopicId, correct: boolean) => void
  recordQuiz: (result: QuizResult) => void
}

/** Save a finished quiz: one practice attempt per question, then the quiz result. */
export function saveQuiz(
  grade: QuizGrade,
  date: Date,
  store: ProgressWriter = { recordAttempt, recordQuiz },
): void {
  for (const { question, result } of grade.questions) {
    store.recordAttempt(question.topic, result.correct)
  }
  store.recordQuiz(quizRecord(grade, date))
}
