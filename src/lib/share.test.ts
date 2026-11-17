import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmulatorOptions } from '../emulator'
import { EXAMPLES } from '../examples'
import {
  decodePayload,
  encodePayload,
  fitsInLink,
  MAX_ENCODED_LENGTH,
  stepperRoute,
  stepperUrl,
  type StepperPayload,
} from './share'

const EVERY_OPTION: EmulatorOptions = {
  textBase: 0x4000n,
  rodataBase: 0x5000n,
  dataBase: 0x6000n,
  stackBase: 0x1000n,
  initialRsp: 0x200n,
  osReturnAddress: 0x3ff0n,
  stackSize: 4096,
  maxSteps: 250,
  clobberCallerSaved: false,
  labelStartBox: false,
  initialRegisters: {
    rax: 0x1111222233334444n,
    rbx: 0n,
    rsp: 0x200n,
    r15: 0xffffffffffffffffn,
  },
  initialFlags: { CF: 1, ZF: 0, OF: 1 },
  initialMemory: [
    { address: 0x1f8n, bytes: 8, value: 0x7ffffffde000n, label: 'x' },
    { address: 0x1f0n, bytes: 4, value: 0xdeadbeefn },
    { address: 0x1e8n, bytes: 1, value: 0x7fn, label: 'a byte' },
    { address: 0x1e0n, bytes: 2, value: 0n },
  ],
  stdin: '41\n-7 12\n',
}

/** Encoded text for any JSON value, for tests that need a hand-made link. */
function encodeRaw(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `v1.${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('encodePayload / decodePayload', () => {
  it('round-trips a program with no options', () => {
    const payload: StepperPayload = { code: 'mov eax, 7\nret\n' }
    expect(decodePayload(encodePayload(payload))).toEqual(payload)
  })

  it('round-trips every example program exactly', () => {
    for (const example of EXAMPLES) {
      const payload: StepperPayload = { code: example.source }
      expect(decodePayload(encodePayload(payload)), example.id).toEqual(payload)
    }
  })

  it('round-trips every option field', () => {
    const payload: StepperPayload = {
      code: '    push rbx\n    pop rcx\n',
      options: EVERY_OPTION,
      note: 'This is the problem you just tried.',
    }
    expect(decodePayload(encodePayload(payload))).toEqual(payload)
  })

  it('round-trips each option on its own', () => {
    const keys = Object.keys(EVERY_OPTION) as (keyof EmulatorOptions)[]
    for (const key of keys) {
      const payload: StepperPayload = { code: 'nop\n', options: { [key]: EVERY_OPTION[key] } }
      expect(decodePayload(encodePayload(payload)), key).toEqual(payload)
    }
  })

  it('keeps text that is not ASCII', () => {
    const payload: StepperPayload = {
      code: '# día 1: número → “quotes” 你好 🙂\n    .string "é\\n"\n',
      note: 'Señal: ¿listo?',
    }
    expect(decodePayload(encodePayload(payload))).toEqual(payload)
  })

  it('keeps an empty program', () => {
    expect(decodePayload(encodePayload({ code: '' }))).toEqual({ code: '' })
  })

  it('leaves out an empty note and empty options', () => {
    const encoded = encodePayload({ code: 'ret\n', note: '', options: {} })
    expect(decodePayload(encoded)).toEqual({ code: 'ret\n' })
    expect(encoded).toBe(encodePayload({ code: 'ret\n' }))
  })

  it('stores a negative value as its 64-bit pattern', () => {
    const decoded = decodePayload(
      encodePayload({ code: 'ret\n', options: { initialRegisters: { rax: -1n } } }),
    )
    expect(decoded?.options?.initialRegisters?.rax).toBe(0xffffffffffffffffn)
  })

  it('gives the same text for the same payload', () => {
    const payload: StepperPayload = { code: 'ret\n', options: EVERY_OPTION }
    expect(encodePayload(payload)).toBe(encodePayload(payload))
  })

  it('uses only characters that are safe inside a URL', () => {
    const samples: StepperPayload[] = [
      { code: '' },
      { code: 'a' },
      { code: 'ab' },
      { code: 'abc' },
      { code: '?>>??>>~~~ÿÿÿ\u{10FFFF}' },
      { code: EXAMPLES[0].source, options: EVERY_OPTION, note: 'a note / with + signs = ?' },
    ]
    for (const sample of samples) {
      const encoded = encodePayload(sample)
      expect(encoded).toMatch(/^v1\.[A-Za-z0-9_-]*$/)
      expect(decodePayload(encoded)).toEqual(sample)
    }
  })

  it('survives a trip through URLSearchParams', () => {
    const payload: StepperPayload = { code: EXAMPLES[2].source, options: EVERY_OPTION }
    const query = new URLSearchParams(`s=${encodePayload(payload)}`)
    expect(decodePayload(query.get('s') ?? '')).toEqual(payload)
  })
})

describe('decodePayload refuses what it cannot read', () => {
  it('returns null for text that is not a link', () => {
    for (const text of ['', 'hello', 'v1', 'v1.', 'v1.!!!', 'v1.e30', 'v1.bnVsbA', '.', 'v1.W10']) {
      expect(decodePayload(text), JSON.stringify(text)).toBeNull()
    }
  })

  it('returns null for another version', () => {
    const encoded = encodePayload({ code: 'ret\n' })
    expect(decodePayload(encoded.replace(/^v1\./, 'v2.'))).toBeNull()
    expect(decodePayload(encoded.replace(/^v1\./, ''))).toBeNull()
    expect(decodePayload(encoded.replace(/^v1\./, 'V1.'))).toBeNull()
  })

  it('returns null for a link that was cut short', () => {
    const encoded = encodePayload({ code: EXAMPLES[0].source, options: EVERY_OPTION })
    for (const length of [4, 10, 25, Math.floor(encoded.length / 2), encoded.length - 3]) {
      expect(decodePayload(encoded.slice(0, length)), String(length)).toBeNull()
    }
  })

  it('returns null for characters outside base64url', () => {
    const encoded = encodePayload({ code: 'ret\n' })
    expect(decodePayload(`${encoded}=`)).toBeNull()
    expect(decodePayload(`${encoded} `)).toBeNull()
    expect(decodePayload(encoded.replace('.', '.+'))).toBeNull()
  })

  it('returns null for bytes that are not UTF-8', () => {
    // 0xff 0xfe is not valid UTF-8.
    expect(decodePayload('v1._v4')).toBeNull()
  })

  it('returns null for very long input', () => {
    expect(decodePayload(`v1.${'A'.repeat(100_001)}`)).toBeNull()
  })

  it('returns null when a field has the wrong type', () => {
    const bad: unknown[] = [
      { c: 5 },
      { n: 'no code' },
      { c: 'ret', n: 7 },
      { c: 'ret', o: 'options' },
      { c: 'ret', o: [] },
      { c: 'ret', o: { tb: 4000 } },
      { c: 'ret', o: { tb: '0x4000' } },
      { c: 'ret', o: { tb: 'xyz' } },
      { c: 'ret', o: { tb: '' } },
      { c: 'ret', o: { tb: '11112222333344445' } },
      { c: 'ret', o: { ss: -1 } },
      { c: 'ret', o: { ss: 1.5 } },
      { c: 'ret', o: { ms: '10' } },
      { c: 'ret', o: { cl: 1 } },
      { c: 'ret', o: { ls: 'no' } },
      { c: 'ret', o: { in: 41 } },
      { c: 'ret', o: { r: 'rax' } },
      { c: 'ret', o: { r: { rax: 5 } } },
      { c: 'ret', o: { r: { rax: '-1' } } },
      { c: 'ret', o: { f: { CF: 2 } } },
      { c: 'ret', o: { f: { ZF: true } } },
      { c: 'ret', o: { m: {} } },
      { c: 'ret', o: { m: [['1f8', 3, '0']] } },
      { c: 'ret', o: { m: [['1f8', 8]] } },
      { c: 'ret', o: { m: [['1f8', 8, '0', 5]] } },
      { c: 'ret', o: { m: [['1f8', 8, '0', 'x', 'extra']] } },
      { c: 'ret', o: { m: ['1f8'] } },
    ]
    for (const value of bad) {
      expect(decodePayload(encodeRaw(value)), JSON.stringify(value)).toBeNull()
    }
  })

  it('ignores fields it does not know', () => {
    const decoded = decodePayload(
      encodeRaw({ c: 'ret\n', zz: 1, o: { ms: 5, future: 'x', r: { rax: 'a', xmm0: '1' } } }),
    )
    expect(decoded).toEqual({
      code: 'ret\n',
      options: { maxSteps: 5, initialRegisters: { rax: 0xan } },
    })
  })

  it('never throws', () => {
    const inputs: unknown[] = [undefined, null, 5, {}, [], 'v1.\u0000', 'v1.%%%']
    for (const input of inputs) {
      expect(() => decodePayload(input as string)).not.toThrow()
      expect(decodePayload(input as string)).toBeNull()
    }
  })
})

describe('decodePayload keeps a crafted link within safe limits', () => {
  const optionsOf = (wire: Record<string, unknown>) =>
    decodePayload(encodeRaw({ c: 'ret\n', o: wire }))?.options

  it('cuts the number of steps of Run to 1 … 10 000', () => {
    expect(optionsOf({ ms: 9_007_199_254_740_991 })).toEqual({ maxSteps: 10_000 })
    expect(optionsOf({ ms: 300_000 })).toEqual({ maxSteps: 10_000 })
    expect(optionsOf({ ms: 10_000 })).toEqual({ maxSteps: 10_000 })
    expect(optionsOf({ ms: 250 })).toEqual({ maxSteps: 250 })
    expect(optionsOf({ ms: 0 })).toEqual({ maxSteps: 1 })
  })

  it('cuts the stack to at most 1 MiB', () => {
    expect(optionsOf({ ss: 1e12 })).toEqual({ stackSize: 0x100000 })
    expect(optionsOf({ ss: 0x100001 })).toEqual({ stackSize: 0x100000 })
    expect(optionsOf({ ss: 0x100000 })).toEqual({ stackSize: 0x100000 })
    expect(optionsOf({ ss: 4096 })).toEqual({ stackSize: 4096 })
  })

  it('a link made by encodePayload never carries more than that either, once it is read', () => {
    const decoded = decodePayload(
      encodePayload({ code: 'jmp main\n', options: { maxSteps: 2_000_000, stackSize: 1e9 } }),
    )
    expect(decoded?.options).toEqual({ maxSteps: 10_000, stackSize: 0x100000 })
  })
})

describe('fitsInLink', () => {
  it('is true for a normal program, with a starting state', () => {
    expect(fitsInLink({ code: EXAMPLES[0]?.source ?? '', options: EVERY_OPTION })).toBe(true)
  })

  it('agrees with what a page can read back, at the exact limit', () => {
    // Base64 makes 4 characters of every 3 bytes. Find the longest program that fits.
    const sized = (length: number): StepperPayload => ({ code: 'x'.repeat(length) })
    let length = Math.floor((MAX_ENCODED_LENGTH * 3) / 4) - 20
    while (fitsInLink(sized(length + 1))) length += 1
    expect(fitsInLink(sized(length))).toBe(true)
    expect(encodePayload(sized(length)).length).toBeLessThanOrEqual(MAX_ENCODED_LENGTH)
    expect(decodePayload(encodePayload(sized(length)))).toEqual(sized(length))
    expect(fitsInLink(sized(length + 1))).toBe(false)
    expect(decodePayload(encodePayload(sized(length + 1)))).toBeNull()
  })

  it('is false for a program of about 80 kB', () => {
    expect(fitsInLink({ code: 'mov eax, 1\n'.repeat(7_300) })).toBe(false)
  })
})

describe('stepperRoute / stepperUrl', () => {
  it('builds a route the router can read', () => {
    const payload: StepperPayload = { code: 'mov eax, 7\n' }
    const route = stepperRoute(payload)
    expect(route).toBe(`/stepper?s=${encodePayload(payload)}`)
    const query = new URLSearchParams(route.slice(route.indexOf('?') + 1))
    expect(decodePayload(query.get('s') ?? '')).toEqual(payload)
  })

  it('builds a hash-only link when there is no window', () => {
    const payload: StepperPayload = { code: 'ret\n' }
    expect(stepperUrl(payload)).toBe(`#/stepper?s=${encodePayload(payload)}`)
  })

  it('builds a full link from the current page address', () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://example.com', pathname: '/stack-step/', search: '' },
    })
    const payload: StepperPayload = { code: 'ret\n' }
    expect(stepperUrl(payload)).toBe(
      `https://example.com/stack-step/#/stepper?s=${encodePayload(payload)}`,
    )
  })
})
