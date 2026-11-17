import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { PrintSheet } from './Sheet'

/** The card is 5 inches wide. On screen one inch is 96 px, so the card is 480 px wide. */
const CARD_WIDTH_PX = 5 * 96

/**
 * The index card at its real size (5 × 3 inches = 480 × 288 px), in a frame that looks
 * like paper in both themes. On a screen that is narrower than the card, the whole card
 * is made smaller so that it still fits.
 *
 * The card inside the frame is the very element that prints in card mode, so the preview
 * cannot differ from the printed card. Screen readers skip it: the readable sheet lower
 * on the page has the same words.
 */
export function CardPreview(): ReactNode {
  const headingId = useId()
  const frameRef = useRef<HTMLDivElement | null>(null)

  // Before the first paint, and again whenever the frame changes width.
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (frame === null) return
    const fit = () => {
      const scale = Math.min(1, frame.clientWidth / CARD_WIDTH_PX)
      frame.style.setProperty('--cs-preview-scale', String(scale))
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  return (
    <section className="cs-preview" aria-labelledby={headingId}>
      <h2 id={headingId} className="cs-screen-only text-lg leading-tight font-bold">
        Preview of the index card
      </h2>
      <div ref={frameRef} className="cs-preview-frame">
        <div className="cs-preview-scaler" aria-hidden="true">
          <PrintSheet variant="card" />
        </div>
      </div>
      <p className="cs-screen-only text-sm text-pretty text-muted">
        The printed card is 5 × 3 inches (12.7 × 7.6 cm). The type is small, like on a real exam
        card.
      </p>
    </section>
  )
}
