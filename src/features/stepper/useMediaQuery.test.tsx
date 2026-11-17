// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMediaQuery, WIDE_LAYOUT } from './useMediaQuery'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Layout(): ReactNode {
  return <p>{useMediaQuery(WIDE_LAYOUT) ? 'wide' : 'narrow'}</p>
}

describe('useMediaQuery', () => {
  it('answers false instead of crashing in a browser without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    render(<Layout />)
    expect(screen.getByText('narrow')).toBeDefined()
  })

  it('follows the media query when the browser has matchMedia', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === WIDE_LAYOUT,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
    render(<Layout />)
    expect(screen.getByText('wide')).toBeDefined()
  })
})
