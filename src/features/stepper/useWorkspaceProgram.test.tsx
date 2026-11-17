// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exampleById } from '../../examples'
import { encodePayload } from '../../lib/share'
import {
  CODE_STORAGE_KEY,
  EARLIER_PROGRAM,
  OWN_CODE_STORAGE_KEY,
  OWN_PROGRAM,
} from './initialProgram'
import { useWorkspaceProgram } from './useWorkspaceProgram'

const MINE = 'main:\n    mov rax, 0x77   # my homework\n    ret\n'
const LESSON = '    mov rax, 5\n    push rax\n    pop rbx\n'
const FACTORIAL = exampleById('factorial')?.source ?? ''

/** The stepper's workspace, opened from a link to `code` (as a lesson's "Open in the stepper"). */
function openLink(code: string) {
  return renderHook(() => useWorkspaceProgram({ s: encodePayload({ code }), example: null }))
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe("a link never costs the student's own program", () => {
  it('the first edit of the link program keeps the saved program aside, and it comes back', () => {
    localStorage.setItem(CODE_STORAGE_KEY, MINE)
    const { result } = openLink(LESSON)
    expect(result.current.linkProgram).toBe(true)
    // Nothing is written while the link's program is not changed.
    expect(localStorage.getItem(OWN_CODE_STORAGE_KEY)).toBeNull()
    expect(result.current.hasOtherProgram).toBe(true)

    act(() => result.current.onEdit(`${LESSON}    nop\n`))
    expect(result.current.linkProgram).toBe(false)
    expect(localStorage.getItem(OWN_CODE_STORAGE_KEY)).toBe(MINE)
    expect(result.current.keptNotice?.kind).toBe('link')
    // The edited program is saved as the last program, and the student's is still there.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(localStorage.getItem(CODE_STORAGE_KEY)).toBe(`${LESSON}    nop\n`)
    expect(result.current.hasOtherProgram).toBe(true)

    // "Your earlier program": the two change places, so neither is lost.
    act(() => result.current.chooseExample(EARLIER_PROGRAM))
    expect(result.current.code).toBe(MINE)
    expect(localStorage.getItem(OWN_CODE_STORAGE_KEY)).toBe(`${LESSON}    nop\n`)
  })

  it('the note about the kept program goes away when the student moves the machine', () => {
    localStorage.setItem(CODE_STORAGE_KEY, MINE)
    const { result } = openLink(LESSON)
    act(() => result.current.onEdit(`${LESSON}    nop\n`))
    act(() => {
      vi.advanceTimersByTime(400)
    })
    // More typing keeps it.
    act(() => result.current.onEdit(`${LESSON}    nop\n    nop\n`))
    expect(result.current.keptNotice?.kind).toBe('link')
    act(() => {
      result.current.flushEdits()
      result.current.session.step()
    })
    expect(result.current.keptNotice).toBeNull()
  })

  it('an example chosen over the unchanged link program keeps the saved program, not the link', () => {
    localStorage.setItem(CODE_STORAGE_KEY, MINE)
    const { result } = openLink(LESSON)
    act(() => result.current.chooseExample('factorial'))
    expect(result.current.code).toBe(FACTORIAL)
    expect(localStorage.getItem(OWN_CODE_STORAGE_KEY)).toBe(MINE)
    expect(result.current.keptNotice?.kind).toBe('example')
    act(() => result.current.chooseExample(OWN_PROGRAM))
    expect(result.current.code).toBe(MINE)
  })

  it('"Your own program" while the link program is unchanged brings the saved program back', () => {
    localStorage.setItem(CODE_STORAGE_KEY, MINE)
    const { result } = openLink(LESSON)
    act(() => result.current.chooseExample(OWN_PROGRAM))
    expect(result.current.code).toBe(MINE)
    expect(result.current.linkProgram).toBe(false)
    // The lesson's program was never the student's: nothing to keep.
    expect(localStorage.getItem(OWN_CODE_STORAGE_KEY)).toBeNull()
  })

  it('a link opened right after typing (the save still waiting) sees the newest program', () => {
    // The student types; the save waits a moment. A link opened in the same tab starts a
    // new workspace while the old one is still on the page.
    const typing = renderHook(() => useWorkspaceProgram({ s: null, example: null }))
    act(() => typing.result.current.onEdit(MINE))
    expect(localStorage.getItem(CODE_STORAGE_KEY)).toBeNull()
    const { result } = openLink(LESSON)
    expect(localStorage.getItem(CODE_STORAGE_KEY)).toBe(MINE)
    expect(result.current.hasOtherProgram).toBe(true)
    act(() => result.current.onEdit(`${LESSON}    nop\n`))
    expect(localStorage.getItem(OWN_CODE_STORAGE_KEY)).toBe(MINE)
    typing.unmount()
  })

  it('a link to the saved program itself, or with nothing saved, keeps nothing', () => {
    localStorage.setItem(CODE_STORAGE_KEY, MINE)
    const same = openLink(MINE)
    expect(same.result.current.linkProgram).toBe(false)
    expect(same.result.current.hasOtherProgram).toBe(false)
    same.unmount()

    localStorage.clear()
    const fresh = openLink(LESSON)
    act(() => fresh.result.current.onEdit(`${LESSON}    nop\n`))
    expect(localStorage.getItem(OWN_CODE_STORAGE_KEY)).toBeNull()
    expect(fresh.result.current.keptNotice).toBeNull()
  })
})

describe('storage that does not work', () => {
  it('says so at once when the browser blocks storage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError')
    })
    const { result } = renderHook(() => useWorkspaceProgram({ s: null, example: null }))
    expect(result.current.cannotSave).toBe(true)
  })

  it('says so when a save fails later (a full disk)', () => {
    const { result } = renderHook(() => useWorkspaceProgram({ s: null, example: null }))
    expect(result.current.cannotSave).toBe(false)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError')
    })
    act(() => result.current.onEdit(MINE))
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.cannotSave).toBe(true)
  })
})
