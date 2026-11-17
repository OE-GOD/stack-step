/**
 * The tutor's button and its chat drawer.
 *
 * This file is downloaded only after the tutor function said that the tutor is on
 * (see TutorMount.tsx), so nothing here costs a student who has no tutor.
 *
 * The drawer is a native <dialog> opened with showModal(): the browser keeps keyboard
 * focus inside it, closes it on Escape, and makes the rest of the page inert. On a wide
 * screen it is a column on the right; on a phone it is a sheet that comes up from the
 * bottom, and the page behind it cannot be scrolled.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Button } from '../../components/ui/Button'
import { Callout } from '../../components/ui/Callout'
import { cx } from '../../components/ui/cx'
import { FIELD_CLASSES } from '../../components/ui/fieldStyles'
import { IconButton } from '../../components/ui/IconButton'
import { CloseIcon } from '../../components/ui/icons'
import { InlineCode } from '../../components/ui/InlineCode'
import { Spinner } from '../../components/ui/Spinner'
import { tutorChat, type Turn } from './chatStore'
import { TUTOR_CLIENT_LIMITS } from './limits'
import { parseReply } from './replyText'
import { waitInWords } from './tutorApi'
import type { TutorContext, TutorMountProps } from './TutorMount'

const MAX_QUESTION = TUTOR_CLIENT_LIMITS.maxMessageChars
/** The counter appears when this many characters are left. */
const COUNTER_FROM = MAX_QUESTION - 200
/** Below this width the drawer is a bottom sheet (Tailwind's `md` breakpoint). */
const PHONE = '(max-width: 47.99rem)'
/** The log follows new text while the student is this close to its end (px). */
const NEAR_END = 48
/** The name of a key (Enter, Shift) in the small hint beside the label of the text box. */
const KEY = 'font-sans font-semibold text-ink'

/** A speech bubble, drawn like the icons of the UI kit. */
function ChatIcon({ className }: { className?: string }): ReactNode {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx('shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 12a7.5 7.5 0 0 1-7.5 7.5H5l1.7-3A7.5 7.5 0 1 1 20 12z" />
      <path d="M9 10.5h6M9 13.5h4" />
    </svg>
  )
}

interface ChatTextProps {
  text: string
  /** True while the text is still arriving (see parseReply). */
  arriving?: boolean
  className: string
}

/**
 * A message as plain text: line breaks are kept and `code` is shown in the code font.
 * The text is never read as HTML.
 */
function ChatText({ text, arriving = false, className }: ChatTextProps): ReactNode {
  return (
    <div className={cx('px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere]', className)}>
      {parseReply(text, arriving).map((part, index) => {
        if (part.kind === 'text') return <span key={index}>{part.text}</span>
        if (part.kind === 'code') return <InlineCode key={index}>{part.text}</InlineCode>
        return (
          <pre key={index} className="my-1 rounded-md bg-ink/8 px-2 py-1.5 whitespace-pre-wrap">
            <code className="font-mono text-[length:max(0.9em,0.875rem)]">{part.text}</code>
          </pre>
        )
      })}
    </div>
  )
}

/** The word on the warning box of a failed turn. */
function failureLabel(turn: Turn): string {
  return turn.reply === '' ? 'No reply' : 'The reply is not complete'
}

/** A reply as a screen reader should say it: the words, without the backticks. */
function spoken(text: string): string {
  return parseReply(text)
    .map((part) => part.text)
    .join('')
}

/**
 * What a screen reader is told about the newest turn. The conversation itself is not a
 * live region: a reply that grows piece by piece would be read out in fragments, or not
 * at all. This one short text changes when a question is sent, and once more when the
 * reply is complete, stopped or failed.
 */
function announcementOf(turn: Turn | undefined): string {
  if (turn === undefined) return ''
  switch (turn.state) {
    case 'waiting':
    case 'streaming':
      return 'The tutor is thinking…'
    case 'done':
      return `Tutor: ${spoken(turn.reply)}`
    case 'stopped':
      return turn.reply === ''
        ? 'You stopped this reply.'
        : `You stopped this reply. Tutor: ${spoken(turn.reply)}`
    case 'failed':
      return `${failureLabel(turn)}. ${turn.failure?.message ?? ''}`.trim()
  }
}

interface TurnViewProps {
  turn: Turn
  /** True when the student can ask this question again (the last turn, nothing arriving). */
  canRetry: boolean
  /** Seconds until the tutor may be asked again (after "please wait"); 0 = now. */
  waitSeconds: number
  onRetry: () => void
}

/** One question and its reply. "You" and "Tutor" are written out: color is not the only sign. */
function TurnView({ turn, canRetry, waitSeconds, onRetry }: TurnViewProps): ReactNode {
  const { state, reply, failure } = turn
  const retry = canRetry && (
    <Button size="md" onClick={onRetry} disabled={waitSeconds > 0}>
      {waitSeconds > 0 ? `Try again in ${waitInWords(waitSeconds)}` : 'Try again'}
    </Button>
  )

  return (
    <div className="flex flex-col gap-2" data-turn-state={state}>
      <div className="ml-auto max-w-[88%]">
        <p className="mb-0.5 text-right text-sm font-semibold text-muted md:text-xs">You</p>
        <ChatText text={turn.question} className="rounded-xl rounded-br-sm bg-primary-soft" />
      </div>

      <div className="mr-auto max-w-[94%] min-w-0">
        <p className="mb-0.5 text-sm font-semibold text-muted md:text-xs">Tutor</p>
        {state === 'waiting' && (
          <p className="flex items-center gap-2 rounded-xl rounded-bl-sm bg-surface-2 px-3 py-2 text-muted">
            <Spinner size={16} />
            The tutor is thinking…
          </p>
        )}
        {reply !== '' && (
          <ChatText
            text={reply}
            arriving={state === 'streaming'}
            className="rounded-xl rounded-bl-sm bg-surface-2"
          />
        )}
        {state === 'stopped' && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-sm text-muted">You stopped this reply.</p>
            {retry}
          </div>
        )}
        {state === 'failed' && failure !== null && (
          <Callout
            tone="warn"
            label={failureLabel(turn)}
            className={reply === '' ? undefined : 'mt-2'}
          >
            <p>{failure.message}</p>
            {retry !== false && <p>{retry}</p>}
          </Callout>
        )}
      </div>
    </div>
  )
}

export default function TutorDrawer({ getContext }: TutorMountProps): ReactNode {
  const chat = useSyncExternalStore(tutorChat.subscribe, tutorChat.getSnapshot)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const dialogRef = useRef<HTMLDialogElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  /** True while the log should follow the newest text. */
  const followRef = useRef(true)

  // The page may pass a new function on every render. Always call the newest one.
  const contextRef = useRef(getContext)
  useEffect(() => {
    contextRef.current = getContext
  }, [getContext])
  const currentContext = (): TutorContext => contextRef.current()

  const titleId = useId()
  const noteId = useId()
  const inputId = useId()
  const hintId = useId()
  const counterId = useId()

  const openDrawer = (): void => {
    const dialog = dialogRef.current
    if (dialog === null || dialog.open) return
    dialog.showModal()
    setOpen(true)
    // With a keyboard and a mouse: straight to the text box. On a touch screen that
    // would bring up the on-screen keyboard over the conversation, so the heading takes
    // the focus there and the student taps the text box when ready.
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus()
    else titleRef.current?.focus()
  }

  const closeDrawer = (): void => {
    dialogRef.current?.close()
  }

  // A click on the dimmed page beside the drawer closes it. Both the press and the
  // release must be outside, so that selecting text with the mouse cannot close it.
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    let pressedOutside = false
    const onPointerDown = (event: PointerEvent): void => {
      pressedOutside = event.target === dialog
    }
    const onClick = (event: MouseEvent): void => {
      if (pressedOutside && event.target === dialog) dialog.close()
      pressedOutside = false
    }
    dialog.addEventListener('pointerdown', onPointerDown)
    dialog.addEventListener('click', onClick)
    return () => {
      dialog.removeEventListener('pointerdown', onPointerDown)
      dialog.removeEventListener('click', onClick)
    }
  }, [])

  // On a phone the page behind the sheet must not scroll.
  useEffect(() => {
    if (!open || !window.matchMedia(PHONE).matches) return
    const root = document.documentElement
    const before = root.style.overflow
    root.style.overflow = 'hidden'
    return () => {
      root.style.overflow = before
    }
  }, [open])

  // Keep the newest text in view, unless the student has scrolled up to read.
  useLayoutEffect(() => {
    const log = logRef.current
    if (log !== null && open && followRef.current) log.scrollTop = log.scrollHeight
  }, [chat.turns, open])

  const send = (): void => {
    if (!tutorChat.send(draft, currentContext)) return
    setDraft('')
    followRef.current = true
    // After a click on Send, typing the next question needs no extra click.
    inputRef.current?.focus()
  }

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    send()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    // Enter also confirms a word in Chinese, Japanese or Korean input: that is not "send".
    if (event.nativeEvent.isComposing) return
    // Enter with Ctrl, Cmd or Alt belongs to the page (the stepper's shortcuts).
    if (event.ctrlKey || event.metaKey || event.altKey) return
    event.preventDefault()
    send()
  }

  const retry = (): void => {
    followRef.current = true
    tutorChat.retry(currentContext)
    inputRef.current?.focus()
  }

  const stop = (): void => {
    tutorChat.stop()
    inputRef.current?.focus()
  }

  const newChat = (): void => {
    tutorChat.reset()
    followRef.current = true
    inputRef.current?.focus()
  }

  const lastTurn = chat.turns[chat.turns.length - 1]
  const canSend = !chat.busy && chat.waitSeconds === 0 && draft.trim() !== ''
  const formNote = [
    chat.waitSeconds > 0 ? `You can ask again in ${waitInWords(chat.waitSeconds)}.` : '',
    draft.length < COUNTER_FROM
      ? ''
      : draft.length >= MAX_QUESTION
        ? `${draft.length} of ${MAX_QUESTION} characters. This is the limit.`
        : `${draft.length} of ${MAX_QUESTION} characters`,
  ]
    .filter((part) => part !== '')
    .join(' ')

  return (
    <>
      {/* On a phone only the icon shows, so that the button hides less of the page. */}
      <Button
        ref={launcherRef}
        variant="primary"
        onClick={openDrawer}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tutor="button"
        className="fixed right-4 bottom-[calc(1rem+var(--tutor-bottom-offset,0px)+env(safe-area-inset-bottom,0px))] z-20 shadow-lg print:hidden max-md:size-12 max-md:rounded-full max-md:p-0"
      >
        <ChatIcon className="max-md:size-6" />
        <span className="max-md:sr-only">Ask the tutor</span>
      </Button>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={noteId}
        data-tutor="drawer"
        onClose={() => {
          setOpen(false)
          launcherRef.current?.focus()
        }}
        className={cx(
          // A column on the right…
          'm-0 ml-auto h-dvh max-h-none w-full max-w-md overflow-hidden border-l border-line-strong bg-surface p-0 text-ink shadow-2xl',
          'backdrop:bg-black/30',
          // …and a sheet at the bottom on a phone…
          'max-md:mt-auto max-md:h-[min(85dvh,42rem)] max-md:max-w-none max-md:rounded-t-2xl max-md:border-t max-md:border-l-0',
          // …that takes the whole height of a short screen (an on-screen keyboard that
          // makes the page shorter, a phone held sideways).
          'max-md:[@media(max-height:30rem)]:h-dvh max-md:[@media(max-height:30rem)]:rounded-none',
        )}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-1 border-b border-line py-1.5 pr-1.5 pl-4">
            <h2
              id={titleId}
              ref={titleRef}
              tabIndex={-1}
              className="mr-auto text-lg font-bold outline-none"
            >
              Tutor
            </h2>
            <Button variant="ghost" onClick={newChat} disabled={chat.turns.length === 0}>
              New chat
            </Button>
            <IconButton label="Close the tutor" onClick={closeDrawer}>
              <CloseIcon />
            </IconButton>
          </div>

          {/*
            On a short screen (for example while an on-screen keyboard makes the page
            shorter) the note steps aside, so that the conversation keeps some room. It
            stays the description of the dialog, which a screen reader reads on opening.
            (It depends on the height of the screen only, not on the focus: a note that
            came back when the text box lost the focus would move the buttons under a
            finger in the middle of a tap.)
          */}
          <p
            id={noteId}
            className="border-b border-line bg-surface-2 px-4 py-2 text-sm text-muted [@media(max-height:30rem)]:hidden"
          >
            The tutor gives hints. It will not write your homework. It can make mistakes: check with
            the stepper.
          </p>

          {/*
            The conversation. It can be scrolled, so it must be reachable with the keyboard:
            hence the tabIndex. It is not a live region (see announcementOf): the status
            line after it tells a screen reader about each reply once, when it is complete.
          */}
          <div
            ref={logRef}
            role="region"
            aria-label="Conversation with the tutor"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must take keyboard focus
            tabIndex={0}
            onScroll={(event) => {
              const log = event.currentTarget
              followRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_END
            }}
            className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 py-4"
          >
            {chat.turns.length === 0 ? (
              <div className="m-auto max-w-xs text-center text-pretty text-muted">
                <p className="font-semibold text-ink">Ask about the code on this page.</p>
                <p className="mt-2 text-sm">
                  The tutor can see your code and the values that this page shows. Your question and
                  that data are sent to an AI service, which writes the reply. Do not write private
                  things.
                </p>
              </div>
            ) : (
              chat.turns.map((turn) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  canRetry={turn === lastTurn && !chat.busy}
                  waitSeconds={chat.waitSeconds}
                  onRetry={retry}
                />
              ))
            )}
          </div>
          <p role="status" aria-live="polite" className="sr-only">
            {announcementOf(lastTurn)}
          </p>

          <form onSubmit={onSubmit} className="border-t border-line px-4 pt-3 pb-4">
            <div className="mb-1 flex items-baseline justify-between gap-3 whitespace-nowrap">
              <label htmlFor={inputId} className="text-sm font-semibold">
                Your question
              </label>
              {/*
                A phone has no Enter and Shift keys to explain, so the hint is for wider
                screens. The key names are plain bold words: drawn keys do not fit here.
              */}
              <p id={hintId} className="text-xs text-muted max-md:hidden">
                <kbd className={KEY}>Enter</kbd> sends. <kbd className={KEY}>Shift</kbd> +{' '}
                <kbd className={KEY}>Enter</kbd> makes a new line.
              </p>
            </div>
            <textarea
              id={inputId}
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              maxLength={MAX_QUESTION}
              enterKeyHint="send"
              aria-describedby={`${hintId} ${counterId}`}
              className={cx(
                FIELD_CLASSES,
                'field-sizing-content max-h-40 min-h-[4.5rem] resize-none',
              )}
            />
            <div className="mt-2 flex min-h-11 items-center gap-2">
              {/* 14 px on a phone: the wait before the next question must be easy to read. */}
              <p id={counterId} className="mr-auto min-w-0 text-sm text-muted md:text-xs">
                {formNote}
              </p>
              {chat.busy && <Button onClick={stop}>Stop</Button>}
              <Button type="submit" variant="primary" disabled={!canSend}>
                Send
              </Button>
            </div>
          </form>
        </div>
      </dialog>
    </>
  )
}
