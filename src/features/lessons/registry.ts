/**
 * Finds the lesson files and loads them when a lesson page needs one.
 *
 * A lesson file is `content/NN-<lessonId>.tsx` (two digits, then the id from
 * `src/content/lessonList.ts`). The files are found by their names, so adding a lesson
 * needs no change anywhere else. Each file is downloaded only when its page is opened.
 * Every lesson has a file (the content tests check this).
 *
 * Loading never throws and never rejects: a broken or undownloadable file gives a
 * `LessonLoad` that says so, and the page shows a calm message for it.
 */
import { LESSONS, type LessonId } from '../../content/lessonList'
import type { LessonContent } from './types'

interface LessonModule {
  default?: unknown
}

type Loader = () => Promise<LessonModule>

/** Every lesson file, by path ('./content/01-registers-and-memory.tsx'). */
const FILES: Record<string, Loader> = import.meta.glob<LessonModule>([
  './content/*.tsx',
  '!./content/*.test.tsx',
])

/** The parts of a lesson file name: './content/01-registers-and-memory.tsx' → 1 and the id. */
export function parseLessonFileName(path: string): { number: number; id: string } | null {
  const match = /(?:^|\/)(\d\d)-([a-z0-9-]+)\.tsx$/.exec(path)
  if (match === null) return null
  return { number: Number(match[1]), id: match[2] }
}

/** Lesson id → its file. The first file (in name order) wins if two claim the same id. */
const LOADERS = new Map<string, Loader>()
for (const path of Object.keys(FILES).sort()) {
  const parsed = parseLessonFileName(path)
  if (parsed !== null && !LOADERS.has(parsed.id)) LOADERS.set(parsed.id, FILES[path])
}

export type LessonLoad =
  /** The lesson is ready to show. */
  | { status: 'ready'; content: LessonContent }
  /** The lesson cannot be shown: it has no file, or its file does not hold this lesson. */
  | { status: 'broken'; reason: string }
  /** The file could not be downloaded, or it failed while it was loading. */
  | { status: 'failed'; error: unknown }

const KNOWN_IDS = new Set<string>(LESSONS.map((lesson) => lesson.id))

/**
 * A first check of what a lesson file exports, so the page never trips over a file with
 * a mistake in it. The content tests check everything else.
 */
export function readLessonModule(id: LessonId, file: LessonModule): LessonLoad {
  const content = file.default
  if (typeof content !== 'object' || content === null) {
    return { status: 'broken', reason: 'The file has no lesson as its default export.' }
  }
  const lesson = content as Partial<LessonContent>
  if (lesson.id !== id) {
    return { status: 'broken', reason: `The file holds the lesson "${String(lesson.id)}".` }
  }
  if (
    typeof lesson.idea !== 'string' ||
    lesson.example === undefined ||
    lesson.check === undefined
  ) {
    return { status: 'broken', reason: 'The lesson is not complete.' }
  }
  return { status: 'ready', content: content as LessonContent }
}

/** One promise per lesson, so React's `use()` sees the same promise on every render. */
const loads = new Map<LessonId, Promise<LessonLoad>>()
/** Lessons whose last load failed. */
const failures = new Set<LessonId>()

/** Load a lesson (once). The promise always resolves. */
export function loadLesson(id: LessonId): Promise<LessonLoad> {
  const known = loads.get(id)
  if (known !== undefined) return known
  const loader = KNOWN_IDS.has(id) ? LOADERS.get(id) : undefined
  const load: Promise<LessonLoad> =
    loader === undefined
      ? Promise.resolve({ status: 'broken', reason: 'There is no file for this lesson.' })
      : loader().then(
          (file) => readLessonModule(id, file),
          (error: unknown) => {
            failures.add(id)
            return { status: 'failed', error }
          },
        )
  loads.set(id, load)
  return load
}

/** Forget a lesson's load, so the next `loadLesson` asks the network again ("Try again"). */
export function forgetLesson(id: LessonId): void {
  loads.delete(id)
  failures.delete(id)
}

/** Forget the load only if it failed: call when the student opens the lesson again. */
export function forgetFailedLesson(id: LessonId): void {
  if (failures.has(id)) forgetLesson(id)
}

/** Start loading a lesson early (when the student points at a link to it). */
export function preloadLesson(id: LessonId): void {
  void loadLesson(id)
}
