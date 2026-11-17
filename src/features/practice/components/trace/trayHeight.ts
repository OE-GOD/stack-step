/**
 * The height of the tray, as a CSS variable on the trace table.
 *
 * While the tray sticks to the bottom of a phone screen, every cell keeps that much room
 * free below it when it gets the keyboard focus (`CLEAR_OF_TRAY` in chipStyles.ts), so
 * the browser scrolls a focused line out from under the tray. CSS cannot read the height
 * of another box, so it is measured here, and measured again whenever the tray changes
 * size (chips come and go, the screen turns).
 */

/** The name of the variable. `CLEAR_OF_TRAY` reads it, with 0px when it is not set. */
const TRAY_HEIGHT_VAR = '--trace-tray-h'

/**
 * Keep `--trace-tray-h` on `root` equal to the height of the tray inside it, in pixels.
 * Returns the function that stops. Without a tray, or in a browser without
 * ResizeObserver, it does nothing: the cells then keep only the room for the focus ring.
 */
export function watchTrayHeight(root: HTMLElement): () => void {
  const tray = root.querySelector<HTMLElement>('[data-trace-tray]')
  if (tray === null || typeof ResizeObserver === 'undefined') return () => undefined
  const observer = new ResizeObserver(() => {
    root.style.setProperty(TRAY_HEIGHT_VAR, `${Math.ceil(tray.getBoundingClientRect().height)}px`)
  })
  observer.observe(tray)
  return () => {
    observer.disconnect()
    root.style.removeProperty(TRAY_HEIGHT_VAR)
  }
}
