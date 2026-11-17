/**
 * The emulator's memory: sparse, byte-addressed, little-endian.
 *
 * - Sparse: only bytes that were written are stored. A byte nobody wrote is "unset":
 *   `peek` gives null for it, and a checked `read` sees 0 and says so.
 * - Little-endian: the lowest address holds the lowest byte of a number, as on x86.
 * - Memory is split into regions (code, read-only data, data, stack). An address outside
 *   every region is unmapped. Touching it is a fault (a "segmentation fault").
 *
 * This module only reports WHAT went wrong (a code and an address). The friendly words
 * for the student are built elsewhere.
 *
 * Decisions worth knowing about
 * - Addresses are unsigned 64-bit. A negative address, or one at 2^64 or above, is
 *   unmapped, even when a region claims it. Nothing wraps around.
 * - When two regions overlap, the first one in the list wins.
 * - The memory keeps the region objects it was given: `regionAt` returns one of them, and
 *   a later change to one of them takes effect at once.
 * - `load` stores bytes anywhere, but memory outside every region does not exist for the
 *   program: `peek` gives null there and `read` faults, whatever `load` put there.
 * - A width other than 1, 2, 4 or 8 bytes is a mistake in the emulator, not in the
 *   student's program, so `read` and `write` throw a plain RangeError for it.
 */
import { signedHex } from './format'
import type { MemoryChange, RuntimeCode } from './types'

export type RegionName = 'text' | 'rodata' | 'data' | 'stack'

export interface Region {
  name: RegionName
  /** First address of the region. */
  start: bigint
  /** One past the last address. */
  end: bigint
  writable: boolean
}

export type MemoryFaultCode = Extract<
  RuntimeCode,
  'bad-memory-read' | 'bad-memory-write' | 'write-read-only'
>

/** One past the highest address: addresses are 0 … 2^64-1. */
const ADDRESS_LIMIT = 1n << 64n

/** `readCString` gives up after this many bytes unless told otherwise. */
const DEFAULT_STRING_LIMIT = 4096

/** Shown in place of bytes that are not valid UTF-8. */
const REPLACEMENT_CHARACTER = '\ufffd'

export class MemoryFault extends Error {
  readonly code: MemoryFaultCode
  /** The first address that caused the fault. */
  readonly address: bigint
  /** Region the address is in (for 'write-read-only'), else null. */
  readonly region: RegionName | null

  constructor(code: MemoryFaultCode, address: bigint, region: RegionName | null = null) {
    super(`${code} at ${signedHex(address)}${region === null ? '' : ` (${region} region)`}`)
    this.name = 'MemoryFault'
    this.code = code
    this.address = address
    this.region = region
  }
}

export class Memory {
  readonly regions: readonly Region[]

  /** Address → byte (0 … 255). An address that is not a key was never written. */
  private readonly store = new Map<bigint, number>()

  constructor(regions: readonly Region[]) {
    // Its own list (the caller's array may change later), but the same region objects.
    this.regions = [...regions]
  }

  /** The region that contains `address`, or null (unmapped). */
  regionAt(address: bigint): Region | null {
    if (address < 0n || address >= ADDRESS_LIMIT) return null
    for (const region of this.regions) {
      if (address >= region.start && address < region.end) return region
    }
    return null
  }

  /** One byte; null when never written or unmapped. Never throws. */
  peek(address: bigint): number | null {
    if (this.regionAt(address) === null) return null
    return this.store.get(address) ?? null
  }

  /** `length` bytes, lowest address first; null = never written / unmapped. Never throws. */
  peekBytes(address: bigint, length: number): (number | null)[] {
    const bytes: (number | null)[] = []
    for (let i = 0; i < length; i++) bytes.push(this.peek(address + BigInt(i)))
    return bytes
  }

  /**
   * Checked little-endian read of 1, 2, 4 or 8 bytes. Bytes nobody wrote read as 0 and
   * set `uninitialized`. Throws MemoryFault('bad-memory-read') when any byte is outside
   * every region.
   */
  read(address: bigint, bytes: number): { value: bigint; uninitialized: boolean } {
    checkWidth(bytes)
    let value = 0n
    let uninitialized = false
    for (let i = 0; i < bytes; i++) {
      const at = address + BigInt(i)
      if (this.regionAt(at) === null) throw new MemoryFault('bad-memory-read', at)
      const byte = this.store.get(at)
      if (byte === undefined) uninitialized = true
      else value |= BigInt(byte) << BigInt(8 * i)
    }
    return { value, uninitialized }
  }

  /**
   * Checked little-endian write of 1, 2, 4 or 8 bytes (only the low bits of `value` are
   * used; negative values are stored as two's complement). Returns the change, for the
   * step diff and for undo. Throws MemoryFault('bad-memory-write') outside every region
   * and MemoryFault('write-read-only') in a non-writable region. When it throws, nothing
   * was written.
   */
  write(address: bigint, bytes: number, value: bigint): MemoryChange {
    checkWidth(bytes)
    // Check every byte before changing any, so a faulting write changes nothing.
    for (let i = 0; i < bytes; i++) {
      const at = address + BigInt(i)
      const region = this.regionAt(at)
      if (region === null) throw new MemoryFault('bad-memory-write', at)
      if (!region.writable) throw new MemoryFault('write-read-only', at, region.name)
    }
    const bits = BigInt.asUintN(8 * bytes, value)
    const before: (number | null)[] = []
    const after: number[] = []
    for (let i = 0; i < bytes; i++) {
      const at = address + BigInt(i)
      const byte = Number((bits >> BigInt(8 * i)) & 0xffn)
      before.push(this.store.get(at) ?? null)
      after.push(byte)
      this.store.set(at, byte)
    }
    return { address, before, after }
  }

  /**
   * Unchecked write used to load the program image and starting state (any region or none).
   * Only the low 8 bits of each number are kept. Bytes loaded outside every region are
   * stored, but nothing can see them (see the notes at the top of this file).
   */
  load(address: bigint, data: ArrayLike<number>): void {
    for (let i = 0; i < data.length; i++) {
      this.store.set(address + BigInt(i), data[i] & 0xff)
    }
  }

  /** Undo a change returned by `write`: bytes whose `before` is null become unwritten again. */
  revert(change: MemoryChange): void {
    for (let i = 0; i < change.before.length; i++) {
      const at = change.address + BigInt(i)
      const old = change.before[i]
      if (old === null) this.store.delete(at)
      else this.store.set(at, old & 0xff)
    }
  }

  /**
   * Read a 0-terminated string (UTF-8) starting at `address`, at most `limit` bytes
   * (default 4096). An unwritten byte counts as the end. Throws
   * MemoryFault('bad-memory-read') when it runs into unmapped memory before the end.
   */
  readCString(address: bigint, limit: number = DEFAULT_STRING_LIMIT): string {
    const bytes: number[] = []
    for (let i = 0; i < limit; i++) {
      const at = address + BigInt(i)
      if (this.regionAt(at) === null) throw new MemoryFault('bad-memory-read', at)
      const byte = this.store.get(at)
      if (byte === undefined || byte === 0) break
      bytes.push(byte)
    }
    return decodeUtf8(bytes)
  }

  /** Lowest and highest WRITTEN address inside a region, or null when nothing was written. */
  writtenRange(region: RegionName): { low: bigint; high: bigint } | null {
    // Programs are tiny, so looking at every stored byte is fast enough.
    let range: { low: bigint; high: bigint } | null = null
    for (const address of this.store.keys()) {
      if (this.regionAt(address)?.name !== region) continue
      if (range === null) range = { low: address, high: address }
      else if (address < range.low) range.low = address
      else if (address > range.high) range.high = address
    }
    return range
  }

  /** Forget every byte (regions stay). */
  clear(): void {
    this.store.clear()
  }
}

function checkWidth(bytes: number): void {
  if (bytes !== 1 && bytes !== 2 && bytes !== 4 && bytes !== 8) {
    throw new RangeError(`A memory access must be 1, 2, 4 or 8 bytes wide, not ${bytes}`)
  }
}

/**
 * Decode UTF-8 by hand (the emulator uses no platform text API). Bytes that are not
 * valid UTF-8 become U+FFFD, the same way a browser shows them; nothing is thrown.
 */
function decodeUtf8(bytes: readonly number[]): string {
  let text = ''
  let codePoint = 0
  /** Continuation bytes the current character still needs. */
  let needed = 0
  /** Allowed range of the next continuation byte (tighter right after some first bytes). */
  let lower = 0x80
  let upper = 0xbf

  let i = 0
  while (i < bytes.length) {
    const byte = bytes[i]

    if (needed === 0) {
      i++
      if (byte <= 0x7f) {
        text += String.fromCharCode(byte)
      } else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1
        codePoint = byte & 0x1f
      } else if (byte >= 0xe0 && byte <= 0xef) {
        needed = 2
        codePoint = byte & 0x0f
        if (byte === 0xe0) lower = 0xa0 // no over-long forms
        if (byte === 0xed) upper = 0x9f // no surrogates
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        needed = 3
        codePoint = byte & 0x07
        if (byte === 0xf0) lower = 0x90 // no over-long forms
        if (byte === 0xf4) upper = 0x8f // nothing above U+10FFFF
      } else {
        text += REPLACEMENT_CHARACTER
      }
      continue
    }

    if (byte < lower || byte > upper) {
      // The character broke off. Show one replacement, then look at this byte again as
      // the possible start of a new character (`i` does not move).
      needed = 0
      lower = 0x80
      upper = 0xbf
      text += REPLACEMENT_CHARACTER
      continue
    }

    i++
    lower = 0x80
    upper = 0xbf
    codePoint = (codePoint << 6) | (byte & 0x3f)
    needed--
    if (needed === 0) text += String.fromCodePoint(codePoint)
  }

  // The bytes ended in the middle of a character.
  if (needed !== 0) text += REPLACEMENT_CHARACTER
  return text
}
