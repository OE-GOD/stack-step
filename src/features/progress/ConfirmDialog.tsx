import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Button } from '../../components/ui/Button'

export interface ConfirmDialogProps {
  /** Show the dialog. The page stays in charge: it sets this back to false. */
  open: boolean
  /** The question, as the heading of the dialog: "Reset your progress?" */
  title: string
  /** What will happen, in one or two plain sentences. */
  children: ReactNode
  /** The words on the button that says yes: "Yes, reset my progress". */
  confirmLabel: string
  /** The words on the button that says no. Default "Cancel". */
  cancelLabel?: string
  /** The yes button throws data away, so it gets the look of a dangerous action. */
  danger?: boolean
  onConfirm: () => void
  /** Also called when the dialog is closed in any other way, such as the Escape key. */
  onCancel: () => void
}

/**
 * A small window that asks "are you sure?" before something that cannot be undone.
 *
 * It is the browser's own <dialog>, opened with `showModal()`. The browser then does
 * the hard parts: keyboard focus cannot leave the dialog, the rest of the page takes no
 * input, the Escape key closes it, and focus goes back to the button that opened it.
 *
 * Focus starts on the button that says no, so pressing Enter by habit is safe.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactNode {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()
  const textId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    if (open && !dialog.open) {
      dialog.showModal()
      cancelRef.current?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={textId}
      // The browser closed the dialog by itself (the Escape key): tell the page.
      // After the page has closed it, `open` is already false and nothing is reported.
      onClose={() => {
        if (open) onCancel()
      }}
      // No display class here: a closed <dialog> must stay hidden.
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md overflow-auto rounded-2xl border border-line-strong bg-surface p-0 text-ink shadow-xl backdrop:bg-[rgb(0_0_0/0.55)]"
    >
      <div className="p-5 md:p-6">
        <h2 id={titleId} className="text-xl leading-tight font-bold text-balance">
          {title}
        </h2>
        <div id={textId} className="mt-2 text-pretty text-muted [&>*+*]:mt-2">
          {children}
        </div>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button ref={cancelRef} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  )
}
