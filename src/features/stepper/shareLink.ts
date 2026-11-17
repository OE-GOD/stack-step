/** The Share button's link: the program (and its starting state) in the address. */
import { fitsInLink, stepperUrl, type StepperPayload } from '../../lib/share'

export const TOO_LONG_TO_SHARE = 'This program is too long to share as a link.'

/**
 * The link to share, or null when the program is too long for a link: the page that opens
 * a link refuses one that long (about 74 kB of code), so it is better not to hand it out.
 */
export function shareLinkFor(payload: StepperPayload): string | null {
  return fitsInLink(payload) ? stepperUrl(payload) : null
}
