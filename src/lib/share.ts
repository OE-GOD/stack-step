/**
 * Share links for the stepper.
 *
 * A link carries a whole program (and, for practice problems, the starting state of the
 * machine) inside the URL, so nothing is stored on a server:
 *
 *   https://example.com/#/stepper?s=v1.eyJjIjoi…
 *
 * The text after `s=` is 'v1.' + base64url(UTF-8 JSON). Numbers that can be bigger than
 * 2^53 (addresses, register values) travel as hex strings.
 */
import {
  DEFAULT_OPTIONS,
  FLAG_NAMES,
  REG64_NAMES,
  type EmulatorOptions,
  type Flags,
  type InitialMemoryCell,
  type Reg64,
} from '../emulator'

/** What a stepper link carries. */
export interface StepperPayload {
  code: string
  /** Starting state for practice problems (registers, rsp, memory, …). */
  options?: EmulatorOptions
  /** One short sentence shown above the editor, e.g. "This is the problem you just tried." */
  note?: string
}

const VERSION = 'v1'
/**
 * The longest encoded text (what follows `s=`) that a link may carry. A page that opens a
 * longer one refuses it, so a program that does not fit is too long to share as a link
 * (about 74 kB of code). Use `fitsInLink` to ask.
 */
export const MAX_ENCODED_LENGTH = 100_000
const MASK64 = (1n << 64n) - 1n

/**
 * The most steps `run()` may take, and the most stack a link may ask for: the emulator's
 * own defaults. A link can carry any number, but larger values would let a crafted link
 * keep the page busy for a long time, so they are cut to these.
 */
const MAX_STEPS = DEFAULT_OPTIONS.maxSteps
const MAX_STACK_SIZE = DEFAULT_OPTIONS.stackSize

/* ───────────────────────────── wire format ───────────────────────────── */

/** Short keys keep links short. Every field except `c` is optional. */
interface WirePayload {
  c: string
  n?: string
  o?: WireOptions
}

interface WireOptions {
  tb?: string
  rb?: string
  db?: string
  sb?: string
  sp?: string
  os?: string
  ss?: number
  ms?: number
  cl?: boolean
  /** labelStartBox */
  ls?: boolean
  r?: Record<string, string>
  f?: Record<string, number>
  m?: WireCell[]
  in?: string
}

/** [address, bytes, value] or [address, bytes, value, label] */
type WireCell = [string, number, string] | [string, number, string, string]

const BIGINT_FIELDS = [
  ['textBase', 'tb'],
  ['rodataBase', 'rb'],
  ['dataBase', 'db'],
  ['stackBase', 'sb'],
  ['initialRsp', 'sp'],
  ['osReturnAddress', 'os'],
] as const

function toHex(value: bigint): string {
  return (value & MASK64).toString(16)
}

function fromHex(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^[0-9a-f]{1,16}$/i.test(value)) return null
  return BigInt(`0x${value}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/* ─────────────────────────────── encode ──────────────────────────────── */

function optionsToWire(options: EmulatorOptions): WireOptions | undefined {
  const wire: WireOptions = {}
  for (const [name, key] of BIGINT_FIELDS) {
    const value = options[name]
    if (value !== undefined) wire[key] = toHex(value)
  }
  if (options.stackSize !== undefined) wire.ss = options.stackSize
  if (options.maxSteps !== undefined) wire.ms = options.maxSteps
  if (options.clobberCallerSaved !== undefined) wire.cl = options.clobberCallerSaved
  if (options.labelStartBox !== undefined) wire.ls = options.labelStartBox
  if (options.stdin !== undefined) wire.in = options.stdin

  if (options.initialRegisters) {
    const registers: Record<string, string> = {}
    for (const name of REG64_NAMES) {
      const value = options.initialRegisters[name]
      if (value !== undefined) registers[name] = toHex(value)
    }
    if (Object.keys(registers).length > 0) wire.r = registers
  }

  if (options.initialFlags) {
    const flags: Record<string, number> = {}
    for (const name of FLAG_NAMES) {
      const value = options.initialFlags[name]
      if (value !== undefined) flags[name] = value
    }
    if (Object.keys(flags).length > 0) wire.f = flags
  }

  if (options.initialMemory && options.initialMemory.length > 0) {
    wire.m = options.initialMemory.map((cell): WireCell => {
      const base: [string, number, string] = [toHex(cell.address), cell.bytes, toHex(cell.value)]
      return cell.label === undefined ? base : [...base, cell.label]
    })
  }

  return Object.keys(wire).length > 0 ? wire : undefined
}

/** UTF-8 bytes → base64url without padding (only A–Z a–z 0–9 - _). */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Text-safe form: 'v1.' + base64url(UTF-8 JSON). bigint values are stored as hex strings. */
export function encodePayload(payload: StepperPayload): string {
  const wire: WirePayload = { c: payload.code }
  if (payload.note !== undefined && payload.note !== '') wire.n = payload.note
  if (payload.options) {
    const options = optionsToWire(payload.options)
    if (options) wire.o = options
  }
  const bytes = new TextEncoder().encode(JSON.stringify(wire))
  return `${VERSION}.${bytesToBase64Url(bytes)}`
}

/* ─────────────────────────────── decode ──────────────────────────────── */

function base64UrlToBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/')
  try {
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

function cellFromWire(value: unknown): InitialMemoryCell | null {
  if (!Array.isArray(value) || value.length < 3 || value.length > 4) return null
  const [rawAddress, bytes, rawValue, label] = value as unknown[]
  const address = fromHex(rawAddress)
  const cellValue = fromHex(rawValue)
  if (address === null || cellValue === null) return null
  if (bytes !== 1 && bytes !== 2 && bytes !== 4 && bytes !== 8) return null
  if (label === undefined) return { address, bytes, value: cellValue }
  if (typeof label !== 'string') return null
  return { address, bytes, value: cellValue, label }
}

/** null = the options are damaged (the whole link is refused). */
function optionsFromWire(wire: unknown): EmulatorOptions | null {
  if (!isRecord(wire)) return null
  const options: EmulatorOptions = {}

  for (const [name, key] of BIGINT_FIELDS) {
    if (wire[key] === undefined) continue
    const value = fromHex(wire[key])
    if (value === null) return null
    options[name] = value
  }

  if (wire.ss !== undefined) {
    if (!isCount(wire.ss)) return null
    options.stackSize = Math.min(wire.ss, MAX_STACK_SIZE)
  }
  if (wire.ms !== undefined) {
    if (!isCount(wire.ms)) return null
    options.maxSteps = Math.min(Math.max(wire.ms, 1), MAX_STEPS)
  }
  if (wire.cl !== undefined) {
    if (typeof wire.cl !== 'boolean') return null
    options.clobberCallerSaved = wire.cl
  }
  if (wire.ls !== undefined) {
    if (typeof wire.ls !== 'boolean') return null
    options.labelStartBox = wire.ls
  }
  if (wire.in !== undefined) {
    if (typeof wire.in !== 'string') return null
    options.stdin = wire.in
  }

  if (wire.r !== undefined) {
    if (!isRecord(wire.r)) return null
    const registers: Partial<Record<Reg64, bigint>> = {}
    for (const name of REG64_NAMES) {
      if (wire.r[name] === undefined) continue
      const value = fromHex(wire.r[name])
      if (value === null) return null
      registers[name] = value
    }
    options.initialRegisters = registers
  }

  if (wire.f !== undefined) {
    if (!isRecord(wire.f)) return null
    const flags: Partial<Flags> = {}
    for (const name of FLAG_NAMES) {
      const value = wire.f[name]
      if (value === undefined) continue
      if (value !== 0 && value !== 1) return null
      flags[name] = value
    }
    options.initialFlags = flags
  }

  if (wire.m !== undefined) {
    if (!Array.isArray(wire.m)) return null
    const cells: InitialMemoryCell[] = []
    for (const item of wire.m as unknown[]) {
      const cell = cellFromWire(item)
      if (cell === null) return null
      cells.push(cell)
    }
    options.initialMemory = cells
  }

  return options
}

/** Reverse of encodePayload. Returns null for anything it cannot read. Never throws. */
export function decodePayload(text: string): StepperPayload | null {
  try {
    if (typeof text !== 'string' || text.length > MAX_ENCODED_LENGTH) return null
    const prefix = `${VERSION}.`
    if (!text.startsWith(prefix)) return null
    const bytes = base64UrlToBytes(text.slice(prefix.length))
    if (bytes === null) return null

    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const wire: unknown = JSON.parse(json)
    if (!isRecord(wire) || typeof wire.c !== 'string') return null

    const payload: StepperPayload = { code: wire.c }
    if (wire.n !== undefined) {
      if (typeof wire.n !== 'string') return null
      payload.note = wire.n
    }
    if (wire.o !== undefined) {
      const options = optionsFromWire(wire.o)
      if (options === null) return null
      payload.options = options
    }
    return payload
  } catch {
    return null
  }
}

/**
 * True when a link can carry this payload: a page that opens the link reads it back.
 * False for a program that is too long for a link.
 */
export function fitsInLink(payload: StepperPayload): boolean {
  return encodePayload(payload).length <= MAX_ENCODED_LENGTH
}

/* ──────────────────────────────── links ──────────────────────────────── */

/** Route for the router's <Link to>: '/stepper?s=<encoded>'. */
export function stepperRoute(payload: StepperPayload): string {
  return `/stepper?s=${encodePayload(payload)}`
}

/** Full shareable URL for the current site (origin + path + '#/stepper?s=…'). */
export function stepperUrl(payload: StepperPayload): string {
  const hash = `#${stepperRoute(payload)}`
  if (typeof window === 'undefined') return hash
  const { origin, pathname, search } = window.location
  return `${origin}${pathname}${search}${hash}`
}
