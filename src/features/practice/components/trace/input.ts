/**
 * How the student acted: with a finger, a mouse or the keyboard. The hints use it to say
 * "tap", "click" or "press Enter".
 */
import type { How } from './words'

/** The part of a click event that tells how it was made. */
export interface ClickLike {
  /** 0 when the click came from the keyboard (Enter or Space on a button). */
  detail: number
  nativeEvent: Event
}

function hasCoarsePointer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  )
}

export function howOfClick(event: ClickLike): How {
  if (event.detail === 0) return 'keyboard'
  // In most browsers a click is a pointer event and says what made it.
  const pointerType = (event.nativeEvent as Partial<PointerEvent>).pointerType
  if (pointerType === 'touch') return 'touch'
  if (pointerType === 'mouse' || pointerType === 'pen') return 'mouse'
  return hasCoarsePointer() ? 'touch' : 'mouse'
}
