/**
 * Join class names and skip the empty ones:
 *   cx('rounded', isActive && 'font-bold', className)  →  'rounded font-bold'
 */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
