// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadJSON,
  loadText,
  removeKey,
  saveJSON,
  saveText,
  storageAvailable,
  STORAGE_PREFIX,
} from './storage'

const KEY = `${STORAGE_PREFIX}test`

function blocked(): never {
  throw new DOMException('The operation is insecure.', 'SecurityError')
}

function full(): never {
  throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadJSON', () => {
  it('returns the fallback when the key is missing', () => {
    expect(loadJSON(KEY, 'fallback')).toBe('fallback')
    expect(loadJSON(KEY, null)).toBeNull()
  })

  it('returns what saveJSON stored', () => {
    const value = { name: 'rax', bits: [64, 32, 16, 8], nested: { done: true, note: null } }
    expect(saveJSON(KEY, value)).toBe(true)
    expect(loadJSON<unknown>(KEY, null)).toEqual(value)
  })

  it.each([
    ['a number', 42],
    ['zero', 0],
    ['false', false],
    ['an empty string', ''],
    ['null', null],
    ['an empty list', []],
  ])('keeps %s as it is (a stored value is never mistaken for a missing one)', (_name, value) => {
    expect(saveJSON(KEY, value)).toBe(true)
    expect(loadJSON<unknown>(KEY, 'fallback')).toEqual(value)
  })

  it.each([
    ['cut-off JSON', '{"lessonsDone":'],
    ['plain text', 'dark'],
    ['an empty string', ''],
    ['the word undefined', 'undefined'],
  ])('returns the fallback for %s', (_name, text) => {
    window.localStorage.setItem(KEY, text)
    expect(loadJSON(KEY, 'fallback')).toBe('fallback')
  })

  it('returns the fallback when getItem throws', () => {
    window.localStorage.setItem(KEY, '"stored"')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    expect(loadJSON(KEY, 'fallback')).toBe('fallback')
  })

  it('returns the fallback when reading window.localStorage itself throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(blocked)
    expect(loadJSON(KEY, 'fallback')).toBe('fallback')
  })
})

describe('saveJSON', () => {
  it('stores JSON text under the key', () => {
    expect(saveJSON(KEY, { a: 1 })).toBe(true)
    expect(window.localStorage.getItem(KEY)).toBe('{"a":1}')
  })

  it('returns false and leaves the old value when storage is full', () => {
    window.localStorage.setItem(KEY, '"old"')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(full)
    expect(saveJSON(KEY, 'new')).toBe(false)
    vi.restoreAllMocks()
    expect(window.localStorage.getItem(KEY)).toBe('"old"')
  })

  it('returns false when reading window.localStorage itself throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(blocked)
    expect(saveJSON(KEY, 'value')).toBe(false)
  })

  it('returns false and stores nothing for a value that JSON cannot hold', () => {
    const loop: { self?: unknown } = {}
    loop.self = loop
    expect(saveJSON(KEY, loop)).toBe(false)
    expect(saveJSON(KEY, { rax: 5n })).toBe(false)
    expect(saveJSON(KEY, undefined)).toBe(false)
    expect(saveJSON(KEY, () => 1)).toBe(false)
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })
})

describe('loadText and saveText', () => {
  it('store and read plain text without JSON quotes', () => {
    expect(saveText(KEY, 'dark')).toBe(true)
    expect(window.localStorage.getItem(KEY)).toBe('dark')
    expect(loadText(KEY)).toBe('dark')
  })

  it('give null for a missing key and keep an empty string', () => {
    expect(loadText(KEY)).toBeNull()
    saveText(KEY, '')
    expect(loadText(KEY)).toBe('')
  })

  it('do not throw when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    expect(loadText(KEY)).toBeNull()
    expect(saveText(KEY, 'dark')).toBe(false)
  })
})

describe('removeKey', () => {
  it('removes the key and only that key', () => {
    saveJSON(KEY, 1)
    saveJSON(`${KEY}:other`, 2)
    removeKey(KEY)
    expect(window.localStorage.getItem(KEY)).toBeNull()
    expect(loadJSON(`${KEY}:other`, 0)).toBe(2)
  })

  it('does nothing for a missing key', () => {
    expect(() => removeKey(KEY)).not.toThrow()
  })

  it('does not throw when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked)
    expect(() => removeKey(KEY)).not.toThrow()
    vi.restoreAllMocks()
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(blocked)
    expect(() => removeKey(KEY)).not.toThrow()
  })
})

describe('storageAvailable', () => {
  it('is true when storage works, and leaves nothing behind', () => {
    expect(storageAvailable()).toBe(true)
    expect(window.localStorage.length).toBe(0)
  })

  it('is false when writing throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(full)
    expect(storageAvailable()).toBe(false)
  })

  it('is false when reading window.localStorage itself throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(blocked)
    expect(storageAvailable()).toBe(false)
  })
})
