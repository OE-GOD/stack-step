import { history, indentLess, insertNewlineAndIndent, redo, undo } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import type { EditorView, KeyBinding } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { assembly } from './asmLanguage'
import { editorKeymap, insertSoftTab, PAGE_KEYS } from './editorKeymap'
import { INDENT, TAB_WIDTH } from './editorSetup'

/** A state like the editor's: assembly, 4-space steps, tab characters 8 columns wide. */
function stateOf(doc: string, selection: EditorSelection | { anchor: number; head?: number }) {
  return EditorState.create({
    doc,
    selection,
    extensions: [assembly(), indentUnit.of(INDENT), EditorState.tabSize.of(TAB_WIDTH), history()],
  })
}

/** Run a command and return the state after it (the same state when it did nothing). */
function run(command: StateCommand, state: EditorState): EditorState {
  let next = state
  command({ state, dispatch: (transaction) => (next = transaction.state) })
  return next
}

const keymap = editorKeymap(() => {})

/** Every key name of a binding, on every platform. */
function keyNames(binding: KeyBinding): string[] {
  return [binding.key, binding.mac, binding.win, binding.linux].filter(
    (name): name is string => name !== undefined,
  )
}

function bindingFor(name: string): KeyBinding {
  const found = keymap.find((binding) => binding.key === name)
  if (found === undefined) throw new Error(`No binding for ${name}.`)
  return found
}

describe('Tab', () => {
  it('is bound to the soft tab, and Shift-Tab to "indent less"', () => {
    const tab = bindingFor('Tab')
    expect(tab.run).toBe(insertSoftTab)
    expect(tab.shift).toBe(indentLess)
  })

  it('adds one step of 4 spaces at the start of a line', () => {
    const after = run(insertSoftTab, stateOf('mov rax, 1', { anchor: 0 }))
    expect(after.doc.toString()).toBe('    mov rax, 1')
    expect(after.selection.main.head).toBe(4)
  })

  it('adds spaces up to the next step in the middle of a line', () => {
    // After "    push" the cursor is in column 8: four spaces reach column 12.
    const push = run(insertSoftTab, stateOf('    push', { anchor: 8 }))
    expect(push.doc.toString()).toBe('    push    ')
    expect(push.selection.main.head).toBe(12)
    // After "    mov" it is in column 7: one space reaches column 8.
    const mov = run(insertSoftTab, stateOf('    mov', { anchor: 7 }))
    expect(mov.doc.toString()).toBe('    mov ')
    // In the middle of the text the rest of the line moves along.
    const middle = run(insertSoftTab, stateOf('ab', { anchor: 1 }))
    expect(middle.doc.toString()).toBe('a   b')
  })

  it('counts a tab character as 8 columns and never types one', () => {
    const after = run(insertSoftTab, stateOf('\tmov', { anchor: 4 }))
    // "\tmov" ends in column 11; one space reaches column 12.
    expect(after.doc.toString()).toBe('\tmov ')
    expect(run(insertSoftTab, stateOf('', { anchor: 0 })).doc.toString()).not.toContain('\t')
  })

  it('indents every selected line when text is selected', () => {
    const doc = 'main:\nmov rax, 1\nret\nnop'
    const state = stateOf(doc, { anchor: doc.indexOf('mov') + 1, head: doc.indexOf('ret') + 1 })
    const after = run(insertSoftTab, state)
    expect(after.doc.toString()).toBe('main:\n    mov rax, 1\n    ret\nnop')
    expect(after.selection.main.empty).toBe(false)
  })

  it('works on every cursor when there are several', () => {
    const state = EditorState.create({
      doc: 'a\nb',
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2)]),
      extensions: [
        indentUnit.of(INDENT),
        EditorState.tabSize.of(TAB_WIDTH),
        EditorState.allowMultipleSelections.of(true),
      ],
    })
    expect(run(insertSoftTab, state).doc.toString()).toBe('    a\n    b')
  })

  it('does nothing in a read-only state', () => {
    const state = EditorState.create({ doc: 'x', extensions: [EditorState.readOnly.of(true)] })
    expect(insertSoftTab({ state, dispatch: () => {} })).toBe(false)
  })
})

describe('Shift-Tab', () => {
  it('takes one step of indentation away', () => {
    expect(run(indentLess, stateOf('        ret', { anchor: 10 })).doc.toString()).toBe('    ret')
    expect(run(indentLess, stateOf('  ret', { anchor: 3 })).doc.toString()).toBe('ret')
    expect(run(indentLess, stateOf('ret', { anchor: 1 })).doc.toString()).toBe('ret')
  })

  it('turns a leading tab character into one step less, in spaces', () => {
    expect(run(indentLess, stateOf('\tret', { anchor: 2 })).doc.toString()).toBe('    ret')
  })

  it('works on every selected line', () => {
    const doc = '    mov rax, 1\n    ret'
    const after = run(indentLess, stateOf(doc, { anchor: 0, head: doc.length }))
    expect(after.doc.toString()).toBe('mov rax, 1\nret')
  })
})

describe('Enter', () => {
  const enter = bindingFor('Enter')

  it('is the standard "new line and indent" command, also with Shift', () => {
    expect(enter.run).toBe(insertNewlineAndIndent)
    expect(enter.shift).toBe(insertNewlineAndIndent)
  })

  it('keeps the indentation of the line before', () => {
    const doc = 'main:\n    push    rbp'
    const after = run(insertNewlineAndIndent, stateOf(doc, { anchor: doc.length }))
    expect(after.doc.toString()).toBe('main:\n    push    rbp\n    ')
    expect(after.selection.main.head).toBe(after.doc.length)
  })

  it('starts at the left edge after a line that starts there', () => {
    const after = run(insertNewlineAndIndent, stateOf('main:', { anchor: 5 }))
    expect(after.doc.toString()).toBe('main:\n')
  })

  it('keeps a deeper indentation too, and tab characters count as columns', () => {
    const deep = run(insertNewlineAndIndent, stateOf('        nop', { anchor: 11 }))
    expect(deep.doc.toString()).toBe('        nop\n        ')
    const tabbed = run(insertNewlineAndIndent, stateOf('\tnop', { anchor: 4 }))
    expect(tabbed.doc.toString()).toBe('\tnop\n        ')
  })
})

describe('undo and redo', () => {
  it('are bound to the standard keys', () => {
    expect(bindingFor('Mod-z').run).toBe(undo)
    expect(bindingFor('Mod-y').run).toBe(redo)
    expect(bindingFor('Mod-y').mac).toBe('Mod-Shift-z')
  })

  it('take back a Tab and bring it back', () => {
    const before = stateOf('ret', { anchor: 0 })
    const tabbed = run(insertSoftTab, before)
    const undone = run(undo, tabbed)
    expect(undone.doc.toString()).toBe('ret')
    expect(run(redo, undone).doc.toString()).toBe('    ret')
  })
})

describe("the page's keys", () => {
  const modifiers = /(^|-)(Ctrl|Control|Cmd|Meta|Mod|Alt|[acm])-/i

  it('are the only bindings on Enter with Ctrl, Cmd or Alt', () => {
    const withModifier = keymap.filter((binding) =>
      keyNames(binding).some((name) => name.endsWith('Enter') && modifiers.test(name)),
    )
    expect(withModifier).toEqual([...PAGE_KEYS])
  })

  it('cover Ctrl and Cmd, alone, with Shift and with Alt', () => {
    expect(PAGE_KEYS.map((binding) => binding.key)).toEqual([
      'Ctrl-Enter',
      'Cmd-Enter',
      'Alt-Ctrl-Enter',
      'Alt-Cmd-Enter',
    ])
    for (const binding of PAGE_KEYS) expect(binding.shift, binding.key).toBe(binding.run)
  })

  it('run no command: they only stop the browser from typing a line break', () => {
    // The commands never look at the editor, so any object will do.
    const anyView = {} as EditorView
    for (const binding of PAGE_KEYS) {
      expect(binding.run?.(anyView), binding.key).toBe(false)
      expect(binding.preventDefault, binding.key).toBe(true)
      // The event must travel on to the page.
      expect(binding.stopPropagation, binding.key).toBeUndefined()
    }
  })
})

describe('the other keys', () => {
  it('have a binding for Escape and for the breakpoint', () => {
    expect(bindingFor('Escape').run).toBeTypeOf('function')
    expect(bindingFor('Mod-b').preventDefault).toBe(true)
  })

  it('include the standard keys for moving and deleting', () => {
    for (const name of ['ArrowLeft', 'ArrowDown', 'Home', 'End', 'Backspace', 'Delete', 'Mod-a']) {
      expect(bindingFor(name).run, name).toBeTypeOf('function')
    }
  })
})
