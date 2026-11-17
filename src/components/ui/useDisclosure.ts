/**
 * The behavior of "a button that shows and hides a panel": the phone menu, the shortcut
 * help, any small pop-up. <Popover> is the ready-made version; use this hook when you need
 * your own markup.
 *
 *   const menu = useDisclosure<HTMLUListElement>()
 *   <button ref={menu.buttonRef} {...menu.buttonProps}>Menu</button>
 *   <ul ref={menu.panelRef} {...menu.panelProps} hidden={!menu.open}>…</ul>
 *
 * While the panel is open:
 * - Escape closes it and puts keyboard focus back on the button;
 * - a click or tap outside the button and the panel closes it;
 * - moving keyboard focus out of the button and the panel closes it.
 *
 * The panel element must stay in the page while it is closed (hide it with `hidden` or
 * with CSS), because the button's `aria-controls` points at it.
 *
 * "Outside" means: outside the button and outside the element that has `panelRef`. That
 * element may be a wrapper around the panel and something else that must count as inside
 * (the phone menu does this for the shield over the page; see SiteNav).
 */
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react'

export interface DisclosureOptions {
  /**
   * Close the panel when this value changes. Pass the current route path to close a menu
   * after navigation.
   */
  closeOnChangeOf?: unknown
}

export interface Disclosure<Panel extends HTMLElement> {
  open: boolean
  /** Close the panel. Keyboard focus stays where it is. */
  close: () => void
  toggle: () => void
  /** Give this to the `ref` of the <button>. */
  buttonRef: RefObject<HTMLButtonElement | null>
  /** Give this to the `ref` of the panel element (or of a wrapper around it). */
  panelRef: RefObject<Panel | null>
  /** Spread on the <button>. */
  buttonProps: {
    'aria-expanded': boolean
    'aria-controls': string
    onClick: () => void
  }
  /** Spread on the panel element. */
  panelProps: {
    id: string
  }
}

export function useDisclosure<Panel extends HTMLElement = HTMLDivElement>(
  options: DisclosureOptions = {},
): Disclosure<Panel> {
  const resetKey = options.closeOnChangeOf
  const [isOpen, setIsOpen] = useState(false)

  // Close when the watched value changes. This is React's pattern for "reset some state
  // when a prop changes": the state is corrected while rendering, React renders again at
  // once, and the page never shows the stale state. (An effect would show it for a moment.)
  const [seenKey, setSeenKey] = useState(resetKey)
  if (!Object.is(seenKey, resetKey)) {
    setSeenKey(resetKey)
    setIsOpen(false)
  }
  const open = isOpen && Object.is(seenKey, resetKey)

  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<Panel | null>(null)
  const panelId = useId()

  const close = useCallback(() => setIsOpen(false), [])
  const toggle = useCallback(() => setIsOpen((current) => !current), [])

  useEffect(() => {
    if (!open) return

    const isInside = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (buttonRef.current?.contains(target) === true || panelRef.current?.contains(target) === true)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setIsOpen(false)
      buttonRef.current?.focus()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!isInside(event.target)) setIsOpen(false)
    }
    const onFocusIn = (event: FocusEvent) => {
      if (!isInside(event.target)) setIsOpen(false)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [open])

  return {
    open,
    close,
    toggle,
    buttonRef,
    panelRef,
    buttonProps: {
      'aria-expanded': open,
      'aria-controls': panelId,
      onClick: toggle,
    },
    panelProps: { id: panelId },
  }
}
