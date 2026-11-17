/**
 * Which page the cheat sheet prints as: the 3×5 inch index card or the letter page.
 *
 * The mode lives outside React, on the document itself, because it must be in place the
 * moment the browser starts to print:
 *
 * - the attribute `data-cheatsheet-print` on <html> picks the rendition (cheatsheet.css);
 * - one <style> element in <head> holds the `@page` rule with the paper size and margins.
 *
 * While the cheat sheet is open the mode is `letter`, so the browser's own Print command
 * (Ctrl+P or Cmd+P) gives the letter page. A click on the card button switches to `card`,
 * prints, and switches back when the browser reports that the print job is over.
 * When the page closes, both the attribute and the <style> element are removed, so no
 * other page of the site is printed with these rules.
 */
import { useCallback, useEffect } from 'react'

export type PrintMode = 'card' | 'letter'

/** The paper of each mode. The card is 5 inches wide and 3 inches tall (landscape). */
const PAGE_RULES: Readonly<Record<PrintMode, string>> = {
  card: '@page { size: 5in 3in; margin: 0.1in }',
  letter: '@page { size: letter; margin: 0.5in }',
}

const PRINT_MODE_ATTRIBUTE = 'data-cheatsheet-print'
const PAGE_RULE_STYLE_ID = 'cheatsheet-page-rule'

function pageRuleElement(): HTMLStyleElement {
  const found = document.getElementById(PAGE_RULE_STYLE_ID)
  if (found instanceof HTMLStyleElement) return found
  found?.remove()
  const style = document.createElement('style')
  style.id = PAGE_RULE_STYLE_ID
  document.head.append(style)
  return style
}

function setPrintMode(mode: PrintMode): void {
  document.documentElement.setAttribute(PRINT_MODE_ATTRIBUTE, mode)
  const style = pageRuleElement()
  if (style.textContent !== PAGE_RULES[mode]) style.textContent = PAGE_RULES[mode]
}

function clearPrintMode(): void {
  document.documentElement.removeAttribute(PRINT_MODE_ATTRIBUTE)
  document.getElementById(PAGE_RULE_STYLE_ID)?.remove()
}

/**
 * Keeps the print mode in step with the page and returns the function behind the two
 * print buttons: `print('card')` or `print('letter')`.
 */
export function usePrintMode(): (mode: PrintMode) => void {
  useEffect(() => {
    const backToLetter = () => setPrintMode('letter')
    backToLetter()

    // The print job is over (printed or cancelled).
    window.addEventListener('afterprint', backToLetter)
    // A browser that never sends `afterprint`: the next key press or tap on the page puts
    // the letter page back. These cannot arrive while the print window is open, because
    // the page takes no input then.
    window.addEventListener('keydown', backToLetter, true)
    window.addEventListener('pointerdown', backToLetter, true)

    return () => {
      window.removeEventListener('afterprint', backToLetter)
      window.removeEventListener('keydown', backToLetter, true)
      window.removeEventListener('pointerdown', backToLetter, true)
      clearPrintMode()
    }
  }, [])

  return useCallback((mode: PrintMode) => {
    // Both changes are made on the document directly, not through React state: they must
    // be in place before `print()` starts, and `print()` can start at once.
    setPrintMode(mode)
    window.print()
  }, [])
}
