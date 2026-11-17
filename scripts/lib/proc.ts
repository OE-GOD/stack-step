/**
 * Running other programs (compilers, debuggers, the programs we build) safely:
 * every run has a hard time limit, output is captured, and nothing is left running.
 */
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export interface RunOptions {
  /** Hard time limit in milliseconds. The program and its children are killed after it. */
  timeoutMs: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Text for the program's standard input. Default: empty (the input ends at once). */
  input?: string
  /** Stop keeping output after this many bytes per stream. Default 4 MiB. */
  maxOutputBytes?: number
}

export interface RunResult {
  /** Exit code. `null` when a signal ended the program or it never started. */
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Why the program could not be started (for example: not installed), else null. */
  spawnError: string | null
  /** True when the output was longer than `maxOutputBytes` and was cut. */
  truncated: boolean
  elapsedMs: number
}

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024

/** Programs started by `run` that have not ended yet. */
const running = new Set<number>()
/** Things to tidy up if the script is stopped half-way (temporary folders). */
const stopTasks: (() => void)[] = []
let stopHandlersInstalled = false

/**
 * Programs are started in their own process group, so Ctrl-C in the terminal does not
 * reach them. When this script is told to stop, stop them too and tidy up: nothing may
 * stay behind.
 */
function installStopHandlers(): void {
  if (stopHandlersInstalled) return
  stopHandlersInstalled = true
  const signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) {
    process.once(signal, () => {
      for (const pid of running) killTree(pid)
      for (const task of stopTasks) {
        try {
          task()
        } catch {
          // Tidying up is best effort.
        }
      }
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
}

/** Run `task` if the script is stopped by Ctrl-C or a signal. It must not wait for anything. */
export function whenStopped(task: () => void): void {
  installStopHandlers()
  stopTasks.push(task)
}

/** Run a program to the end (or to the time limit). Never throws, never hangs. */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const started = Date.now()
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
  installStopHandlers()
  return new Promise((resolve) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      spawnError: string | null,
    ) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.pid !== undefined) running.delete(child.pid)
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        spawnError,
        truncated,
        elapsedMs: Date.now() - started,
      })
    }

    // `detached` gives the program its own process group, so one signal reaches the
    // program and everything it started.
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    if (child.pid !== undefined) running.add(child.pid)

    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) killTree(child.pid)
      // Last resort: if something still holds the pipes open, stop waiting for it.
      setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(null, 'SIGKILL', null)
      }, 3000).unref()
    }, options.timeoutMs)

    child.on('error', (error) => finish(null, null, error.message))
    child.on('close', (code, signal) => finish(code, signal, null))

    child.stdout.on('data', (chunk: Buffer) => {
      if (outBytes + chunk.length > maxBytes) {
        truncated = true
        chunk = chunk.subarray(0, Math.max(0, maxBytes - outBytes))
      }
      outBytes += chunk.length
      if (chunk.length > 0) out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes + chunk.length > maxBytes) {
        truncated = true
        chunk = chunk.subarray(0, Math.max(0, maxBytes - errBytes))
      }
      errBytes += chunk.length
      if (chunk.length > 0) err.push(chunk)
    })

    // A program that exits without reading its input closes the pipe early. That is fine.
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input ?? '')
  })
}

/** Every process that was started (directly or not) by `pid`. Empty when `ps` fails. */
export function descendantsOf(pid: number): number[] {
  const listing = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 })
  if (listing.status !== 0 || typeof listing.stdout !== 'string') return []
  return descendantsFromListing(listing.stdout, pid)
}

/** Pure part of `descendantsOf`: `listing` holds one "pid ppid" pair per line. */
export function descendantsFromListing(listing: string, pid: number): number[] {
  const children = new Map<number, number[]>()
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) continue
    const child = Number(match[1])
    const parent = Number(match[2])
    const list = children.get(parent)
    if (list) list.push(child)
    else children.set(parent, [child])
  }
  const found: number[] = []
  const queue = [pid]
  const seen = new Set<number>([pid])
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

/**
 * Kill a program we started and everything below it.
 * Debuggers start helpers in their own sessions (the Rosetta debug server does), which a
 * process-group signal does not reach, so the children are listed first and killed one
 * by one.
 */
export function killTree(pid: number): void {
  const below = descendantsOf(pid)
  for (const target of [-pid, pid, ...below]) {
    try {
      process.kill(target, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/** Full path of a program on PATH, or null when it is not installed. */
export function findProgram(name: string): string | null {
  const folders = (process.env.PATH ?? '').split(path.delimiter).filter((p) => p !== '')
  for (const folder of folders) {
    const candidate = path.join(folder, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here.
    }
  }
  return null
}

/** First line of a program's `--version` output, or null when it cannot run. */
export async function versionLine(
  command: string,
  args: readonly string[],
): Promise<string | null> {
  const result = await run(command, args, { timeoutMs: 10_000 })
  if (result.spawnError !== null || result.timedOut) return null
  const text = (result.stdout + '\n' + result.stderr).trim()
  const first = text.split('\n')[0]
  return first === undefined || first === '' ? null : first.trim()
}
