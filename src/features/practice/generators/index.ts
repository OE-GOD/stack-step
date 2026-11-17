/**
 * The registry of practice problem generators: topic id → generator.
 *
 * Every topic in `src/content/topics.ts` has exactly one generator here (the type
 * checker enforces it). Pages ask for problems through `makeProblem`.
 */
import type { TopicId } from '../../../content/topics'
import type { Problem, ProblemGenerator } from '../types'
import { generate as callRet } from './call-ret'
import { generate as homeworkTable } from './homework-table'
import { generate as indirectAddressing } from './indirect-addressing'
import { generate as movLegality } from './mov-legality'
import { generate as registerNames } from './register-names'
import { generate as rip } from './rip'
import { generate as rspTracker } from './rsp-tracker'
import { generate as subregisterWrites } from './subregister-writes'

export const GENERATORS: Readonly<Record<TopicId, ProblemGenerator>> = {
  'register-names': registerNames,
  'subregister-writes': subregisterWrites,
  'rsp-tracker': rspTracker,
  rip,
  'call-ret': callRet,
  'indirect-addressing': indirectAddressing,
  'mov-legality': movLegality,
  'homework-table': homeworkTable,
}

/** Seeds are whole numbers from 0 to 2^32 − 1. Anything else is folded into that range. */
export function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 0
  return Math.abs(Math.trunc(seed)) % 2 ** 32
}

/**
 * Build the problem of a topic for a seed. The same topic and seed always give the same
 * problem. Throws only when the generator has a bug (the pages load problems through
 * `loadProblem` in session.ts, which never throws).
 */
export function makeProblem(topic: TopicId, seed: number): Problem {
  return GENERATORS[topic](normalizeSeed(seed))
}
