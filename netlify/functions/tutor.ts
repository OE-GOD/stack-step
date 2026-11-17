/**
 * The tutor function on Netlify: https://<site>/api/tutor
 *
 * A Netlify function has a default export that gets the web-standard `Request` (and a
 * `context` object with facts about the request) and returns a `Response`. The `config`
 * export puts it at /api/tutor, the same address as on Vercel and in the dev server.
 *
 * All the work is in server/tutorCore.ts. The API key is read from the environment
 * variable ANTHROPIC_API_KEY (set it in the Netlify UI; a variable in netlify.toml does
 * not reach functions). Without it the function answers `{ "enabled": false }` and the
 * site hides the tutor.
 *
 * The types come from this file, not from the `@netlify/functions` package, so the
 * project needs no extra package. The import ends in `.js` like every relative import
 * in the server-side folders (see api/tutor.ts).
 */
import { handleTutorRequest } from '../../server/tutorCore.js'

/** The one field of Netlify's `context` that is used: the address of the client. */
interface NetlifyContext {
  ip?: string
}

export default function tutor(request: Request, context?: NetlifyContext): Promise<Response> {
  return handleTutorRequest(request, process.env, { clientIp: context?.ip })
}

export const config = {
  path: '/api/tutor',
  /**
   * Netlify's own rate limit, per client address. Unlike the limiter in the function,
   * it counts across all instances of the function (each instance has its own memory,
   * and parallel requests can each get a new instance). It is available on every plan
   * (2 rules per project on the free plan). Netlify answers 429 above the limit; it can
   * take up to 10 seconds before that starts.
   *
   * GET counts too (one per page load). 60 a minute leaves room for a class of 30 that
   * shares one internet address; the function's own limits then share the room out
   * (8 a minute per browser, 60 a minute per address).
   */
  rateLimit: {
    windowLimit: 60,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
}
