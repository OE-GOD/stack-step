/**
 * "Is the tutor turned on?", asked once per page load.
 *
 * The answer is kept in this module. Every page that mounts the tutor, and every time a
 * page is shown again, uses the same answer: one request, however often it is asked.
 *
 * This file and TutorMount.tsx are all a page downloads when there is no tutor, so it
 * stays small and imports nothing.
 */

/** The address of the tutor function: the same on Vercel, on Netlify and in the dev server. */
export const TUTOR_ENDPOINT = '/api/tutor'

/** How long the page waits for the answer. */
const TIMEOUT_MS = 8000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Ask the function if the tutor is turned on. Any problem means "no": no function on
 * this host, a page instead of JSON, a network error, a slow answer. It never throws.
 */
export async function fetchTutorEnabled(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(TUTOR_ENDPOINT, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal:
        typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
    })
    if (!response.ok) return false
    // A static host can answer every address with the site's HTML page.
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) return false
    const data: unknown = await response.json()
    return isRecord(data) && data.enabled === true
  } catch {
    return false
  }
}

/** The request that is running or finished; null before the first question. */
let asked: Promise<boolean> | null = null
/** The answer, once it is there. */
let answer: boolean | null = null

/** Ask the function (the first time) or give the answer that is already known. */
export function whenTutorEnabled(): Promise<boolean> {
  asked ??= fetchTutorEnabled().then((enabled) => {
    answer = enabled
    return enabled
  })
  return asked
}

/** True only when the function has already said that the tutor is on. */
export function isTutorKnownEnabled(): boolean {
  return answer === true
}

/** For tests: forget the answer, as a page reload does. */
export function forgetTutorAnswer(): void {
  asked = null
  answer = null
}
