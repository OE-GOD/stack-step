import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { MachineState } from '../../emulator'
import { Button } from '../ui/Button'
import { cx } from '../ui/cx'
import { Input } from '../ui/Input'
import { MachinePanel } from './MachinePanel'
import { edgeFade, FOCUS_RING_FOR_CHILD, scrollStop, useScrollEdges } from './useScrollEdges'
import { NOTHING_PRINTED } from './words'

export interface OutputPanelProps {
  machine: MachineState
  /** The student typed text for scanf and pressed Send (or Enter). */
  onSendInput: (text: string) => void
  /** Smaller text, no card (MiniStepper). */
  compact?: boolean
  title?: string
  /**
   * Extra classes for the printed text (a max height, for example). The text scrolls
   * inside, and the newest line is kept in sight.
   */
  textClassName?: string
  /** Wide screens: the content scrolls under the heading when the card is height-limited. */
  scrollOnWide?: boolean
  className?: string
}

interface InputBoxProps {
  prompt: string
  onSend: (text: string) => void
  compact: boolean
}

/** The box for scanf. It takes the keyboard focus when it appears. */
function InputBox({ prompt, onSend, compact }: InputBoxProps): ReactNode {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [text, setText] = useState('')

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <form
      className="mt-3 rounded-lg border border-primary/40 bg-primary-soft p-3"
      onSubmit={(event) => {
        event.preventDefault()
        onSend(text)
        setText('')
      }}
    >
      <label
        htmlFor={inputId}
        className={cx('block font-semibold text-ink', compact ? 'text-sm' : 'text-base')}
      >
        {prompt}
      </label>
      <div className="mt-2 flex gap-2">
        <Input
          ref={inputRef}
          id={inputId}
          mono
          value={text}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          onChange={(event) => setText(event.target.value)}
          className="min-w-0 flex-1"
        />
        <Button type="submit" variant="primary">
          Send
        </Button>
      </div>
    </form>
  )
}

/**
 * What a screen reader should hear: the text that was just printed, and nothing when the
 * output got shorter (Back) or did not change. (Reading the whole output again on every
 * printf would repeat everything printed so far.)
 */
function useNewText(output: string): string {
  const [seen, setSeen] = useState({ output, added: '' })
  if (seen.output !== output) {
    const added = output.startsWith(seen.output) ? output.slice(seen.output.length) : ''
    setSeen({ output, added })
    return added
  }
  return seen.added
}

/**
 * Everything the program printed, and the input box while scanf waits for text.
 * New text is read out by screen readers (a polite live region with only the new text).
 */
export function OutputPanel({
  machine,
  onSendInput,
  compact = false,
  title = 'Output',
  textClassName,
  scrollOnWide = false,
  className,
}: OutputPanelProps): ReactNode {
  const { output, status, inputRequest } = machine
  const newText = useNewText(output)
  const waiting = status === 'waiting-input' && inputRequest !== null

  // The newest line stays in sight (the question that scanf waits for, for example).
  const textRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const box = textRef.current
    if (box !== null) box.scrollTop = box.scrollHeight
  }, [output, waiting])
  // While the text hides lines, it fades at that edge and the keyboard can reach it.
  const edges = useScrollEdges(textRef, true, output)

  return (
    <MachinePanel
      title={title}
      compact={compact}
      scrollOnWide={scrollOnWide}
      // A wide card that scrolls keeps its end in sight: the newest line, the input box.
      scrollEndKey={scrollOnWide ? `${output.length}|${waiting}` : undefined}
      className={className}
    >
      <div className={FOCUS_RING_FOR_CHILD}>
        <div
          ref={textRef}
          data-output-box=""
          {...scrollStop(edges, title)}
          className={cx(
            'overflow-y-auto overscroll-contain focus-visible:outline-none',
            edgeFade(edges),
            textClassName,
          )}
        >
          {output === '' ? (
            <p className={cx('text-muted italic', compact ? 'text-sm' : 'text-[0.9375rem]')}>
              {NOTHING_PRINTED}
            </p>
          ) : (
            <pre
              data-output=""
              className="rounded-md bg-code-bg px-3 py-2 font-mono text-sm break-words whitespace-pre-wrap text-ink"
            >
              {output}
            </pre>
          )}
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {newText}
      </p>
      {waiting && <InputBox prompt={inputRequest.prompt} onSend={onSendInput} compact={compact} />}
    </MachinePanel>
  )
}
