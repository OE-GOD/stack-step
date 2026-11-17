/**
 * The tutor function on Vercel: https://<site>/api/tutor
 *
 * Vercel turns every file in /api into a function. A file that exports functions named
 * after HTTP methods gets the web-standard `Request` and returns a `Response`. The tutor
 * uses GET and POST. The other method names are exported as well, with the same handler,
 * so that every method gets the function's own answer (405 with `Allow: GET, POST`): the
 * Vercel docs do not say what a method without an export gets.
 *
 * All the work is in server/tutorCore.ts, which Netlify and the dev server use as well.
 * The API key is read from the environment variable ANTHROPIC_API_KEY. Without it the
 * function answers `{ "enabled": false }` and the site hides the tutor.
 *
 * The import ends in `.js` on purpose. package.json says `"type": "module"`, so the
 * compiled function is an ES module, and Node needs the full file name of every relative
 * import when it runs a file that was compiled on its own. TypeScript, Vite and Vitest
 * all read `./x.js` as `./x.ts`.
 */
import { handleTutorRequest } from '../server/tutorCore.js'

export function GET(request: Request): Promise<Response> {
  return handleTutorRequest(request, process.env)
}

export function POST(request: Request): Promise<Response> {
  return handleTutorRequest(request, process.env)
}

export { POST as PUT, POST as PATCH, POST as DELETE, POST as HEAD, POST as OPTIONS }
