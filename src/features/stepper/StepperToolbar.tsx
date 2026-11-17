import { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../components/ui/Button'
import { cx } from '../../components/ui/cx'
import { CheckIcon, CloseIcon, LinkIcon } from '../../components/ui/icons'
import { IconButton } from '../../components/ui/IconButton'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import type { EmulatorOptions } from '../../emulator'
import { EXAMPLES } from '../../examples'
import { programMenu } from './initialProgram'
import { ShortcutsHelp } from './ShortcutsHelp'
import { shareLinkFor, TOO_LONG_TO_SHARE } from './shareLink'

export interface StepperToolbarProps {
  /**
   * The program the session runs. It changes when typing pauses, not on every key, so the
   * toolbar does not render again while the student types.
   */
  source: string
  /** The editor holds a link's program that the student has not changed. */
  linkProgram: boolean
  /** The student has another program to come back to (see `programMenu`). */
  hasOtherProgram: boolean
  /** The newest program and its starting state, read when Share is pressed. */
  getProgram: () => { code: string; options: EmulatorOptions | undefined }
  /** An example id, or the value of one of the student's programs (`programMenu`). */
  onChooseExample: (id: string) => void
  /** The single keys S, B, R and 0 work (a choice in the Keys panel). */
  singleKeys: boolean
  onSingleKeysChange: (on: boolean) => void
  className?: string
}

/** How long "Link copied" stays on the screen. */
const COPIED_MS = 2500
/** How long "too long to share" stays on the screen. */
const TOO_LONG_MS = 6000

type ShareState =
  { kind: 'idle' } | { kind: 'copied' } | { kind: 'too-long' } | { kind: 'manual'; link: string }

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** When the clipboard cannot be used: the link in a field, selected, ready to copy. */
function ManualLink({ link, onClose }: { link: string; onClose: () => void }): ReactNode {
  const linkId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  return (
    <div className="mt-2 flex items-end gap-2 rounded-lg border border-line-strong bg-surface p-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={linkId} className="text-sm font-semibold text-ink">
          Copy this link to share the program
        </label>
        <Input
          ref={inputRef}
          id={linkId}
          readOnly
          mono
          value={link}
          onFocus={(event) => event.target.select()}
          className="mt-1 text-sm"
        />
      </div>
      <IconButton label="Close" onClick={onClose}>
        <CloseIcon />
      </IconButton>
    </div>
  )
}

/**
 * The top of the stepper: the page's one <h1>, the Example menu, Share and Keys. One row
 * when the column is wide enough, else two (the menu goes under the title). The chosen
 * example's description is shown in the Explanation card before the first step.
 *
 * Memoised: neither a step nor a key typed in the editor renders it again (pass stable
 * callbacks).
 */
export const StepperToolbar = memo(function StepperToolbar({
  source,
  linkProgram,
  hasOtherProgram,
  getProgram,
  onChooseExample,
  singleKeys,
  onSingleKeysChange,
  className,
}: StepperToolbarProps): ReactNode {
  const selectId = useId()
  const [share, setShare] = useState<ShareState>({ kind: 'idle' })
  const menu = programMenu({ source, linkProgram, hasOther: hasOtherProgram })

  // A link in the field belongs to the program it was made from: close it after a change.
  const [linkSource, setLinkSource] = useState(source)
  if (linkSource !== source) {
    setLinkSource(source)
    if (share.kind === 'manual') setShare({ kind: 'idle' })
  }

  useEffect(() => {
    if (share.kind !== 'copied' && share.kind !== 'too-long') return
    const timer = window.setTimeout(
      () => setShare({ kind: 'idle' }),
      share.kind === 'copied' ? COPIED_MS : TOO_LONG_MS,
    )
    return () => window.clearTimeout(timer)
  }, [share])

  const shareLink = async () => {
    const { code, options } = getProgram()
    const link = shareLinkFor(options === undefined ? { code } : { code, options })
    if (link === null) {
      setShare({ kind: 'too-long' })
      return
    }
    const copied = await copyToClipboard(link)
    setShare(copied ? { kind: 'copied' } : { kind: 'manual', link })
  }

  return (
    <div className={cx('@container min-w-0', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-2xl leading-tight font-extrabold tracking-tight text-ink">Stepper</h1>

        <div className="order-1 flex basis-full items-center gap-2 @[34rem]:order-none @[34rem]:min-w-0 @[34rem]:flex-1 @[34rem]:basis-0">
          <label htmlFor={selectId} className="text-sm font-semibold text-ink">
            Example
          </label>
          <Select
            id={selectId}
            value={menu.value}
            onChange={(event) => onChooseExample(event.target.value)}
            className="min-w-0 flex-1 @[34rem]:max-w-64"
          >
            {menu.choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
            {EXAMPLES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </Select>
        </div>

        <div className="ml-auto flex items-center gap-0.5 @[34rem]:ml-0">
          <div className="relative">
            <Button
              variant="ghost"
              onClick={() => void shareLink()}
              title="Copy a link to this program"
              className="px-2.5"
            >
              {share.kind === 'copied' ? (
                <CheckIcon size={20} className="text-good" />
              ) : (
                <LinkIcon size={20} />
              )}
              Share
            </Button>
            {(share.kind === 'copied' || share.kind === 'too-long') && (
              <span
                aria-hidden="true"
                data-share-message=""
                className={cx(
                  'absolute top-full right-0 z-30 mt-1 animate-fade-in rounded-md px-2.5 py-1 text-sm font-semibold shadow-lg',
                  share.kind === 'copied'
                    ? 'bg-ink whitespace-nowrap text-bg'
                    : 'w-56 border border-bad bg-surface text-ink',
                )}
              >
                {share.kind === 'copied' ? 'Link copied' : TOO_LONG_TO_SHARE}
              </span>
            )}
          </div>
          <ShortcutsHelp singleKeys={singleKeys} onSingleKeysChange={onSingleKeysChange} />
        </div>
      </div>

      {/* Read out when the link was copied, or could not be made. */}
      <p role="status" className="sr-only">
        {share.kind === 'copied'
          ? 'Link copied.'
          : share.kind === 'too-long'
            ? TOO_LONG_TO_SHARE
            : ''}
      </p>

      {share.kind === 'manual' && (
        <ManualLink link={share.link} onClose={() => setShare({ kind: 'idle' })} />
      )}
    </div>
  )
})
