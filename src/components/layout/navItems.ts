/** The pages in the main menu, in the order they are shown. */
export const NAV_ITEMS = [
  { to: '/stepper', label: 'Stepper' },
  { to: '/learn', label: 'Learn' },
  { to: '/practice', label: 'Practice' },
  { to: '/cheatsheet', label: 'Cheat sheet' },
  { to: '/progress', label: 'Progress' },
  { to: '/about', label: 'About' },
] as const

/** True on the page itself and on the pages below it ('/learn' and '/learn/mov'). */
export function isNavItemActive(to: string, path: string): boolean {
  return path === to || path.startsWith(`${to}/`)
}
