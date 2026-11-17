import type { ReactNode } from 'react'
import { Callout, type CalloutProps } from './Callout'

/**
 * The one sentence for a browser that does not let the site save (storageAvailable() in
 * src/lib/storage.ts is false). Progress then lives in memory only: it is gone after a
 * reload, and when the page is closed.
 */
export const NOT_SAVED_TEXT =
  'This browser does not let Stack Step save your progress. It is kept only until you close or reload this page.'

export type NotSavedNoteProps = Omit<CalloutProps, 'tone' | 'label' | 'children'>

/**
 * The note that progress cannot be saved, in one tone and one sentence on every page that
 * keeps progress (Learn, Practice, Progress). Other attributes go to the box.
 */
export function NotSavedNote(props: NotSavedNoteProps): ReactNode {
  return (
    <Callout tone="info" label="Not saved" {...props}>
      <p className="text-pretty">{NOT_SAVED_TEXT}</p>
    </Callout>
  )
}
