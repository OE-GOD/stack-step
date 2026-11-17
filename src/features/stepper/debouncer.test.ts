import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Debouncer } from './debouncer'

describe('Debouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hands over only the newest value, after the wait', () => {
    const settle = vi.fn()
    const edits = new Debouncer<string>(300, settle)
    edits.push('a')
    vi.advanceTimersByTime(200)
    edits.push('ab')
    vi.advanceTimersByTime(299)
    expect(settle).not.toHaveBeenCalled()
    expect(edits.waiting).toBe(true)
    vi.advanceTimersByTime(1)
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith('ab')
    expect(edits.waiting).toBe(false)
  })

  it('flush hands over at once; cancel forgets', () => {
    const settle = vi.fn()
    const edits = new Debouncer<string>(300, settle)
    expect(edits.flush()).toBe(false)
    edits.push('x')
    expect(edits.flush()).toBe(true)
    expect(settle).toHaveBeenCalledWith('x')
    edits.push('y')
    edits.cancel()
    vi.advanceTimersByTime(1000)
    expect(settle).toHaveBeenCalledTimes(1)
  })
})
