/**
 * The keyboard shortcuts of the stepper page.
 *
 * - Ctrl/Cmd + Enter: Step · + Shift: Back · + Alt: Run / Pause. These work everywhere,
 *   also while typing in the code editor: they are handled in the capture phase, before
 *   the editor sees the key, and the browser's default (a line break) is always prevented,
 *   even when the action cannot run right now.
 * - S (Step), B (Back), R (Run / Pause), 0 (Reset) work only when the keyboard focus is
 *   not in something that takes typing: a text field, the editor, a select, the slider.
 *   No function keys: many students use Chromebooks.
 *   The single keys can be switched off (`singleKeys: false`, a choice in the Shortcuts
 *   help): speech input and screen readers can set them off by accident (WCAG 2.1.4).
 */
import { useEffect, useEffectEvent } from 'react'

export interface StepperShortcutActions {
  step: () => void
  back: () => void
  toggleRun: () => void
  reset: () => void
  /** The single keys S, B, R and 0 work. Default true. */
  singleKeys?: boolean
}

/** True when a single letter typed here belongs to the element, not to the page. */
export function takesTyping(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLElement && target.isContentEditable) return true
  return target.closest('input, textarea, select, [contenteditable], .cm-editor') !== null
}

export function useStepperShortcuts(actions: StepperShortcutActions): void {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return

    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      // Always: otherwise the browser could type a line break into the editor.
      event.preventDefault()
      if (event.altKey) {
        if (!event.repeat) actions.toggleRun()
      } else if (event.shiftKey) {
        actions.back()
      } else {
        actions.step()
      }
      return
    }

    if (actions.singleKeys === false) return
    if (event.ctrlKey || event.metaKey || event.altKey || takesTyping(event.target)) return
    switch (event.key) {
      case 's':
      case 'S':
        event.preventDefault()
        actions.step()
        break
      case 'b':
      case 'B':
        event.preventDefault()
        actions.back()
        break
      case 'r':
      case 'R':
        event.preventDefault()
        if (!event.repeat) actions.toggleRun()
        break
      case '0':
        event.preventDefault()
        if (!event.repeat) actions.reset()
        break
    }
  })

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event)
    window.addEventListener('keydown', listener, { capture: true })
    return () => window.removeEventListener('keydown', listener, { capture: true })
  }, [])
}
