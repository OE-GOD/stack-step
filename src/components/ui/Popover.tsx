import { useLayoutEffect, type ReactNode } from 'react'
import { Button } from './Button'
import type { ButtonSize, ButtonVariant } from './buttonStyles'
import { cx } from './cx'
import { useDisclosure } from './useDisclosure'

/** The panel keeps at least this much space (in px) between itself and the screen edge. */
const SCREEN_MARGIN = 8

export interface PopoverProps {
  /** What the button shows: text, an icon, or both. */
  button: ReactNode
  /** The name of the button for screen readers. Needed when the button shows only an icon. */
  buttonLabel?: string
  /** Default 'secondary'. */
  buttonVariant?: ButtonVariant
  /** Default 'md'. */
  buttonSize?: ButtonSize
  buttonClassName?: string
  /** A short heading at the top of the panel. It also names the panel for screen readers. */
  title?: string
  /**
   * Which edge of the button the panel lines up with: 'start' (left, the default) or
   * 'end' (right). On a narrow screen the panel is moved sideways when it would not fit.
   */
  align?: 'start' | 'end'
  /** Extra classes for the panel, for example another width (`w-96`). */
  panelClassName?: string
  /** Extra classes for the element that wraps the button and the panel. */
  className?: string
  children: ReactNode
}

/**
 * A button that shows and hides a small floating panel, for help text and extra options.
 * Escape, a click outside, or moving keyboard focus away closes it; after Escape the
 * focus goes back to the button.
 *
 * It renders a <div>, so it cannot stand inside a <p>. Do not put it inside something
 * that cuts off its content (`overflow: hidden`, a flush <Panel>): the panel would be cut.
 */
export function Popover({
  button,
  buttonLabel,
  buttonVariant,
  buttonSize,
  buttonClassName,
  title,
  align = 'start',
  panelClassName,
  className,
  children,
}: PopoverProps): ReactNode {
  const { open, buttonRef, panelRef, buttonProps, panelProps } = useDisclosure()

  // Keep the open panel on the screen: slide it sideways when it sticks out.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!open || panel === null) return

    const keepOnScreen = () => {
      panel.style.transform = ''
      const { left, right } = panel.getBoundingClientRect()
      const screenWidth = document.documentElement.clientWidth
      let shift = 0
      if (right > screenWidth - SCREEN_MARGIN) shift = screenWidth - SCREEN_MARGIN - right
      if (left + shift < SCREEN_MARGIN) shift = SCREEN_MARGIN - left
      if (shift !== 0) panel.style.transform = `translateX(${shift}px)`
    }

    keepOnScreen()
    window.addEventListener('resize', keepOnScreen)
    return () => window.removeEventListener('resize', keepOnScreen)
  }, [open, panelRef])

  return (
    <div className={cx('relative inline-block', className)}>
      <Button
        variant={buttonVariant}
        size={buttonSize}
        className={buttonClassName}
        aria-label={buttonLabel}
        ref={buttonRef}
        {...buttonProps}
      >
        {button}
      </Button>
      <div
        ref={panelRef}
        {...panelProps}
        hidden={!open}
        role="group"
        aria-label={title ?? buttonLabel}
        className={cx(
          'absolute top-full z-30 mt-2 w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-line-strong bg-surface p-4 text-left text-base font-normal text-ink shadow-lg',
          align === 'end' ? 'right-0' : 'left-0',
          panelClassName,
        )}
      >
        {title !== undefined && <p className="mb-2 font-semibold">{title}</p>}
        {children}
      </div>
    </div>
  )
}
