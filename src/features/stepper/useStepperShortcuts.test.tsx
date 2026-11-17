// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  takesTyping,
  useStepperShortcuts,
  type StepperShortcutActions,
} from './useStepperShortcuts'

afterEach(() => {
  cleanup()
})

function Page({ actions }: { actions: StepperShortcutActions }): ReactNode {
  useStepperShortcuts(actions)
  return (
    <div>
      <button type="button">A button</button>
      <input aria-label="A field" />
      <select aria-label="A menu">
        <option>One</option>
      </select>
      <input type="range" aria-label="A slider" />
      <div className="cm-editor">
        <div contentEditable suppressContentEditableWarning aria-label="Code" role="textbox">
          mov
        </div>
      </div>
    </div>
  )
}

function setUp() {
  const actions = { step: vi.fn(), back: vi.fn(), toggleRun: vi.fn(), reset: vi.fn() }
  const view = render(<Page actions={actions} />)
  return { actions, view }
}

describe('takesTyping', () => {
  it('knows which elements take typed letters', () => {
    const { view } = setUp()
    const get = (selector: string) => view.container.querySelector(selector)
    expect(takesTyping(get('button'))).toBe(false)
    expect(takesTyping(get('input'))).toBe(true)
    expect(takesTyping(get('select'))).toBe(true)
    expect(takesTyping(get('input[type="range"]'))).toBe(true)
    expect(takesTyping(get('[role="textbox"]'))).toBe(true)
    expect(takesTyping(null)).toBe(false)
  })
})

describe('useStepperShortcuts', () => {
  it('Ctrl/Cmd + Enter steps everywhere and always prevents the line break', () => {
    const { actions, view } = setUp()
    const editor = view.getByRole('textbox', { name: 'Code' })
    const event = fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    expect(event).toBe(false) // default prevented
    expect(actions.step).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true, shiftKey: true })
    expect(actions.back).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true, altKey: true })
    expect(actions.toggleRun).toHaveBeenCalledTimes(1)
  })

  it('single keys work outside text fields only', () => {
    const { actions, view } = setUp()
    const button = view.getByRole('button', { name: 'A button' })
    fireEvent.keyDown(button, { key: 's' })
    fireEvent.keyDown(button, { key: 'B' })
    fireEvent.keyDown(button, { key: 'r' })
    fireEvent.keyDown(button, { key: '0' })
    expect(actions.step).toHaveBeenCalledTimes(1)
    expect(actions.back).toHaveBeenCalledTimes(1)
    expect(actions.toggleRun).toHaveBeenCalledTimes(1)
    expect(actions.reset).toHaveBeenCalledTimes(1)

    for (const name of ['A field', 'A slider']) {
      fireEvent.keyDown(view.getByLabelText(name), { key: 's' })
    }
    fireEvent.keyDown(view.getByRole('textbox', { name: 'Code' }), { key: 's' })
    // Ctrl+S belongs to the browser.
    fireEvent.keyDown(button, { key: 's', ctrlKey: true })
    expect(actions.step).toHaveBeenCalledTimes(1)
  })
})

describe('switching the single keys off', () => {
  it('stops S, B, R and 0; the Ctrl/Cmd + Enter keys still work', () => {
    const actions = {
      step: vi.fn(),
      back: vi.fn(),
      toggleRun: vi.fn(),
      reset: vi.fn(),
      singleKeys: false,
    }
    const view = render(<Page actions={actions} />)
    const button = view.getByRole('button', { name: 'A button' })
    for (const key of ['s', 'b', 'r', '0']) {
      // Not prevented: the key does what it would do without the page's shortcuts.
      expect(fireEvent.keyDown(button, { key })).toBe(true)
    }
    expect(actions.step).not.toHaveBeenCalled()
    expect(actions.back).not.toHaveBeenCalled()
    expect(actions.toggleRun).not.toHaveBeenCalled()
    expect(actions.reset).not.toHaveBeenCalled()
    fireEvent.keyDown(button, { key: 'Enter', ctrlKey: true })
    expect(actions.step).toHaveBeenCalledTimes(1)
  })

  it('a held key does not start and stop Run, or reset again and again', () => {
    const { actions, view } = setUp()
    const button = view.getByRole('button', { name: 'A button' })
    fireEvent.keyDown(button, { key: 'r', repeat: true })
    fireEvent.keyDown(button, { key: '0', repeat: true })
    fireEvent.keyDown(button, { key: 'Enter', ctrlKey: true, altKey: true, repeat: true })
    expect(actions.toggleRun).not.toHaveBeenCalled()
    expect(actions.reset).not.toHaveBeenCalled()
  })
})
