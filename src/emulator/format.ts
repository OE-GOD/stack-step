/**
 * Numbers and lists as text: hex for the panels and the explanations, reading the hex
 * answers that students type in practice, and the small joiners every message uses.
 *
 * Every hex function except `signedHex` treats its value as unsigned. A negative value is
 * first turned into its 64-bit two's complement (or its `size`-bit one where a size is
 * given), so hex(-1n) is '0xffffffffffffffff'.
 *
 * `hex64`, `hexSized` and `signedDecimal` look only at the low bits of their width.
 * `hex`, `groupHex` and `shortAddress` do not cut a positive value, however wide it is.
 */
import { toSigned, truncate } from './bits'
import type { OperandSize } from './types'

/** Lower-case hex digits of `value` (no prefix), padded with leading zeros to `digits`. */
export function hexDigits(value: bigint, digits = 0): string {
  const unsigned = value < 0n ? truncate(value, 64) : value
  return unsigned.toString(16).padStart(digits, '0')
}

/**
 * Hex for messages, with the value exactly as it is: signedHex(255n) → '0xff',
 * signedHex(-8n) → '-0x8'. (A message must not turn a wrong negative address into a
 * huge positive one.)
 */
export function signedHex(value: bigint): string {
  return value < 0n ? `-0x${(-value).toString(16)}` : `0x${value.toString(16)}`
}

/** A count with commas between groups of three digits: groupDigits(65536) → '65,536'. */
export function groupDigits(count: number | bigint): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 'a', 'a and b', 'a, b and c'. */
export function joinAnd(items: readonly string[]): string {
  return joinWith(items, 'and')
}

/** 'a', 'a or b', 'a, b or c'. */
export function joinOr(items: readonly string[]): string {
  return joinWith(items, 'or')
}

function joinWith(items: readonly string[], word: 'and' | 'or'): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`
}

/** '0x' + lower-case hex. `digits` pads with leading zeros. hex(255n) → '0xff'; hex(255n, 4) → '0x00ff'. */
export function hex(value: bigint, digits = 0): string {
  return '0x' + hexDigits(value, digits)
}

/** Always 16 digits: hex64(7n) → '0x0000000000000007'. */
export function hex64(value: bigint): string {
  return hexSized(value, 64)
}

/** Padded to the width: hexSized(7n, 32) → '0x00000007'; hexSized(7n, 8) → '0x07'. */
export function hexSized(value: bigint, size: OperandSize): string {
  // Bits above the width are dropped, so the text always has exactly size / 4 digits.
  return hex(truncate(value, size), size / 4)
}

/**
 * Short form for explanations. Values below 0x10000 are shown in full ('0x1f8');
 * larger ones keep the last 4 digits: shortAddress(0x7ffffffddff8n) → '0x…dff8'.
 */
export function shortAddress(value: bigint): string {
  const digits = hexDigits(value, 0)
  return digits.length <= 4 ? '0x' + digits : '0x…' + digits.slice(-4)
}

/** Digits in groups of four, no prefix: groupHex(0x7ffffffddff8n) → '0000 7fff fffd dff8'. */
export function groupHex(value: bigint, digits = 16): string {
  const text = hexDigits(value, digits)
  // Cut the groups from the right, so only the first group can be shorter than four.
  const groups: string[] = []
  for (let end = text.length; end > 0; end -= 4) {
    groups.unshift(text.slice(Math.max(0, end - 4), end))
  }
  return groups.join(' ')
}

/** Signed decimal view: signedDecimal(0xffn, 8) → '-1'. */
export function signedDecimal(value: bigint, size: OperandSize): string {
  return toSigned(value, size).toString()
}

/**
 * The hex digits a student typed, with the prefix, spaces and underscores removed.
 * Null when nothing is left or when something else is in the text.
 */
function typedHexDigits(text: string): string | null {
  const digits = text.trim().replace(/^0x/i, '').replace(/[\s_]/g, '')
  return /^[0-9a-f]+$/i.test(digits) ? digits : null
}

/**
 * Read a hex answer typed by a student. Accepts an optional 0x/0X prefix, upper or
 * lower case, and spaces or underscores between digits. Returns null for an empty
 * string or anything that is not hex. '0x 0000 7FFF fffd dff8' → 0x7ffffffddff8n.
 *
 * The value is never cut to 64 bits: an answer with too many digits must stay wrong.
 */
export function parseHexAnswer(text: string): bigint | null {
  const digits = typedHexDigits(text)
  return digits === null ? null : BigInt('0x' + digits)
}

/**
 * Count the hex digits a student typed (after removing prefix, spaces, underscores),
 * or null when the text is not valid hex. Used to require "all 16 digits".
 */
export function countHexDigits(text: string): number | null {
  return typedHexDigits(text)?.length ?? null
}
