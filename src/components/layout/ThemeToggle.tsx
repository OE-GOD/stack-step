import type { ReactNode } from 'react'
import { setTheme, useTheme } from '../../lib/theme'
import { IconButton } from '../ui/IconButton'
import { MoonIcon, SunIcon } from '../ui/icons'

export interface ThemeToggleProps {
  className?: string
}

/**
 * Switches between the light and the dark theme and remembers the choice. The icon shows
 * the theme you get when you press it; the name says the same in words.
 */
export function ThemeToggle({ className }: ThemeToggleProps): ReactNode {
  const theme = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <IconButton
      label={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
      className={className}
    >
      {next === 'dark' ? <MoonIcon size={22} /> : <SunIcon size={22} />}
    </IconButton>
  )
}
