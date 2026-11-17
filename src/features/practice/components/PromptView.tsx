import { useId, type ReactNode } from 'react'
import { CodeListing } from '../../../components/machine'
import { cx } from '../../../components/ui/cx'
import { RichText } from '../../../components/ui/RichText'
import { VisuallyHidden } from '../../../components/ui/VisuallyHidden'
import type { PromptBlock } from '../types'
import { HexText } from './HexText'

export interface PromptViewProps {
  prompt: readonly PromptBlock[]
  /** Draws the answer field of one row of a `trace` block. */
  renderTraceField?: (fieldId: string) => ReactNode
}

/** The question: sentences, code, small tables of registers and stack boxes, trace rows. */
export function PromptView({ prompt, renderTraceField }: PromptViewProps): ReactNode {
  return (
    <div className="grid min-w-0 gap-4">
      {prompt.map((block, index) => (
        <PromptPart key={index} block={block} renderTraceField={renderTraceField} />
      ))}
    </div>
  )
}

function PromptPart({
  block,
  renderTraceField,
}: {
  block: PromptBlock
  renderTraceField?: (fieldId: string) => ReactNode
}): ReactNode {
  switch (block.type) {
    case 'text':
      return (
        <p className="text-lg leading-relaxed text-pretty">
          <RichText text={block.text} />
        </p>
      )
    case 'code':
      return <CodePart lines={block.lines} addresses={block.addresses} />
    case 'registers':
      return <RegistersPart title={block.title} rows={block.rows} />
    case 'stack':
      return <StackPart title={block.title} rows={block.rows} />
    case 'trace':
      return <TracePart rows={block.rows} renderField={renderTraceField} />
  }
}

/* ─────────────────────────────────── code ──────────────────────────────────── */

function CodePart({
  lines,
  addresses,
}: {
  lines: readonly string[]
  addresses?: readonly string[]
}): ReactNode {
  const source = lines.join('\n')
  const withAddresses = addresses !== undefined && addresses.length > 0
  // The code is as big as the values in the tables of the question (15 px): one code size
  // in a problem. (The listing's own size is the smaller one of the stepper's panels.)
  // Long lines wrap, so a phone shows every line whole: the part cut off at the edge can be
  // the very thing the question asks about (`…, 0x100000000`, or a size in a comment).
  // Beside an address column a line must stay one row, so that code scrolls instead.
  const listing = (
    <CodeListing
      source={source}
      currentLine={null}
      label="Code of the problem"
      wrap={!withAddresses}
      className="max-h-96 min-w-0 [&_ol]:text-[0.9375rem]"
    />
  )
  if (!withAddresses) return listing
  return (
    // min-w-0: this box is an item of the question's grid. Without it, a long code line
    // (`lea eax, [r12+r12*2]` next to its address) widens the grid's column past a 360 px
    // screen; with it, the listing scrolls inside itself.
    <div className="min-w-0">
      {/* The address column is a picture of the addresses; this sentence says them. */}
      <VisuallyHidden>
        {lines
          .map((_line, index) => `Line ${index + 1} is at ${addresses[index] ?? '?'}.`)
          .join(' ')}
      </VisuallyHidden>
      <div className="flex min-w-0 items-start gap-2">
        <ol
          aria-hidden="true"
          data-code-addresses=""
          className="mt-px shrink-0 py-1.5 text-right font-mono text-[0.9375rem] leading-6 text-muted"
        >
          {lines.map((_line, index) => (
            <li key={index}>{addresses[index] ?? ''}</li>
          ))}
        </ol>
        {/* The listing takes the rest of the width. */}
        <div className="min-w-0 flex-1">{listing}</div>
      </div>
    </div>
  )
}

/* ───────────────────────────── registers and stack ───────────────────────────── */

const TITLE = 'mb-1.5 text-sm font-semibold text-muted'
/** The box around a small table. It scrolls by itself if it is ever wider than the screen. */
const TABLE_BOX = 'max-w-full overflow-x-auto rounded-lg border border-line bg-code-bg'
const ROW = 'border-line not-first:border-t'
const CELL = 'px-3 py-1.5 align-top'

function RegistersPart({
  title,
  rows,
}: {
  title?: string
  rows: readonly { name: string; value: string }[]
}): ReactNode {
  const titleId = useId()
  return (
    <div className="min-w-0">
      <p id={titleId} className={TITLE}>
        {title ?? 'Registers'}
      </p>
      <div className={cx(TABLE_BOX, 'w-fit')}>
        <table
          aria-labelledby={titleId}
          className="border-collapse text-left"
          data-prompt-registers=""
        >
          <thead className="sr-only">
            <tr>
              <th scope="col">Register</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className={ROW}>
                <th scope="row" className={cx(CELL, 'pr-1 font-mono font-semibold')}>
                  {row.name}
                </th>
                <td className={cx(CELL, 'pl-3')}>
                  <HexText text={row.value} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Marker({ marker }: { marker?: string }): ReactNode {
  if (marker === undefined || marker.trim() === '') return null
  const names = marker.split(',').map((name) => name.trim())
  return (
    <span className="inline-flex flex-wrap gap-x-2 font-mono text-sm font-semibold">
      {names.map((name) => (
        <span
          key={name}
          className={name === 'rsp' ? 'text-rsp' : name === 'rbp' ? 'text-rbp' : 'text-ink'}
        >
          ← {name}
        </span>
      ))}
    </span>
  )
}

function StackPart({
  title,
  rows,
}: {
  title?: string
  rows: readonly { address: string; value: string; marker?: string }[]
}): ReactNode {
  const titleId = useId()
  return (
    <div className="min-w-0">
      <p id={titleId} className={TITLE}>
        {title ?? 'The stack (highest address at the top)'}
      </p>
      <div className={cx(TABLE_BOX, 'w-fit')}>
        <table aria-labelledby={titleId} className="border-collapse text-left" data-prompt-stack="">
          <thead className="bg-surface-2 text-sm text-muted">
            <tr>
              <th scope="col" className="px-3 py-1 font-semibold">
                Address
              </th>
              <th scope="col" className="px-3 py-1 font-semibold">
                Value
              </th>
              <th scope="col" className="px-3 py-1">
                <VisuallyHidden>Points here</VisuallyHidden>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.address} className="border-t border-line">
                <td className={cx(CELL, 'font-mono text-muted')}>{row.address}</td>
                <td className={CELL}>
                  <HexText text={row.value} />
                </td>
                <td className={cx(CELL, 'pl-1')}>
                  <Marker marker={row.marker} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─────────────────────────────────── trace ──────────────────────────────────── */

function TracePart({
  rows,
  renderField,
}: {
  rows: readonly { step: number; text: string; fieldId: string }[]
  renderField?: (fieldId: string) => ReactNode
}): ReactNode {
  const headingId = useId()
  return (
    <div className="min-w-0">
      <p id={headingId} className="mb-2 text-sm font-semibold text-muted">
        The steps, in the order they run
      </p>
      <ol aria-labelledby={headingId} className="grid gap-2" data-prompt-trace="">
        {rows.map((row) => (
          <li
            key={`${row.step}-${row.fieldId}`}
            className="grid min-w-0 gap-x-4 gap-y-2 rounded-lg border border-line bg-surface p-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-start"
          >
            <p className="flex min-w-0 items-baseline gap-2">
              <span className="w-7 shrink-0 text-right font-semibold text-muted tabular-nums">
                <VisuallyHidden>Step </VisuallyHidden>
                {row.step}.
              </span>
              <code className="min-w-0 font-mono text-[0.9375rem] [overflow-wrap:anywhere]">
                {row.text}
              </code>
            </p>
            {renderField?.(row.fieldId)}
          </li>
        ))}
      </ol>
    </div>
  )
}
