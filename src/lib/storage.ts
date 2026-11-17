/**
 * Safe access to localStorage.
 *
 * Browsers can block storage (private windows, strict cookie settings, a full disk).
 * When that happens, merely touching `window.localStorage` can throw. Nothing in this
 * file ever throws: reads give the fallback, writes report `false`, and the site keeps
 * working with whatever it holds in memory.
 *
 * Every key on this site starts with `stackstep:` (use STORAGE_PREFIX to build one).
 */

/** The start of every storage key that Stack Step uses. */
export const STORAGE_PREFIX = 'stackstep:'

function getStorage(): Storage | null {
  try {
    // The property access itself throws when storage is blocked.
    return typeof window === 'undefined' ? null : (window.localStorage ?? null)
  } catch {
    return null
  }
}

/**
 * Read a key as plain text, without JSON. Returns null when storage is blocked or the
 * key is missing. Never throws.
 */
export function loadText(key: string): string | null {
  try {
    return getStorage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

/**
 * Save plain text, without JSON. Returns false (and does nothing else) when storage is
 * blocked or full. Never throws.
 */
export function saveText(key: string, value: string): boolean {
  const storage = getStorage()
  if (storage === null) return false
  try {
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/**
 * Read and JSON-parse a key. Returns `fallback` when storage is blocked, the key is
 * missing, or the JSON is broken. Never throws.
 *
 * The stored value is NOT checked against `T`. It may come from an older version of the
 * site or may have been edited by hand, so check its shape before you trust it.
 */
export function loadJSON<T>(key: string, fallback: T): T {
  const text = loadText(key)
  if (text === null) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/**
 * JSON-stringify and save. Returns false (and does nothing else) when storage is blocked
 * or full, or when the value cannot be written as JSON (a `bigint`, a loop of objects,
 * `undefined`). Never throws.
 */
export function saveJSON(key: string, value: unknown): boolean {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    return false
  }
  // JSON.stringify(undefined) gives undefined, not a string.
  if (typeof text !== 'string') return false
  return saveText(key, text)
}

/** Remove a key. Never throws. */
export function removeKey(key: string): void {
  try {
    getStorage()?.removeItem(key)
  } catch {
    // Storage is blocked, so there is nothing to remove.
  }
}

/** True when localStorage can be used right now. */
export function storageAvailable(): boolean {
  const storage = getStorage()
  if (storage === null) return false
  const probe = `${STORAGE_PREFIX}probe`
  try {
    storage.setItem(probe, '1')
    storage.removeItem(probe)
    return true
  } catch {
    return false
  }
}
