/**
 * Finding out what this machine can do: build x86-64 programs, run them, debug them.
 * Every question is answered by trying it once with a time limit, never by guessing.
 */
import { rmSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { findProgram, run, versionLine, whenStopped } from '../proc'

export interface X86Compiler {
  /** Full path of the compiler. */
  command: string
  /** "clang" or "gcc": for messages. */
  name: string
  /** Arguments that select x86-64 (`-arch x86_64` on a Mac, nothing on x86-64 Linux). */
  baseArgs: string[]
  /** First line of `--version`. */
  version: string
  os: 'macos' | 'linux'
  /** True when x86-64 programs run through Rosetta 2 (an Apple Silicon Mac). */
  rosetta: boolean
}

export type CompilerSearch = { ok: true; compiler: X86Compiler } | { ok: false; reason: string }

/** What a machine must have to run real x86-64 code. Used in every "skipped" message. */
export const WHAT_IS_NEEDED =
  'gcc (and gdb, for stepping) on x86-64 Linux, or clang on a Mac that can run x86-64 programs'

const BUILD_TIMEOUT_MS = 120_000

/**
 * A fresh temporary folder for sources and built programs. Unless `keep` is true it is
 * also removed when the script is stopped half-way (Ctrl-C).
 */
export async function makeWorkDir(keep = false): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stack-step-native-'))
  if (!keep) whenStopped(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export async function removeWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

export interface BuildResult {
  ok: boolean
  /** The compiler's messages (errors and warnings), trimmed. */
  messages: string
}

/** Compile and link `sources` into `output`. */
export async function build(
  compiler: X86Compiler,
  sources: readonly string[],
  output: string,
  extraArgs: readonly string[] = [],
): Promise<BuildResult> {
  const result = await run(
    compiler.command,
    [...compiler.baseArgs, ...extraArgs, '-o', output, ...sources],
    { timeoutMs: BUILD_TIMEOUT_MS },
  )
  const messages = (result.stderr + result.stdout).trim()
  if (result.spawnError !== null) return { ok: false, messages: result.spawnError }
  if (result.timedOut) return { ok: false, messages: 'the compiler did not finish in time' }
  return { ok: result.code === 0, messages }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? ''
}

/**
 * Look for a compiler that builds x86-64 programs this machine can also run, and prove
 * it by building and running a tiny program inside `workDir`.
 */
export async function findX86Compiler(workDir: string): Promise<CompilerSearch> {
  let candidates: { name: string; baseArgs: string[] }[]
  let system: 'macos' | 'linux'
  if (process.platform === 'darwin') {
    system = 'macos'
    candidates = [{ name: 'clang', baseArgs: ['-arch', 'x86_64'] }]
  } else if (process.platform === 'linux' && process.arch === 'x64') {
    system = 'linux'
    candidates = [
      { name: 'gcc', baseArgs: [] },
      { name: 'clang', baseArgs: [] },
    ]
  } else {
    return { ok: false, reason: `this machine is ${process.platform} ${process.arch}` }
  }

  const reasons: string[] = []
  for (const candidate of candidates) {
    const command = findProgram(candidate.name)
    if (command === null) {
      const how = system === 'macos' ? ' (get it with `xcode-select --install`)' : ''
      reasons.push(`${candidate.name} is not installed${how}`)
      continue
    }
    const version = (await versionLine(command, ['--version'])) ?? candidate.name
    const compiler: X86Compiler = {
      command,
      name: candidate.name,
      baseArgs: candidate.baseArgs,
      version,
      os: system,
      rosetta: system === 'macos' && process.arch === 'arm64',
    }
    const source = path.join(workDir, 'probe.c')
    const binary = path.join(workDir, 'probe')
    await writeFile(source, '#include <stdio.h>\nint main(void) { puts("x86-64 ok"); return 0; }\n')
    const built = await build(compiler, [source], binary)
    if (!built.ok) {
      reasons.push(
        `${candidate.name} cannot build an x86-64 program here (${firstLine(built.messages)})`,
      )
      continue
    }
    const ran = await run(binary, [], { timeoutMs: 20_000 })
    if (ran.code !== 0 || !ran.stdout.includes('x86-64 ok')) {
      const why = ran.spawnError ?? firstLine(ran.stderr)
      const hint =
        system === 'macos' && process.arch === 'arm64'
          ? '; Rosetta 2 may be missing (get it with `softwareupdate --install-rosetta`)'
          : ''
      reasons.push(`an x86-64 program built by ${candidate.name} does not run here (${why})${hint}`)
      continue
    }
    return { ok: true, compiler }
  }
  return { ok: false, reason: reasons.join('; ') }
}

async function commandOutput(command: string, args: readonly string[]): Promise<string | null> {
  const result = await run(command, args, { timeoutMs: 10_000 })
  if (result.spawnError !== null || result.timedOut || result.code !== 0) return null
  const text = result.stdout.trim()
  return text === '' ? null : text
}

/**
 * One line that says where the native results came from. No host name and no user
 * name: only the CPU, the operating system and the compiler.
 */
export async function describeHost(compiler: X86Compiler): Promise<string> {
  const parts: string[] = []
  if (compiler.os === 'macos') {
    parts.push((await commandOutput('sysctl', ['-n', 'machdep.cpu.brand_string'])) ?? 'unknown CPU')
    const version = await commandOutput('sw_vers', ['-productVersion'])
    parts.push(version === null ? 'macOS' : `macOS ${version}`)
    parts.push(
      compiler.rosetta ? 'x86-64 code runs through Rosetta 2' : 'x86-64 code runs natively',
    )
  } else {
    let cpu = 'unknown CPU'
    try {
      const info = await readFile('/proc/cpuinfo', 'utf8')
      const match = /^model name\s*:\s*(.+)$/m.exec(info)
      if (match?.[1] !== undefined) cpu = match[1].trim()
    } catch {
      // Keep "unknown CPU".
    }
    parts.push(cpu, `Linux ${os.release()}`, 'x86-64 code runs natively')
  }
  parts.push(compiler.version)
  return parts.join(', ')
}

export type DebugPermission = 'yes' | 'no' | 'unknown'

/**
 * On macOS a debugger may only control another process after the user allows it.
 * This finds out, WITHOUT opening a password dialog, whether lldb can be expected to
 * work right away:
 *
 *   'yes'      developer mode is on (`DevToolsSecurity -status`), or we are root
 *   'no'       developer mode is off: lldb may stop and wait for a password that nobody
 *              is there to type
 *   'unknown'  the system tools gave no answer
 *
 * 'no' can be too careful: after someone has typed the password once, macOS remembers
 * it for some hours, and nothing reports that. `--mode lldb` tries lldb anyway.
 */
export async function macDebugPermission(): Promise<DebugPermission> {
  if (process.platform !== 'darwin') return 'unknown'
  if (typeof process.getuid === 'function' && process.getuid() === 0) return 'yes'

  let answer: DebugPermission = 'unknown'
  const devTools = findProgram('DevToolsSecurity')
  if (devTools !== null) {
    const status = await run(devTools, ['-status'], { timeoutMs: 10_000 })
    const text = status.stdout + status.stderr
    if (/currently enabled/i.test(text)) return 'yes'
    if (/currently disabled/i.test(text)) answer = 'no'
  }

  // Second opinion: ask for the debugging right. Without `-u` the request is never
  // allowed to ask the user, and `-d` gives the right back at once.
  const security = findProgram('security')
  if (security !== null) {
    const result = await run(security, ['authorize', '-d', 'system.privilege.taskport.debug'], {
      timeoutMs: 10_000,
    })
    const text = result.stdout + result.stderr
    if (result.code === 0 && /\bYES\b/.test(text)) return 'yes'
    if (/\bNO\b/.test(text)) answer = 'no'
  }
  return answer
}
