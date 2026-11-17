/**
 * Serves the optional tutor function (`/api/tutor`) from the Vite dev server, so the
 * tutor can be tried locally with `ANTHROPIC_API_KEY=… npm run dev`. Without the
 * variable the address answers `{ "enabled": false }` and the site hides the tutor.
 *
 * This file is imported by vite.config.ts, and Vite restarts EVERY running dev server
 * when this file (or anything it imports) changes. So it is small, it knows nothing
 * about the tutor itself, and it imports no other file of this folder: the handler is
 * loaded inside each request with `ssrLoadModule`, which follows edits without a restart.
 *
 * All it does is translate: Node's request → a web `Request` → the handler → a web
 * `Response` → Node's response, piece by piece.
 *
 * Dev server only (`configureServer`). `vite preview` stays a plain static server, which
 * is how "a static host without the function" is tested.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'

/**
 * The address of the function: the same as on Vercel and on Netlify. Pages ask for
 * `api/tutor` next to themselves, so a developer page in a folder (the drawer's harness,
 * src/features/tutor/demo.html) asks `…/api/tutor`: every path that ends so is served.
 */
const ROUTE = '/api/tutor'
/** The module that exports the handler, as a path from the project root. */
const HANDLER_MODULE = '/server/tutorCore.ts'
const HANDLER_EXPORT = 'handleTutorRequest'
/**
 * A request body is kept up to this size; the rest is read and thrown away. The handler
 * has its own, much smaller limit and answers such a request itself.
 */
const MAX_BODY_BYTES = 1024 * 1024

type Handler = (request: Request, env: Record<string, string | undefined>) => Promise<Response>

/** Read the request body, but keep no more than MAX_BODY_BYTES (plus one last piece). */
function readBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const pieces: Buffer[] = []
    let size = 0
    req.on('data', (piece: Buffer) => {
      if (size > MAX_BODY_BYTES) return
      size += piece.length
      pieces.push(piece)
    })
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(pieces))))
    req.on('error', reject)
    // The browser went away in the middle of sending. (After 'end' this does nothing.)
    req.on('close', () => reject(new Error('The request was closed before its body arrived.')))
  })
}

/** Never let the API key reach the terminal, whatever an error message says. */
function withoutKey(text: string): string {
  const key = process.env.ANTHROPIC_API_KEY
  return key === undefined || key === '' ? text : text.split(key).join('[key]')
}

async function serve(server: ViteDevServer, req: IncomingMessage, res: ServerResponse) {
  const method = req.method ?? 'GET'
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)

  // Tell the handler when the browser goes away (Stop button, closed tab), so that it can
  // stop the call it is making.
  const gone = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) gone.abort()
  })

  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(':')) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  // The dev server is the first thing the browser talks to, so the address of the
  // connection is the address of the client. A header from the browser is not trusted.
  headers.set('x-forwarded-for', req.socket.remoteAddress ?? 'unknown')

  let request: Request
  try {
    const url = new URL(req.url ?? ROUTE, `http://${req.headers.host ?? 'localhost'}`)
    request = new Request(url, { method, headers, body, signal: gone.signal })
  } catch {
    // A method that a web Request cannot carry, such as TRACE.
    res.writeHead(405, { Allow: 'GET, POST' }).end()
    return
  }

  const loaded: unknown = await server.ssrLoadModule(HANDLER_MODULE)
  const handler = (loaded as Record<string, unknown>)[HANDLER_EXPORT]
  if (typeof handler !== 'function') {
    throw new Error(`${HANDLER_MODULE} does not export ${HANDLER_EXPORT}().`)
  }
  const response = await (handler as Handler)(request, process.env)

  res.statusCode = response.status
  response.headers.forEach((value, name) => res.setHeader(name, value))
  if (response.body !== null) {
    const reader = response.body.getReader()
    gone.signal.addEventListener('abort', () => void reader.cancel().catch(() => undefined))
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // Each piece goes out at once: this is what makes the reply appear as it is written.
      res.write(value)
    }
  }
  res.end()
}

export function tutorDevPlugin(): Plugin {
  return {
    name: 'stack-step-tutor-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!(req.url ?? '').split('?', 1)[0].endsWith(ROUTE)) {
          next()
          return
        }
        serve(server, req, res).catch((error: unknown) => {
          // The browser went away: nobody is left to answer, and nothing went wrong here.
          if (req.socket.destroyed) return
          if (error instanceof Error) server.ssrFixStacktrace(error)
          const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
          server.config.logger.error(withoutKey(`[tutor] ${ROUTE} failed: ${text}`))
          if (res.headersSent) {
            res.end()
            return
          }
          res.writeHead(500, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end('{"error":"tutor-dev-error"}')
        })
      })
    },
  }
}
