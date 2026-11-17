import { describe, expect, it } from 'vitest'
import { TOPICS, type TopicId } from '../../content/topics'
import type { ProgressData, TopicStats } from '../../lib/progress'
import {
  hasPracticeHistory,
  QUIZ_FORM_TOPIC_COUNT,
  QUIZ_LENGTH,
  quizTopicMix,
  topicInRotation,
  WEAK_TOPIC_COUNT,
  weakMixWords,
  weakRotation,
} from './topicMix'

const ALL_TOPICS = TOPICS.map((topic) => topic.id)

function progressWith(practice: Partial<Record<TopicId, boolean[]>>): ProgressData {
  const stats: Partial<Record<TopicId, TopicStats>> = {}
  for (const [topic, recent] of Object.entries(practice) as [TopicId, boolean[]][]) {
    stats[topic] = {
      right: recent.filter(Boolean).length,
      wrong: recent.filter((item) => !item).length,
      recent,
    }
  }
  return { version: 1, lessonsDone: {}, practice: stats, quizzes: [] }
}

describe('the weak spots', () => {
  it('starts with the first topics when there is no history', () => {
    const empty = progressWith({})
    expect(hasPracticeHistory(empty)).toBe(false)
    expect(weakRotation(empty)).toEqual(ALL_TOPICS.slice(0, WEAK_TOPIC_COUNT))
  })

  it('takes the weakest topics first', () => {
    const progress = progressWith({
      'register-names': [true, true, true, true, true],
      rip: [false, false, true],
      'call-ret': [true, false],
      'mov-legality': [true, true, true, false],
    })
    expect(hasPracticeHistory(progress)).toBe(true)
    expect(weakRotation(progress)).toEqual(['rip', 'call-ret', 'mov-legality'])
  })

  it('never puts a topic with only right answers first: 2 of 2 right comes after untried topics', () => {
    // The browser review: after 2 of 2 right in "Writing part of a register", the hub called
    // it the first of the weakest topics, next to its own card saying 100%.
    const progress = progressWith({ 'subregister-writes': [true, true] })
    const rotation = weakRotation(progress)
    expect(rotation).toEqual(['register-names', 'rsp-tracker', 'rip'])
    expect(weakMixWords(progress, rotation)).toBe('topics you have not tried yet')
  })

  it('puts topics with mistakes first, then untried ones, then the least practiced right ones', () => {
    const tried = Object.fromEntries(
      ALL_TOPICS.map((topic) => [topic, [true, true, true, true, true, true]]),
    )
    const progress = progressWith({
      ...tried,
      rip: [true, false],
      'call-ret': [true],
      'mov-legality': [true, true],
    })
    const rotation = weakRotation(progress)
    expect(rotation).toEqual(['rip', 'call-ret', 'mov-legality'])
    expect(weakMixWords(progress, rotation)).toBe(
      'your topics with the lowest accuracy, then the topics you have practiced least',
    )

    const someUntried = progressWith({ rip: [false, true], 'call-ret': [true, true, true] })
    const mixed = weakRotation(someUntried)
    expect(mixed).toEqual(['rip', 'register-names', 'subregister-writes'])
    expect(weakMixWords(someUntried, mixed)).toBe(
      'your topics with the lowest accuracy, then topics you have not tried yet',
    )
    expect(weakMixWords(someUntried, [])).toBe('')
  })

  it('always has three topics: every topic has a generator', () => {
    for (const progress of [
      progressWith({}),
      progressWith({ rip: [false] }),
      progressWith(Object.fromEntries(ALL_TOPICS.map((topic) => [topic, [true]]))),
    ]) {
      expect(weakRotation(progress)).toHaveLength(WEAK_TOPIC_COUNT)
    }
  })

  it('takes turns through the rotation', () => {
    const rotation: TopicId[] = ['rip', 'call-ret', 'mov-legality']
    expect([0, 1, 2, 3, 4].map((turn) => topicInRotation(rotation, turn))).toEqual([
      'rip',
      'call-ret',
      'mov-legality',
      'rip',
      'call-ret',
    ])
    expect(topicInRotation([], 3)).toBeNull()
  })
})

describe('the quiz mix', () => {
  it('has two questions per form topic and one trace table: 15', () => {
    const mix = quizTopicMix()
    expect(mix).toHaveLength(15)
    expect(QUIZ_LENGTH).toBe(15)
    expect(QUIZ_FORM_TOPIC_COUNT).toBe(7)
    expect(QUIZ_FORM_TOPIC_COUNT * 2 + 1).toBe(QUIZ_LENGTH)
    for (const topic of ALL_TOPICS) {
      expect(mix.filter((entry) => entry === topic).length, topic).toBe(
        topic === 'homework-table' ? 1 : 2,
      )
    }
  })
})

describe('what the practice hub downloads', () => {
  // The hub shows the weak-spots mix and the quiz length. If it imported the session (or
  // anything else that builds problems), it would download every generator and the whole
  // emulator just to show its cards.
  const sources = import.meta.glob<string>(['./PracticeHubPage.tsx', './topicMix.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  })

  it('reads the files', () => {
    expect(Object.keys(sources).sort()).toEqual(['./PracticeHubPage.tsx', './topicMix.ts'])
  })

  it.each(Object.entries(sources))('%s imports no generator, session or emulator', (_, text) => {
    const imports = [...text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1])
    expect(imports.length).toBeGreaterThan(0)
    for (const path of imports) {
      expect(path).not.toMatch(/session|generators|emulator|\/check$|gen\/helpers/)
    }
  })
})
