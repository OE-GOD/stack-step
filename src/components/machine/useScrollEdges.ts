import { useCallback, useEffect, useState, type CSSProperties, type RefObject } from 'react'

export interface ScrollEdges {
  /** Some content is hidden above (the box was scrolled down). */
  above: boolean
  /** Some content is hidden below. */
  below: boolean
  /** Some content is hidden at the right (a long line of code). */
  right: boolean
  /** Some content is hidden at the left (the box was scrolled sideways). */
  left: boolean
}

const NONE: ScrollEdges = { above: false, below: false, right: false, left: false }

/**
 * Hidden content smaller than this (in px) does not count: a margin or a rounded size can
 * stick out by a pixel or two, and a fade over the last line for that would hide text.
 */
const SLACK = 4

function sameEdges(a: ScrollEdges, b: ScrollEdges): boolean {
  return a.above === b.above && a.below === b.below && a.right === b.right && a.left === b.left
}

/**
 * Which edges of a scrolling box hide content, so the box can fade there and show that
 * there is more to see. It follows scrolling and changes of the box's size. When the
 * content can change while the box keeps its size, pass a `key` that changes with it (the
 * snapshot version), or `contentRef`: an element around the content, whose size is
 * followed too.
 */
export function useScrollEdges(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
  key?: unknown,
  contentRef?: RefObject<HTMLElement | null>,
): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>(NONE)

  const measure = useCallback(() => {
    const box = ref.current
    if (box === null) return
    const next = {
      above: box.scrollTop > SLACK,
      below: box.scrollTop + box.clientHeight < box.scrollHeight - SLACK,
      left: box.scrollLeft > SLACK,
      right: box.scrollLeft + box.clientWidth < box.scrollWidth - SLACK,
    }
    setEdges((old) => (sameEdges(old, next) ? old : next))
  }, [ref])

  useEffect(() => {
    const box = ref.current
    if (box === null || !enabled || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    const content = contentRef?.current ?? null
    if (content !== null) observer.observe(content)
    box.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      box.removeEventListener('scroll', measure)
    }
  }, [ref, contentRef, enabled, measure])

  // The content changed: measure again once it is drawn.
  useEffect(() => {
    if (!enabled) return
    const frame = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(frame)
  }, [enabled, key, measure])

  return enabled ? edges : NONE
}

/** True while the box hides some of its content (it scrolls). */
export function hidesContent(edges: ScrollEdges): boolean {
  return edges.above || edges.below || edges.left || edges.right
}

/**
 * A box that scrolls must be reachable with the keyboard, or keyboard users cannot read
 * the rest (Safari does not make scrolling boxes focusable by itself): while it hides
 * content, it is a Tab stop with a name that says so ("Data (scrolls)").
 */
export function scrollStop(
  edges: ScrollEdges,
  label: string,
): { tabIndex?: number; role?: 'group'; 'aria-label'?: string } {
  if (!hidesContent(edges)) return {}
  return { tabIndex: 0, role: 'group', 'aria-label': `${label} (scrolls)` }
}

/**
 * The fade (`edgeFade`) is a mask, and a mask also hides the box's own focus outline.
 * Put this on the box's parent: the parent draws the outline while the box has the focus.
 * (The box itself gets `focus-visible:outline-none`.)
 */
export const FOCUS_RING_FOR_CHILD =
  'rounded-md has-[>:focus-visible]:outline-2 has-[>:focus-visible]:outline-offset-2 has-[>:focus-visible]:outline-focus'

/** The CSS mask (a Tailwind class) that fades the top and bottom edges that hide content. */
export function edgeFade({ above, below }: ScrollEdges): string | undefined {
  if (above && below) {
    return '[mask-image:linear-gradient(to_bottom,transparent,black_1.75rem,black_calc(100%-2rem),transparent)]'
  }
  if (above) return '[mask-image:linear-gradient(to_bottom,transparent,black_1.75rem)]'
  if (below) return '[mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]'
  return undefined
}

/**
 * A short fade at the right and bottom edges that hide content, as an inline style (two
 * edges at once need two masks that intersect). Used by code listings: a line that goes on
 * to the right, more lines below.
 */
export function codeFade({ right, below }: ScrollEdges): CSSProperties | undefined {
  const masks = [
    right && 'linear-gradient(to right, black calc(100% - 1.5rem), transparent)',
    below && 'linear-gradient(to bottom, black calc(100% - 1.25rem), transparent)',
  ].filter((mask) => mask !== false)
  if (masks.length === 0) return undefined
  return { maskImage: masks.join(', '), maskComposite: 'intersect' }
}
