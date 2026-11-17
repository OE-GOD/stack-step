/**
 * Light and dark theme.
 *
 * The theme is the `dark` class on <html>. A small script in index.html sets it before
 * the first paint: the saved choice if there is one, otherwise what the device prefers.
 * This file switches it afterwards.
 *
 * The choice is saved as the plain word `light` or `dark` under `stackstep:theme`
 * (plain text, not JSON, because the script in index.html compares the raw value).
 */
import { useSyncExternalStore } from 'react'
import { loadText, saveText } from './storage'

export type Theme = 'light' | 'dark'

export const THEME_KEY = 'stackstep:theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

const listeners = new Set<() => void>()
let watching = false
/** True once the student has picked a theme in this tab (even if it could not be saved). */
let chosenHere = false

function savedTheme(): Theme | null {
  const saved = loadText(THEME_KEY)
  return saved === 'light' || saved === 'dark' ? saved : null
}

function deviceTheme(): Theme {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
    ? 'dark'
    : 'light'
}

function apply(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  // Always tell the listeners, even when the class was already right: something else may
  // have changed it. A listener that sees no change simply does not re-render.
  for (const listener of [...listeners]) listener()
}

/** Follow changes that happen outside this tab's own buttons. */
function watch(): void {
  if (watching) return
  watching = true

  // Another tab of the site switched the theme (or cleared the saved choice).
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== THEME_KEY) return
    apply(savedTheme() ?? (chosenHere ? getTheme() : deviceTheme()))
  })

  // The device switched between light and dark, and the student has not picked a theme.
  // (Old browsers have matchMedia without addEventListener: they just do not follow.)
  const deviceSetting =
    typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null
  if (deviceSetting !== null && typeof deviceSetting.addEventListener === 'function') {
    deviceSetting.addEventListener('change', (event) => {
      if (chosenHere || savedTheme() !== null) return
      apply(event.matches ? 'dark' : 'light')
    })
  }
}

/** The theme that is showing now. */
function getTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/** Switch the theme and remember the choice (when the browser allows storage). */
export function setTheme(theme: Theme): void {
  chosenHere = true
  saveText(THEME_KEY, theme)
  apply(theme)
}

function subscribeTheme(listener: () => void): () => void {
  watch()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getThemeOnServer(): Theme {
  return 'light'
}

/** React hook: the theme that is showing now; re-renders when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, getTheme, getThemeOnServer)
}
