import { describe, expect, it } from 'vitest'
import { Memory, MemoryFault, type Region, type RegionName } from './memory'

/* ───────────────────────────── Test layout ───────────────────────────── */

// The layout of a small program, at the default addresses (PLAN.md, "Machine model").
const TEXT: Region = { name: 'text', start: 0x40_1126n, end: 0x40_1180n, writable: false }
const RODATA: Region = { name: 'rodata', start: 0x40_2010n, end: 0x40_2040n, writable: false }
const DATA: Region = { name: 'data', start: 0x40_4030n, end: 0x40_4070n, writable: true }
const STACK_BASE = 0x7fff_fffd_e000n
const STACK: Region = {
  name: 'stack',
  start: STACK_BASE - 0x10_0000n,
  end: STACK_BASE,
  writable: true,
}
const LAYOUT: readonly Region[] = [TEXT, RODATA, DATA, STACK]

/** rsp when a program starts: one box below the stack base. */
const RSP = STACK_BASE - 8n

// Four small regions that touch each other, to test accesses that cross a border:
//   0x1000 read-only | 0x1010 writable | 0x1020 writable | 0x1030 read-only | 0x1040 nothing
const TOUCHING: readonly Region[] = [
  { name: 'rodata', start: 0x1000n, end: 0x1010n, writable: false },
  { name: 'data', start: 0x1010n, end: 0x1020n, writable: true },
  { name: 'stack', start: 0x1020n, end: 0x1030n, writable: true },
  { name: 'text', start: 0x1030n, end: 0x1040n, writable: false },
]

const TOP = 2n ** 64n
/** A region that covers the last 256 addresses of the 64-bit address space. */
const TOP_REGION: Region = { name: 'stack', start: TOP - 0x100n, end: TOP, writable: true }

/** What `readCString` shows for bytes that are not valid UTF-8 (U+FFFD). */
const REPLACEMENT = String.fromCharCode(0xfffd)

function newMemory(regions: readonly Region[] = LAYOUT): Memory {
  return new Memory(regions)
}

/** Run `action` and return the MemoryFault it throws. The test fails if it throws anything else. */
function faultFrom(action: () => unknown): MemoryFault {
  let thrown: unknown
  try {
    action()
  } catch (error) {
    thrown = error
  }
  if (!(thrown instanceof MemoryFault)) {
    throw new Error(`Expected a MemoryFault, but got: ${String(thrown)}`)
  }
  return thrown
}

/** Hex text for test names (negative numbers keep their minus sign). */
function h(value: bigint): string {
  return value < 0n ? `-0x${(-value).toString(16)}` : `0x${value.toString(16)}`
}

/** Put a readable name in front of every row of a table, for `it.each`. */
function titled<Row extends unknown[]>(
  rows: readonly Row[],
  title: (row: Row) => string,
): [string, ...Row][] {
  return rows.map((row) => [title(row), ...row])
}

/** `count` bytes that were never written, as `peekBytes` shows them. */
function unset(count: number): null[] {
  return Array<null>(count).fill(null)
}

/** The character codes of a plain ASCII text. */
function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0))
}

const BY_NAME: [RegionName, Region][] = LAYOUT.map((region) => [region.name, region])

/* ─────────────────────────────── Regions ─────────────────────────────── */

describe('regions', () => {
  it('keeps the regions in the order given', () => {
    expect(newMemory().regions).toEqual(LAYOUT)
  })

  it('keeps the region objects it was given, so they can be compared with ===', () => {
    const memory = newMemory()
    expect(memory.regions[3]).toBe(STACK)
    expect(memory.regionAt(RSP)).toBe(STACK)
    expect(memory.regionAt(DATA.start)).toBe(DATA)
  })

  it('keeps its own list: adding to the caller’s array later does nothing', () => {
    const regions: Region[] = [DATA]
    const memory = new Memory(regions)
    regions.push(STACK)
    expect(memory.regions).toEqual([DATA])
    expect(memory.regionAt(RSP)).toBeNull()
    expect(faultFrom(() => memory.write(RSP, 8, 0n)).code).toBe('bad-memory-write')
  })

  it.each(BY_NAME)('finds the %s region from its first to its last address', (_name, region) => {
    const memory = newMemory()
    expect(memory.regionAt(region.start)).toBe(region)
    expect(memory.regionAt(region.end - 1n)).toBe(region)
    expect(memory.regionAt((region.start + region.end) / 2n)).toBe(region)
  })

  it.each(BY_NAME)('the addresses just outside the %s region are unmapped', (_name, region) => {
    const memory = newMemory()
    expect(memory.regionAt(region.start - 1n)).toBeNull()
    expect(memory.regionAt(region.end)).toBeNull()
  })

  it('does not know addresses far from every region', () => {
    const memory = newMemory()
    expect(memory.regionAt(0n)).toBeNull()
    expect(memory.regionAt(0x1000n)).toBeNull()
    expect(memory.regionAt(0x7fff_f7c2_9d90n)).toBeNull()
  })

  it('treats addresses below 0 and from 2^64 up as unmapped, whatever a region says', () => {
    const everything: Region = { name: 'data', start: -0x10n, end: TOP + 0x10n, writable: true }
    const memory = newMemory([everything])
    expect(memory.regionAt(-1n)).toBeNull()
    expect(memory.regionAt(0n)?.name).toBe('data')
    expect(memory.regionAt(TOP - 1n)?.name).toBe('data')
    expect(memory.regionAt(TOP)).toBeNull()
    expect(memory.regionAt(TOP + 1n)).toBeNull()
  })

  it('an empty region contains nothing', () => {
    const memory = newMemory([{ name: 'rodata', start: 0x2000n, end: 0x2000n, writable: false }])
    expect(memory.regionAt(0x2000n)).toBeNull()
    expect(memory.regionAt(0x1fffn)).toBeNull()
  })

  it('when two regions overlap, the first one in the list wins', () => {
    const memory = newMemory([
      { name: 'rodata', start: 0x1000n, end: 0x1010n, writable: false },
      { name: 'data', start: 0x1008n, end: 0x1020n, writable: true },
    ])
    expect(memory.regionAt(0x1007n)?.name).toBe('rodata')
    expect(memory.regionAt(0x1008n)?.name).toBe('rodata')
    expect(memory.regionAt(0x100fn)?.name).toBe('rodata')
    expect(memory.regionAt(0x1010n)?.name).toBe('data')
  })
})

/* ──────────────────────────── Little-endian ──────────────────────────── */

describe('little-endian order', () => {
  it('8 bytes: the lowest address holds the lowest byte', () => {
    const memory = newMemory()
    memory.write(RSP, 8, 0x1122_3344_5566_7788n)
    expect(memory.peek(RSP)).toBe(0x88)
    expect(memory.peek(RSP + 1n)).toBe(0x77)
    expect(memory.peek(RSP + 2n)).toBe(0x66)
    expect(memory.peek(RSP + 3n)).toBe(0x55)
    expect(memory.peek(RSP + 4n)).toBe(0x44)
    expect(memory.peek(RSP + 5n)).toBe(0x33)
    expect(memory.peek(RSP + 6n)).toBe(0x22)
    expect(memory.peek(RSP + 7n)).toBe(0x11)
  })

  it('4 bytes', () => {
    const memory = newMemory()
    memory.write(DATA.start, 4, 0x1122_3344n)
    expect(memory.peekBytes(DATA.start, 6)).toEqual([0x44, 0x33, 0x22, 0x11, null, null])
  })

  it('2 bytes', () => {
    const memory = newMemory()
    memory.write(DATA.start, 2, 0x1122n)
    expect(memory.peekBytes(DATA.start, 4)).toEqual([0x22, 0x11, null, null])
  })

  it('1 byte', () => {
    const memory = newMemory()
    memory.write(DATA.start, 1, 0xabn)
    expect(memory.peekBytes(DATA.start, 2)).toEqual([0xab, null])
  })

  it('a read puts single bytes together, lowest address = lowest byte', () => {
    const memory = newMemory()
    memory.write(DATA.start, 1, 0x78n)
    memory.write(DATA.start + 1n, 1, 0x56n)
    memory.write(DATA.start + 2n, 1, 0x34n)
    memory.write(DATA.start + 3n, 1, 0x12n)
    expect(memory.read(DATA.start, 4).value).toBe(0x1234_5678n)
    expect(memory.read(DATA.start, 2).value).toBe(0x5678n)
    expect(memory.read(DATA.start + 2n, 2).value).toBe(0x1234n)
    expect(memory.read(DATA.start + 3n, 1).value).toBe(0x12n)
  })

  it.each([
    [1, 0x88n],
    [2, 0x7788n],
    [4, 0x5566_7788n],
    [8, 0x1122_3344_5566_7788n],
  ] as [number, bigint][])('write then read gives the value back at %i byte(s)', (bytes, value) => {
    const memory = newMemory()
    memory.write(RSP, bytes, value)
    expect(memory.read(RSP, bytes)).toEqual({ value, uninitialized: false })
  })

  it('a narrow read sees one part of a wide write', () => {
    const memory = newMemory()
    memory.write(RSP, 8, 0x1122_3344_5566_7788n)
    expect(memory.read(RSP, 1).value).toBe(0x88n)
    expect(memory.read(RSP, 2).value).toBe(0x7788n)
    expect(memory.read(RSP, 4).value).toBe(0x5566_7788n)
    expect(memory.read(RSP + 4n, 4).value).toBe(0x1122_3344n)
    expect(memory.read(RSP + 7n, 1).value).toBe(0x11n)
  })
})

/* ───────────────────────── Bytes nobody wrote ────────────────────────── */

describe('bytes nobody wrote', () => {
  it.each([1, 2, 4, 8])('read as 0 and are reported, at %i byte(s)', (bytes) => {
    expect(newMemory().read(RSP, bytes)).toEqual({ value: 0n, uninitialized: true })
  })

  it('a written 0 is not the same as "never written"', () => {
    const memory = newMemory()
    memory.write(RSP, 8, 0n)
    expect(memory.read(RSP, 8)).toEqual({ value: 0n, uninitialized: false })
    expect(memory.peek(RSP)).toBe(0)
  })

  it('a read that is only partly written is reported', () => {
    const memory = newMemory()
    memory.write(DATA.start + 4n, 4, 0xdead_beefn)
    // The written bytes are the HIGH half of this read …
    expect(memory.read(DATA.start, 8)).toEqual({
      value: 0xdead_beef_0000_0000n,
      uninitialized: true,
    })
    // … and the LOW half of this one.
    expect(memory.read(DATA.start + 4n, 8)).toEqual({ value: 0xdead_beefn, uninitialized: true })
    expect(memory.read(DATA.start + 4n, 4)).toEqual({ value: 0xdead_beefn, uninitialized: false })
  })

  it('one missing byte in the middle is enough', () => {
    const memory = newMemory()
    for (let i = 0; i < 8; i++) {
      if (i !== 3) memory.write(DATA.start + BigInt(i), 1, 0xffn)
    }
    expect(memory.read(DATA.start, 8)).toEqual({
      value: 0xffff_ffff_00ff_ffffn,
      uninitialized: true,
    })
  })
})

/* ───────────────────────── Overlapping writes ────────────────────────── */

describe('overlapping writes', () => {
  it('a later write wins where the two overlap', () => {
    const memory = newMemory()
    memory.write(RSP - 8n, 8, 0x1111_1111_1111_1111n)
    memory.write(RSP - 6n, 4, 0xaabb_ccddn)
    expect(memory.peekBytes(RSP - 8n, 8)).toEqual([0x11, 0x11, 0xdd, 0xcc, 0xbb, 0xaa, 0x11, 0x11])
    expect(memory.read(RSP - 8n, 8).value).toBe(0x1111_aabb_ccdd_1111n)
  })

  it('a write that covers two older boxes halfway changes half of each', () => {
    const memory = newMemory()
    memory.write(RSP - 16n, 8, 0x1111_1111_1111_1111n)
    memory.write(RSP - 8n, 8, 0x2222_2222_2222_2222n)
    memory.write(RSP - 12n, 8, 0xffff_ffff_ffff_ffffn)
    expect(memory.read(RSP - 16n, 8).value).toBe(0xffff_ffff_1111_1111n)
    expect(memory.read(RSP - 8n, 8).value).toBe(0x2222_2222_ffff_ffffn)
  })

  it('a write does not touch its neighbours', () => {
    const memory = newMemory()
    memory.write(RSP - 8n, 8, -1n)
    expect(memory.peek(RSP - 9n)).toBeNull()
    expect(memory.peek(RSP)).toBeNull()
    memory.write(RSP - 16n, 8, 0x0102_0304_0506_0708n)
    memory.write(RSP, 8, 0x1112_1314_1516_1718n)
    memory.write(RSP - 8n, 8, 0n)
    expect(memory.read(RSP - 16n, 8).value).toBe(0x0102_0304_0506_0708n)
    expect(memory.read(RSP, 8).value).toBe(0x1112_1314_1516_1718n)
  })
})

/* ───────────────────────── peek and peekBytes ────────────────────────── */

describe('peek and peekBytes', () => {
  it('peek gives null before a write and the byte after it', () => {
    const memory = newMemory()
    expect(memory.peek(DATA.start)).toBeNull()
    memory.write(DATA.start, 1, 0x2an)
    expect(memory.peek(DATA.start)).toBe(0x2a)
  })

  it('peek never throws: unmapped addresses give null', () => {
    const memory = newMemory()
    for (const address of [0n, -1n, TOP, TOP + 5n, STACK.end, TEXT.start - 1n, 0x1234n]) {
      expect(memory.peek(address)).toBeNull()
    }
  })

  it('peekBytes lists bytes from the lowest address, with null for the gaps', () => {
    const memory = newMemory()
    memory.write(DATA.start + 2n, 2, 0xbbaan)
    expect(memory.peekBytes(DATA.start, 6)).toEqual([null, null, 0xaa, 0xbb, null, null])
  })

  it('peekBytes runs past the end of a region without throwing', () => {
    const memory = newMemory()
    memory.write(STACK.end - 2n, 2, 0x2211n)
    expect(memory.peekBytes(STACK.end - 2n, 4)).toEqual([0x11, 0x22, null, null])
    expect(memory.peekBytes(TOP - 1n, 3)).toEqual([null, null, null])
    expect(memory.peekBytes(-2n, 4)).toEqual([null, null, null, null])
  })

  it('peekBytes of length 0 (or less) is empty', () => {
    const memory = newMemory()
    expect(memory.peekBytes(RSP, 0)).toEqual([])
    expect(memory.peekBytes(RSP, -3)).toEqual([])
  })

  it('looking does not count as writing', () => {
    const memory = newMemory()
    memory.peek(RSP)
    memory.peekBytes(RSP, 8)
    memory.read(RSP, 8)
    memory.readCString(RSP)
    expect(memory.writtenRange('stack')).toBeNull()
    expect(memory.read(RSP, 8).uninitialized).toBe(true)
  })
})

/* ──────────────────────────────── write ──────────────────────────────── */

describe('write', () => {
  /** The value to write, the width in bytes, the bytes stored, and the value read back. */
  type WriteCase = [value: bigint, bytes: number, stored: number[], readBack: bigint]

  it('returns the change: the address, the old bytes and the new bytes', () => {
    const memory = newMemory()
    expect(memory.write(DATA.start, 4, 0x1234_5678n)).toEqual({
      address: DATA.start,
      before: [null, null, null, null],
      after: [0x78, 0x56, 0x34, 0x12],
    })
  })

  it('the change of a second write holds the bytes of the first', () => {
    const memory = newMemory()
    memory.write(RSP, 8, 0x1122_3344_5566_7788n)
    expect(memory.write(RSP, 8, 0x5n)).toEqual({
      address: RSP,
      before: [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11],
      after: [0x05, 0, 0, 0, 0, 0, 0, 0],
    })
  })

  it('a partly fresh write has null only for the fresh bytes', () => {
    const memory = newMemory()
    memory.write(DATA.start, 2, 0xbbaan)
    expect(memory.write(DATA.start, 4, 0n).before).toEqual([0xaa, 0xbb, null, null])
  })

  it('writing the same value again still returns a change', () => {
    const memory = newMemory()
    memory.write(DATA.start, 2, 0xbbaan)
    expect(memory.write(DATA.start, 2, 0xbbaan)).toEqual({
      address: DATA.start,
      before: [0xaa, 0xbb],
      after: [0xaa, 0xbb],
    })
  })

  const negative: WriteCase[] = [
    [-1n, 8, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0xffff_ffff_ffff_ffffn],
    [-2n, 4, [0xfe, 0xff, 0xff, 0xff], 0xffff_fffen],
    [-1n, 2, [0xff, 0xff], 0xffffn],
    [-0x1234n, 2, [0xcc, 0xed], 0xedccn],
    [-128n, 1, [0x80], 0x80n],
    [-8n, 8, [0xf8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0xffff_ffff_ffff_fff8n],
  ]

  it.each(
    titled(
      negative,
      ([value, bytes]) => `stores ${h(value)} as two’s complement in ${bytes} byte(s)`,
    ),
  )('%s', (_title, value, bytes, stored, readBack) => {
    const memory = newMemory()
    const at = RSP - 16n
    expect(memory.write(at, bytes, value).after).toEqual(stored)
    expect(memory.peekBytes(at, bytes)).toEqual(stored)
    expect(memory.read(at, bytes).value).toBe(readBack)
    // The bytes around the write were not touched.
    expect(memory.peek(at - 1n)).toBeNull()
    expect(memory.peek(at + BigInt(bytes))).toBeNull()
  })

  const tooWide: WriteCase[] = [
    [0x1ffn, 1, [0xff], 0xffn],
    [0x100n, 1, [0x00], 0x00n],
    [0x1_2345n, 2, [0x45, 0x23], 0x2345n],
    [0x1_0000_0002n, 4, [0x02, 0, 0, 0], 0x2n],
    [0x1122_3344_5566_7788n, 4, [0x88, 0x77, 0x66, 0x55], 0x5566_7788n],
    [2n ** 64n + 5n, 8, [0x05, 0, 0, 0, 0, 0, 0, 0], 0x5n],
  ]

  it.each(
    titled(tooWide, ([value, bytes]) => `keeps only the low ${bytes} byte(s) of ${h(value)}`),
  )('%s', (_title, value, bytes, stored, readBack) => {
    const memory = newMemory()
    const at = RSP - 16n
    expect(memory.write(at, bytes, value).after).toEqual(stored)
    expect(memory.read(at, bytes).value).toBe(readBack)
    // The bytes around the write were not touched.
    expect(memory.peek(at - 1n)).toBeNull()
    expect(memory.peek(at + BigInt(bytes))).toBeNull()
  })
})

/* ───────────────────────────── Permissions ───────────────────────────── */

describe('permissions', () => {
  it.each([
    ['text', TEXT],
    ['rodata', RODATA],
  ] as [RegionName, Region][])('the %s region cannot be written', (name, region) => {
    const memory = newMemory()
    const fault = faultFrom(() => memory.write(region.start + 8n, 4, 0x90n))
    expect(fault.code).toBe('write-read-only')
    expect(fault.address).toBe(region.start + 8n)
    expect(fault.region).toBe(name)
    expect(memory.peekBytes(region.start + 8n, 4)).toEqual([null, null, null, null])
  })

  it.each([
    ['data', DATA],
    ['stack', STACK],
  ] as [RegionName, Region][])('the %s region can be written', (_name, region) => {
    const memory = newMemory()
    memory.write(region.start, 8, 0x1122_3344_5566_7788n)
    memory.write(region.end - 8n, 8, 0x99n)
    expect(memory.read(region.start, 8).value).toBe(0x1122_3344_5566_7788n)
    expect(memory.read(region.end - 8n, 8).value).toBe(0x99n)
  })

  it.each(BY_NAME)('the %s region can be read', (_name, region) => {
    const memory = newMemory()
    expect(memory.read(region.start, 8)).toEqual({ value: 0n, uninitialized: true })
    expect(memory.read(region.end - 1n, 1)).toEqual({ value: 0n, uninitialized: true })
  })

  it('a failed write leaves loaded read-only bytes as they were', () => {
    const memory = newMemory()
    memory.load(RODATA.start, ascii('Hi\0'))
    expect(faultFrom(() => memory.write(RODATA.start, 1, 0x4an)).code).toBe('write-read-only')
    expect(memory.readCString(RODATA.start)).toBe('Hi')
  })
})

/* ──────────────────────── Faults at region edges ─────────────────────── */

describe('faults at the edges of a region', () => {
  it('the last byte of a region can be read and written', () => {
    const memory = newMemory()
    memory.write(STACK.end - 1n, 1, 0x7fn)
    expect(memory.read(STACK.end - 1n, 1)).toEqual({ value: 0x7fn, uninitialized: false })
  })

  it('the first byte of a region can be read and written', () => {
    const memory = newMemory()
    memory.write(DATA.start, 8, 0x0102_0304_0506_0708n)
    expect(memory.read(DATA.start, 8).value).toBe(0x0102_0304_0506_0708n)
  })

  it('an access may end exactly at the end of a region', () => {
    // This is where the return address into the "OS" lives: the 8 bytes below the stack base.
    const memory = newMemory()
    memory.write(STACK.end - 8n, 8, 0x7fff_f7c2_9d90n)
    expect(memory.read(STACK.end - 8n, 8).value).toBe(0x7fff_f7c2_9d90n)
  })

  it('one byte past the end is a fault', () => {
    const memory = newMemory()
    const readFault = faultFrom(() => memory.read(STACK.end, 1))
    expect(readFault.code).toBe('bad-memory-read')
    expect(readFault.address).toBe(STACK.end)
    expect(readFault.region).toBeNull()
    const writeFault = faultFrom(() => memory.write(STACK.end, 1, 0n))
    expect(writeFault.code).toBe('bad-memory-write')
    expect(writeFault.address).toBe(STACK.end)
    expect(writeFault.region).toBeNull()
  })

  it('an access that runs over the end faults at the first byte outside', () => {
    const memory = newMemory()
    expect(faultFrom(() => memory.read(STACK.end - 7n, 8)).address).toBe(STACK.end)
    expect(faultFrom(() => memory.read(STACK.end - 1n, 2)).address).toBe(STACK.end)
    expect(faultFrom(() => memory.write(STACK.end - 4n, 8, 0n)).address).toBe(STACK.end)
    expect(faultFrom(() => memory.write(DATA.end - 1n, 4, 0n)).address).toBe(DATA.end)
  })

  it('one byte before the start is a fault', () => {
    const memory = newMemory()
    const readFault = faultFrom(() => memory.read(DATA.start - 1n, 1))
    expect(readFault.code).toBe('bad-memory-read')
    expect(readFault.address).toBe(DATA.start - 1n)
    const writeFault = faultFrom(() => memory.write(DATA.start - 1n, 1, 0n))
    expect(writeFault.code).toBe('bad-memory-write')
    expect(writeFault.address).toBe(DATA.start - 1n)
  })

  it('an access that starts before a region faults at its own first byte', () => {
    const memory = newMemory()
    expect(faultFrom(() => memory.read(DATA.start - 4n, 8)).address).toBe(DATA.start - 4n)
    expect(faultFrom(() => memory.write(STACK.start - 1n, 8, 0n)).address).toBe(STACK.start - 1n)
  })

  it('a faulting write changes nothing', () => {
    const memory = newMemory()
    expect(() => memory.write(STACK.end - 4n, 8, -1n)).toThrow(MemoryFault)
    expect(memory.peekBytes(STACK.end - 4n, 4)).toEqual([null, null, null, null])
    expect(memory.writtenRange('stack')).toBeNull()

    // Also when something was there before.
    memory.write(STACK.end - 4n, 4, 0x1122_3344n)
    expect(() => memory.write(STACK.end - 4n, 8, -1n)).toThrow(MemoryFault)
    expect(memory.read(STACK.end - 4n, 4)).toEqual({ value: 0x1122_3344n, uninitialized: false })
  })

  it('address 0 is a fault (a null pointer)', () => {
    const memory = newMemory()
    const readFault = faultFrom(() => memory.read(0n, 8))
    expect(readFault.code).toBe('bad-memory-read')
    expect(readFault.address).toBe(0n)
    const writeFault = faultFrom(() => memory.write(0n, 4, 1n))
    expect(writeFault.code).toBe('bad-memory-write')
    expect(writeFault.address).toBe(0n)
  })

  it('a read may cross from one region into the next', () => {
    const memory = newMemory(TOUCHING)
    memory.load(0x100cn, [1, 2, 3, 4, 5, 6, 7, 8])
    expect(memory.read(0x100cn, 8)).toEqual({ value: 0x0807_0605_0403_0201n, uninitialized: false })
  })

  it('a write may cross between two writable regions', () => {
    const memory = newMemory(TOUCHING)
    memory.write(0x101cn, 8, 0x1122_3344_5566_7788n)
    expect(memory.peekBytes(0x101cn, 8)).toEqual([0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11])
    expect(memory.writtenRange('data')).toEqual({ low: 0x101cn, high: 0x101fn })
    expect(memory.writtenRange('stack')).toEqual({ low: 0x1020n, high: 0x1023n })
  })

  it('a write that runs from a writable region into a read-only one is write-read-only', () => {
    const memory = newMemory(TOUCHING)
    const fault = faultFrom(() => memory.write(0x102cn, 8, -1n))
    expect(fault.code).toBe('write-read-only')
    expect(fault.address).toBe(0x1030n)
    expect(fault.region).toBe('text')
    // The four bytes that were allowed were not written either.
    expect(memory.peekBytes(0x102cn, 8)).toEqual(unset(8))
  })

  it('a write that starts in a read-only region faults at its first byte', () => {
    const memory = newMemory(TOUCHING)
    const fault = faultFrom(() => memory.write(0x100cn, 8, -1n))
    expect(fault.code).toBe('write-read-only')
    expect(fault.address).toBe(0x100cn)
    expect(fault.region).toBe('rodata')
    expect(memory.peekBytes(0x100cn, 8)).toEqual(unset(8))
  })

  it('the first bad byte decides the kind of fault', () => {
    const memory = newMemory(TOUCHING)
    // Read-only first, then unmapped: the read-only byte is reported.
    const fromReadOnly = faultFrom(() => memory.write(0x103cn, 8, 0n))
    expect(fromReadOnly.code).toBe('write-read-only')
    expect(fromReadOnly.address).toBe(0x103cn)
    expect(fromReadOnly.region).toBe('text')
    // Unmapped first, then read-only: the unmapped byte is reported.
    const fromNowhere = faultFrom(() => memory.write(0x0ffcn, 8, 0n))
    expect(fromNowhere.code).toBe('bad-memory-write')
    expect(fromNowhere.address).toBe(0x0ffcn)
    expect(fromNowhere.region).toBeNull()
  })

  it('a read that crosses into unmapped memory is a fault on either side', () => {
    const memory = newMemory(TOUCHING)
    expect(faultFrom(() => memory.read(0x0ffcn, 8)).address).toBe(0x0ffcn)
    expect(faultFrom(() => memory.read(0x103cn, 8)).address).toBe(0x1040n)
    expect(memory.read(0x1038n, 8).uninitialized).toBe(true)
  })
})

/* ─────────────────────── Limits of the address space ─────────────────── */

describe('the limits of the address space', () => {
  it('the very last address can be used', () => {
    const memory = newMemory([TOP_REGION])
    memory.write(TOP - 1n, 1, 0xabn)
    memory.write(TOP - 9n, 8, 0x1122_3344_5566_7788n)
    expect(memory.read(TOP - 1n, 1).value).toBe(0xabn)
    expect(memory.read(TOP - 9n, 8).value).toBe(0x1122_3344_5566_7788n)
    expect(memory.read(TOP - 8n, 8).value).toBe(0xab11_2233_4455_6677n)
  })

  it('an address + length that would pass 2^64 is a fault', () => {
    const memory = newMemory([TOP_REGION])
    const readFault = faultFrom(() => memory.read(TOP - 4n, 8))
    expect(readFault.code).toBe('bad-memory-read')
    expect(readFault.address).toBe(TOP)
    const writeFault = faultFrom(() => memory.write(TOP - 1n, 2, 0xffffn))
    expect(writeFault.code).toBe('bad-memory-write')
    expect(writeFault.address).toBe(TOP)
    expect(memory.peek(TOP - 1n)).toBeNull()
  })

  it('nothing wraps around to address 0', () => {
    const low: Region = { name: 'data', start: 0n, end: 0x100n, writable: true }
    const memory = newMemory([low, TOP_REGION])
    memory.write(0n, 8, 0x1122_3344_5566_7788n)
    expect(faultFrom(() => memory.read(TOP - 4n, 8)).address).toBe(TOP)
    expect(faultFrom(() => memory.read(TOP, 1)).address).toBe(TOP)
    expect(faultFrom(() => memory.write(TOP + 8n, 8, 0n)).address).toBe(TOP + 8n)
    expect(memory.peek(TOP)).toBeNull()
    expect(memory.read(0n, 8).value).toBe(0x1122_3344_5566_7788n)
  })

  it('a negative address is a fault', () => {
    const low: Region = { name: 'data', start: 0n, end: 0x100n, writable: true }
    const memory = newMemory([low, TOP_REGION])
    const readFault = faultFrom(() => memory.read(-8n, 8))
    expect(readFault.code).toBe('bad-memory-read')
    expect(readFault.address).toBe(-8n)
    const writeFault = faultFrom(() => memory.write(-1n, 1, 0n))
    expect(writeFault.code).toBe('bad-memory-write')
    expect(writeFault.address).toBe(-1n)
    // A read that starts below 0 never reaches the mapped bytes at 0.
    expect(faultFrom(() => memory.read(-4n, 8)).address).toBe(-4n)
  })
})

/* ───────────────────────────── MemoryFault ───────────────────────────── */

describe('MemoryFault', () => {
  it('is an Error that carries a code, an address and a region', () => {
    const fault = faultFrom(() => newMemory().read(0x10n, 4))
    expect(fault).toBeInstanceOf(Error)
    expect(fault).toBeInstanceOf(MemoryFault)
    expect(fault.name).toBe('MemoryFault')
    expect(fault.code).toBe('bad-memory-read')
    expect(fault.address).toBe(0x10n)
    expect(fault.region).toBeNull()
    expect(fault.message).toBe('bad-memory-read at 0x10')
  })

  it('names the region when a write hits read-only memory', () => {
    const fault = faultFrom(() => newMemory().write(TEXT.start, 1, 0x90n))
    expect(fault.region).toBe('text')
    expect(fault.message).toBe('write-read-only at 0x401126 (text region)')
  })

  it('can be made by hand, with no region by default', () => {
    const fault = new MemoryFault('bad-memory-write', 0x7fff_fffd_e000n)
    expect(fault.code).toBe('bad-memory-write')
    expect(fault.address).toBe(0x7fff_fffd_e000n)
    expect(fault.region).toBeNull()
    expect(fault.message).toBe('bad-memory-write at 0x7ffffffde000')
    expect(new MemoryFault('write-read-only', 0x40_2010n, 'rodata').region).toBe('rodata')
  })

  it('shows an out-of-range address as it is', () => {
    expect(new MemoryFault('bad-memory-read', -8n).message).toBe('bad-memory-read at -0x8')
    expect(new MemoryFault('bad-memory-read', TOP).message).toBe(
      'bad-memory-read at 0x10000000000000000',
    )
  })
})

/* ──────────────────────────────── Widths ─────────────────────────────── */

describe('widths', () => {
  it.each([0, 3, 5, 7, 16, 32, 64, -1, 1.5, Number.NaN])(
    'a width of %s bytes is a RangeError, not a MemoryFault',
    (bytes) => {
      const memory = newMemory()
      expect(() => memory.read(RSP, bytes)).toThrow(RangeError)
      expect(() => memory.write(RSP, bytes, 0x1234n)).toThrow(RangeError)
      expect(() => memory.read(0n, bytes)).toThrow(RangeError)
      expect(memory.writtenRange('stack')).toBeNull()
    },
  )
})

/* ──────────────────────────────── revert ─────────────────────────────── */

describe('revert', () => {
  it('puts the old bytes back', () => {
    const memory = newMemory()
    memory.write(RSP, 8, 0x1122_3344_5566_7788n)
    const change = memory.write(RSP, 8, 0xdead_beefn)
    memory.revert(change)
    expect(memory.read(RSP, 8)).toEqual({ value: 0x1122_3344_5566_7788n, uninitialized: false })
  })

  it('makes fresh bytes "never written" again', () => {
    const memory = newMemory()
    const change = memory.write(RSP - 8n, 8, 0x5n)
    memory.revert(change)
    expect(memory.peekBytes(RSP - 8n, 8)).toEqual(unset(8))
    expect(memory.read(RSP - 8n, 8)).toEqual({ value: 0n, uninitialized: true })
    expect(memory.writtenRange('stack')).toBeNull()
  })

  it('handles a write that was partly fresh', () => {
    const memory = newMemory()
    memory.write(DATA.start, 2, 0xbbaan)
    const change = memory.write(DATA.start, 4, 0xffff_ffffn)
    memory.revert(change)
    expect(memory.peekBytes(DATA.start, 4)).toEqual([0xaa, 0xbb, null, null])
  })

  it('undoing a same-value write changes nothing', () => {
    const memory = newMemory()
    memory.write(DATA.start, 4, 0x1234_5678n)
    memory.revert(memory.write(DATA.start, 4, 0x1234_5678n))
    expect(memory.read(DATA.start, 4)).toEqual({ value: 0x1234_5678n, uninitialized: false })
  })

  it('undoing several writes in reverse order brings back the start', () => {
    const memory = newMemory()
    memory.write(RSP, 8, 0x7fff_f7c2_9d90n)
    const picture = () => memory.peekBytes(RSP - 24n, 32)
    const start = picture()

    // Like push, push, a 4-byte store over both, then a byte store: overlapping changes.
    const changes = [
      memory.write(RSP - 8n, 8, 0x1111_1111_1111_1111n),
      memory.write(RSP - 16n, 8, 0x2222_2222_2222_2222n),
      memory.write(RSP - 10n, 4, 0xaabb_ccddn),
      memory.write(RSP, 8, 0n),
      memory.write(RSP - 9n, 1, 0x7fn),
      memory.write(RSP - 24n, 2, -1n),
    ]
    expect(picture()).not.toEqual(start)

    for (const change of changes.reverse()) memory.revert(change)
    expect(picture()).toEqual(start)
    expect(memory.writtenRange('stack')).toEqual({ low: RSP, high: RSP + 7n })
  })
})

/* ───────────────────────────────── load ──────────────────────────────── */

describe('load', () => {
  it('ignores permissions: code and read-only data can be loaded', () => {
    const memory = newMemory()
    memory.load(TEXT.start, [0x55, 0x48, 0x89, 0xe5])
    memory.load(RODATA.start, ascii('Hi\0'))
    expect(memory.peekBytes(TEXT.start, 4)).toEqual([0x55, 0x48, 0x89, 0xe5])
    expect(memory.read(TEXT.start, 4)).toEqual({ value: 0xe589_4855n, uninitialized: false })
    expect(memory.peekBytes(RODATA.start, 3)).toEqual([0x48, 0x69, 0x00])
  })

  it('accepts typed arrays as well as plain arrays', () => {
    const memory = newMemory()
    memory.load(DATA.start, Uint8Array.of(0xde, 0xad, 0xbe, 0xef))
    expect(memory.read(DATA.start, 4).value).toBe(0xefbe_adden)
  })

  it('loaded bytes count as written', () => {
    const memory = newMemory()
    memory.load(RSP, [0x90, 0x9d, 0xc2, 0xf7, 0xff, 0x7f, 0x00, 0x00])
    expect(memory.read(RSP, 8)).toEqual({ value: 0x7fff_f7c2_9d90n, uninitialized: false })
    expect(memory.writtenRange('stack')).toEqual({ low: RSP, high: RSP + 7n })
  })

  it('replaces what was there before', () => {
    const memory = newMemory()
    memory.write(DATA.start, 4, 0x1111_1111n)
    memory.load(DATA.start + 1n, [0xaa, 0xbb])
    expect(memory.peekBytes(DATA.start, 4)).toEqual([0x11, 0xaa, 0xbb, 0x11])
  })

  it('keeps only the low 8 bits of each number', () => {
    const memory = newMemory()
    memory.load(DATA.start, [0x1ff, -1, 256, 0x7f])
    expect(memory.peekBytes(DATA.start, 4)).toEqual([0xff, 0xff, 0x00, 0x7f])
  })

  it('loading nothing changes nothing', () => {
    const memory = newMemory()
    memory.load(DATA.start, [])
    expect(memory.writtenRange('data')).toBeNull()
  })

  it('never throws outside the regions, but that memory still does not exist', () => {
    const memory = newMemory()
    expect(() => memory.load(0x10n, [1, 2, 3])).not.toThrow()
    expect(() => memory.load(STACK.end - 2n, [1, 2, 3, 4])).not.toThrow()
    expect(memory.peek(0x10n)).toBeNull()
    expect(memory.peekBytes(STACK.end - 2n, 4)).toEqual([1, 2, null, null])
    expect(faultFrom(() => memory.read(0x10n, 1)).code).toBe('bad-memory-read')
    expect(faultFrom(() => memory.readCString(0x10n)).code).toBe('bad-memory-read')
    expect(memory.writtenRange('stack')).toEqual({ low: STACK.end - 2n, high: STACK.end - 1n })
    for (const name of ['text', 'rodata', 'data'] as const) {
      expect(memory.writtenRange(name)).toBeNull()
    }
  })
})

/* ───────────────────────────── readCString ───────────────────────────── */

describe('readCString', () => {
  it('reads up to the 0 byte', () => {
    const memory = newMemory()
    memory.load(RODATA.start, ascii('Hello, world!\n\0'))
    expect(memory.readCString(RODATA.start)).toBe('Hello, world!\n')
  })

  it('reads an empty string', () => {
    const memory = newMemory()
    memory.load(RODATA.start, [0])
    expect(memory.readCString(RODATA.start)).toBe('')
  })

  it('stops at the first 0, even when more bytes follow', () => {
    const memory = newMemory()
    memory.load(RODATA.start, ascii('%d\n\0second\0'))
    expect(memory.readCString(RODATA.start)).toBe('%d\n')
    expect(memory.readCString(RODATA.start + 4n)).toBe('second')
  })

  it('can start in the middle of a string', () => {
    const memory = newMemory()
    memory.load(RODATA.start, ascii('Hello, world!\0'))
    expect(memory.readCString(RODATA.start + 7n)).toBe('world!')
  })

  it('an unwritten byte counts as the end', () => {
    const memory = newMemory()
    memory.write(RSP - 8n, 1, 0x61n)
    memory.write(RSP - 7n, 1, 0x62n)
    memory.write(RSP - 6n, 1, 0x63n)
    expect(memory.readCString(RSP - 8n)).toBe('abc')
    expect(memory.readCString(RSP - 32n)).toBe('')
  })

  it('a string that runs to the end of its region without a 0 is a fault', () => {
    const memory = newMemory()
    memory.load(RODATA.end - 4n, ascii('oops'))
    const fault = faultFrom(() => memory.readCString(RODATA.end - 4n))
    expect(fault.code).toBe('bad-memory-read')
    expect(fault.address).toBe(RODATA.end)
    expect(fault.region).toBeNull()
  })

  it('a string whose 0 is the last byte of the region is fine', () => {
    const memory = newMemory()
    memory.load(RODATA.end - 4n, ascii('end\0'))
    expect(memory.readCString(RODATA.end - 4n)).toBe('end')
  })

  it('an unmapped start address is a fault', () => {
    const memory = newMemory()
    const fault = faultFrom(() => memory.readCString(0n))
    expect(fault.code).toBe('bad-memory-read')
    expect(fault.address).toBe(0n)
    expect(faultFrom(() => memory.readCString(RODATA.end)).address).toBe(RODATA.end)
  })

  it('reads at most `limit` bytes', () => {
    const memory = newMemory()
    memory.load(RODATA.start, ascii('Hello, world!\0'))
    expect(memory.readCString(RODATA.start, 5)).toBe('Hello')
    expect(memory.readCString(RODATA.start, 1)).toBe('H')
    expect(memory.readCString(RODATA.start, 13)).toBe('Hello, world!')
    expect(memory.readCString(RODATA.start, 100)).toBe('Hello, world!')
  })

  it('a limit of 0 reads nothing, not even an unmapped byte', () => {
    const memory = newMemory()
    memory.load(RODATA.start, ascii('Hello\0'))
    expect(memory.readCString(RODATA.start, 0)).toBe('')
    expect(memory.readCString(0n, 0)).toBe('')
  })

  it('the limit can stop the read before it runs into unmapped memory', () => {
    const memory = newMemory()
    memory.load(RODATA.end - 4n, ascii('oops'))
    expect(memory.readCString(RODATA.end - 4n, 4)).toBe('oops')
    expect(faultFrom(() => memory.readCString(RODATA.end - 4n, 5)).address).toBe(RODATA.end)
  })

  it('the default limit is 4096 bytes', () => {
    const memory = newMemory()
    const long = Array<number>(5000).fill(0x61)
    memory.load(STACK.start, long)
    expect(memory.readCString(STACK.start)).toBe('a'.repeat(4096))
    expect(memory.readCString(STACK.start, 5000)).toBe('a'.repeat(5000))
  })

  it('reads across two regions that touch', () => {
    const memory = newMemory(TOUCHING)
    memory.load(0x100dn, ascii('across\0'))
    expect(memory.readCString(0x100dn)).toBe('across')
  })

  it('decodes UTF-8', () => {
    const memory = newMemory()
    // "héllo €5 😀": é is 2 bytes, € is 3 bytes, the smiley is 4 bytes.
    memory.load(
      RODATA.start,
      [
        0x68, 0xc3, 0xa9, 0x6c, 0x6c, 0x6f, 0x20, 0xe2, 0x82, 0xac, 0x35, 0x20, 0xf0, 0x9f, 0x98,
        0x80, 0x00,
      ],
    )
    expect(memory.readCString(RODATA.start)).toBe('héllo €5 😀')
    // "你好" (ni hao): two characters of 3 bytes each.
    memory.load(DATA.start, [0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd, 0x00])
    expect(memory.readCString(DATA.start)).toBe('你好')
    // "¡Hola!": the first character is 2 bytes.
    memory.load(DATA.start + 16n, [0xc2, 0xa1, 0x48, 0x6f, 0x6c, 0x61, 0x21, 0x00])
    expect(memory.readCString(DATA.start + 16n)).toBe('¡Hola!')
  })

  it.each([
    ['a byte that never appears in UTF-8', [0x41, 0xff, 0x42], `A${REPLACEMENT}B`],
    ['a continuation byte with no start', [0x41, 0x80, 0x42], `A${REPLACEMENT}B`],
    ['a 2-byte character cut off by the end', [0x41, 0xc3], `A${REPLACEMENT}`],
    ['a 3-byte character cut off by the end', [0xe2, 0x82], REPLACEMENT],
    ['a 2-byte character cut off by a letter', [0xc3, 0x41], `${REPLACEMENT}A`],
    ['a 4-byte character cut off by a letter', [0xf0, 0x9f, 0x98, 0x41], `${REPLACEMENT}A`],
    ['an over-long 2-byte form', [0xc0, 0xaf], REPLACEMENT + REPLACEMENT],
    ['an over-long 3-byte form', [0xe0, 0x80, 0xaf], REPLACEMENT.repeat(3)],
    ['an over-long 4-byte form', [0xf0, 0x80, 0x80, 0xaf], REPLACEMENT.repeat(4)],
    ['a surrogate half', [0xed, 0xa0, 0x80], REPLACEMENT + REPLACEMENT + REPLACEMENT],
    ['a code point above U+10FFFF', [0xf4, 0x90, 0x80, 0x80], REPLACEMENT.repeat(4)],
    ['a first byte above 0xf4', [0xf5, 0x80, 0x80, 0x80], REPLACEMENT.repeat(4)],
    ['good text after a bad byte', [0xff, 0xc3, 0xa9], `${REPLACEMENT}é`],
  ] as [string, number[], string][])(
    'shows the replacement character for %s',
    (_what, bytes, text) => {
      const memory = newMemory()
      memory.load(DATA.start, [...bytes, 0])
      expect(memory.readCString(DATA.start)).toBe(text)
    },
  )

  it.each([
    ['the last 1-byte character', [0x7f], 0x7f],
    ['the first 2-byte character', [0xc2, 0x80], 0x80],
    ['the last 2-byte character', [0xdf, 0xbf], 0x7ff],
    ['the first 3-byte character', [0xe0, 0xa0, 0x80], 0x800],
    ['the last character before the surrogate range', [0xed, 0x9f, 0xbf], 0xd7ff],
    ['the first character after the surrogate range', [0xee, 0x80, 0x80], 0xe000],
    ['the last 3-byte character', [0xef, 0xbf, 0xbf], 0xffff],
    ['the first 4-byte character', [0xf0, 0x90, 0x80, 0x80], 0x1_0000],
    ['the last character of all', [0xf4, 0x8f, 0xbf, 0xbf], 0x10_ffff],
  ] as [string, number[], number][])('decodes %s', (_what, bytes, codePoint) => {
    const memory = newMemory()
    memory.load(DATA.start, [...bytes, 0])
    expect(memory.readCString(DATA.start)).toBe(String.fromCodePoint(codePoint))
  })

  it('a limit that cuts a character in half gives one replacement character', () => {
    const memory = newMemory()
    memory.load(DATA.start, [0x61, 0xc3, 0xa9, 0x00])
    expect(memory.readCString(DATA.start, 2)).toBe(`a${REPLACEMENT}`)
    expect(memory.readCString(DATA.start, 3)).toBe('aé')
  })
})

/* ───────────────────────────── writtenRange ──────────────────────────── */

describe('writtenRange', () => {
  it.each(['text', 'rodata', 'data', 'stack'] as RegionName[])(
    'is null for %s when nothing was written',
    (name) => {
      expect(newMemory().writtenRange(name)).toBeNull()
    },
  )

  it('gives the lowest and the highest written address', () => {
    const memory = newMemory()
    memory.write(RSP, 8, 0x7fff_f7c2_9d90n)
    expect(memory.writtenRange('stack')).toEqual({ low: RSP, high: RSP + 7n })
    memory.write(RSP - 16n, 4, 0x5n)
    expect(memory.writtenRange('stack')).toEqual({ low: RSP - 16n, high: RSP + 7n })
    memory.write(RSP - 12n, 8, 0x5n)
    expect(memory.writtenRange('stack')).toEqual({ low: RSP - 16n, high: RSP + 7n })
  })

  it('a single byte is its own range', () => {
    const memory = newMemory()
    memory.write(DATA.start + 5n, 1, 0x41n)
    expect(memory.writtenRange('data')).toEqual({ low: DATA.start + 5n, high: DATA.start + 5n })
  })

  it('looks at one region only', () => {
    const memory = newMemory()
    memory.write(RSP, 8, 1n)
    memory.write(DATA.start, 4, 2n)
    expect(memory.writtenRange('data')).toEqual({ low: DATA.start, high: DATA.start + 3n })
    expect(memory.writtenRange('stack')).toEqual({ low: RSP, high: RSP + 7n })
    expect(memory.writtenRange('text')).toBeNull()
    expect(memory.writtenRange('rodata')).toBeNull()
  })

  it('counts loaded bytes', () => {
    const memory = newMemory()
    memory.load(RODATA.start + 2n, ascii('Hi\0'))
    expect(memory.writtenRange('rodata')).toEqual({
      low: RODATA.start + 2n,
      high: RODATA.start + 4n,
    })
  })

  it('shrinks again after a revert', () => {
    const memory = newMemory()
    memory.write(RSP, 8, 1n)
    const push = memory.write(RSP - 8n, 8, 2n)
    expect(memory.writtenRange('stack')).toEqual({ low: RSP - 8n, high: RSP + 7n })
    memory.revert(push)
    expect(memory.writtenRange('stack')).toEqual({ low: RSP, high: RSP + 7n })
  })

  it('joins regions that share a name', () => {
    const memory = newMemory([
      { name: 'data', start: 0x1000n, end: 0x1010n, writable: true },
      { name: 'stack', start: 0x2000n, end: 0x2010n, writable: true },
      { name: 'data', start: 0x3000n, end: 0x3010n, writable: true },
    ])
    memory.write(0x3008n, 4, 1n)
    expect(memory.writtenRange('data')).toEqual({ low: 0x3008n, high: 0x300bn })
    memory.write(0x1004n, 2, 1n)
    memory.write(0x2000n, 8, 1n)
    expect(memory.writtenRange('data')).toEqual({ low: 0x1004n, high: 0x300bn })
    expect(memory.writtenRange('stack')).toEqual({ low: 0x2000n, high: 0x2007n })
  })

  it('is null for a name that has no region', () => {
    const memory = newMemory([DATA])
    memory.write(DATA.start, 8, 1n)
    expect(memory.writtenRange('stack')).toBeNull()
    expect(memory.writtenRange('text')).toBeNull()
  })

  it('returns a fresh object each time', () => {
    const memory = newMemory()
    memory.write(RSP, 8, 1n)
    const first = memory.writtenRange('stack')
    if (first !== null) first.low = 0n
    expect(memory.writtenRange('stack')).toEqual({ low: RSP, high: RSP + 7n })
  })
})

/* ──────────────────────────────── clear ──────────────────────────────── */

describe('clear', () => {
  it('forgets every byte', () => {
    const memory = newMemory()
    memory.write(RSP, 8, 0x1122_3344_5566_7788n)
    memory.write(DATA.start, 4, 0x5n)
    memory.load(TEXT.start, [0x55, 0xc3])
    memory.load(RODATA.start, ascii('Hi\0'))
    memory.clear()
    expect(memory.peekBytes(RSP, 8)).toEqual(unset(8))
    expect(memory.peek(TEXT.start)).toBeNull()
    expect(memory.read(DATA.start, 4)).toEqual({ value: 0n, uninitialized: true })
    expect(memory.readCString(RODATA.start)).toBe('')
    for (const name of ['text', 'rodata', 'data', 'stack'] as const) {
      expect(memory.writtenRange(name)).toBeNull()
    }
  })

  it('keeps the regions and their permissions', () => {
    const memory = newMemory()
    memory.write(RSP, 8, 1n)
    memory.clear()
    expect(memory.regions).toEqual(LAYOUT)
    expect(memory.write(RSP, 8, 0x2an).before).toEqual(unset(8))
    expect(memory.read(RSP, 8).value).toBe(0x2an)
    expect(faultFrom(() => memory.write(TEXT.start, 1, 0n)).code).toBe('write-read-only')
    expect(faultFrom(() => memory.read(0n, 1)).code).toBe('bad-memory-read')
  })

  it('a memory that was cleared can be loaded again', () => {
    const memory = newMemory()
    memory.load(RODATA.start, ascii('first\0'))
    memory.clear()
    memory.load(RODATA.start, ascii('2nd\0'))
    expect(memory.readCString(RODATA.start)).toBe('2nd')
  })
})
