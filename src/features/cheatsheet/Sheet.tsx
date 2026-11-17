import { createContext, Fragment, useContext, type ReactNode } from 'react'
import { Panel } from '../../components/ui/Panel'
import { RichText } from '../../components/ui/RichText'
import {
  OPERAND_KINDS,
  sectionById,
  SHEET,
  type Block,
  type JumpRow,
  type MovForm,
  type OperandKind,
  type Pair,
  type RegisterRow,
  type SheetSection,
} from './content'
import { CARD_LAYOUT, LETTER_LAYOUT } from './layout'

/* ───────────────────────────── Text with code ───────────────────────────── */

/**
 * True inside the two printed renditions. There, code is a bare <code> element that only
 * cheatsheet.css styles: the printed card is fitted to the paper line by line, so its
 * look must not change when the site's own inline code changes.
 */
const PrintedContext = createContext(false)

/** A line of the sheet: the parts in backticks are code. */
function Text({ text }: { text: string }): ReactNode {
  const printed = useContext(PrintedContext)
  if (!printed) return <RichText text={text} />
  // After the split, the parts at odd positions are code.
  return text
    .split('`')
    .map((part, index) =>
      part === '' ? null : index % 2 === 1 ? (
        <code key={index}>{part}</code>
      ) : (
        <Fragment key={index}>{part}</Fragment>
      ),
    )
}

/* ───────────────────────────── The blocks ───────────────────────────── */

/**
 * The register names by size.
 *
 * `cs-long` marks words that are shown where there is room (on screen and on the letter
 * page) and left out on the index card. Here the card drops the word "bits" from the
 * column heads: its section heading carries the word instead.
 */
function RegisterTable({ rows }: { rows: readonly RegisterRow[] }): ReactNode {
  return (
    <table className="cs-table cs-registers">
      <thead>
        <tr>
          {[64, 32, 16, 8].map((size) => (
            <th key={size} scope="col">
              {size}
              <span className="cs-long"> bits</span>
            </th>
          ))}
          <th scope="col">
            <span className="cs-long">bits </span>15–8
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.base}>
            <th scope="row">{row.names[0]}</th>
            {row.names.slice(1).map((name) => (
              <td key={name}>{name}</td>
            ))}
            <td>{row.highByte}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Lines({ lines }: { lines: readonly string[] }): ReactNode {
  return (
    <div className="cs-lines">
      {lines.map((line) => (
        <p key={line}>
          <Text text={line} />
        </p>
      ))}
    </div>
  )
}

function Pairs({ rows }: { rows: readonly Pair[] }): ReactNode {
  return (
    <dl className="cs-pairs">
      {rows.map(([term, meaning]) => (
        <div key={term} className="cs-pair">
          <dt>
            <Text text={term} />
          </dt>{' '}
          <dd>
            <Text text={meaning} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** "register" in full, or "reg" on the index card. The short form is the start of the word. */
function KindHead({ kind }: { kind: OperandKind }): ReactNode {
  return (
    <>
      {kind.slice(0, 3)}
      <span className="cs-long">{kind.slice(3)}</span>
    </>
  )
}

/**
 * Destination (rows) against source (columns): is this form of `mov` legal?
 * Under the table: the line for the form that is legal only with a size.
 *
 * The corner says "dest ← src". On the index card it moves to the heading line (the
 * section's `note`), so that the words "legal" and "illegal" fit the narrow column.
 */
function MovGrid({ forms }: { forms: readonly MovForm[] }): ReactNode {
  const cell = (dest: OperandKind, src: OperandKind): ReactNode => {
    const form = forms.find((candidate) => candidate.dest === dest && candidate.src === src)
    if (form === undefined) return null
    // The same two words on the screen, on the card and on the letter page: the practice
    // topic is "Legal or illegal mov?".
    return (
      <td key={src} className={form.legal ? 'cs-legal' : 'cs-illegal'}>
        {form.legal ? 'legal' : 'illegal'}
        {form.needsSize && '*'}
      </td>
    )
  }
  const sized = forms.filter((form) => form.needsSize)
  return (
    <div className="cs-mov-forms">
      <table className="cs-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="cs-corner">dest ← src</span>
            </th>
            {OPERAND_KINDS.map((src) => (
              <th key={src} scope="col">
                <KindHead kind={src} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {OPERAND_KINDS.map((dest) => (
            <tr key={dest}>
              <th scope="row">{dest}</th>
              {OPERAND_KINDS.map((src) => cell(dest, src))}
            </tr>
          ))}
        </tbody>
      </table>
      {sized.map((form) => (
        <p key={form.example} className="cs-legend">
          * needs a size: <Text text={`\`${form.example}\``} />
        </p>
      ))}
    </div>
  )
}

function JumpTable({ rows }: { rows: readonly JumpRow[] }): ReactNode {
  return (
    <table className="cs-table cs-jumps">
      <thead>
        <tr>
          <th scope="col">
            <span className="cs-long">after </span>
            <code>cmp a, b</code>
          </th>
          <th scope="col">signed</th>
          <th scope="col">unsigned</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.formula}>
            <th scope="row">
              <code>{row.formula}</code>
            </th>
            <td>
              <code>{row.signed}</code>
            </td>
            <td>
              <code>{row.unsigned}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** `…00 → f8 → f0 → … → 78 → …`: each step is 8 less than the one before it. */
function Ladder({ steps }: { steps: readonly string[] }): ReactNode {
  return (
    <ol className="cs-ladder">
      {steps.map((step, index) => (
        <li key={step}>
          {index > 0 && <span aria-hidden="true">→</span>}
          <code>{index === 0 ? `…${step}` : step}</code>
        </li>
      ))}
      <li aria-hidden="true">
        <span>→</span>
        <code>…</code>
      </li>
    </ol>
  )
}

function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case 'registers':
      return <RegisterTable rows={block.rows} />
    case 'lines':
      return <Lines lines={block.lines} />
    case 'pairs':
      return <Pairs rows={block.rows} />
    case 'mov-forms':
      return <MovGrid forms={block.forms} />
    case 'jumps':
      return <JumpTable rows={block.rows} />
    case 'ladder':
      return <Ladder steps={block.steps} />
  }
}

function SectionBody({ section }: { section: SheetSection }): ReactNode {
  return (
    <div className="cs-body">
      {section.blocks.map((block, index) => (
        // The blocks of a section never change places, so the position is a safe key.
        <BlockView key={index} block={block} />
      ))}
    </div>
  )
}

/* ─────────────────────────── The three renditions ─────────────────────────── */

/** The sheet on screen: one card per section, in one or two columns. */
export function ScreenSheet(): ReactNode {
  return (
    <div className="cs-sheet cs-screen">
      {SHEET.map((section) => (
        <Panel key={section.id} title={section.title} className={`cs-sec cs-sec--${section.id}`}>
          <SectionBody section={section} />
        </Panel>
      ))}
    </div>
  )
}

function PrintSection({ section }: { section: SheetSection }): ReactNode {
  return (
    <section className={`cs-sec cs-sec--${section.id}`}>
      <h2 className="cs-h">
        {section.title}
        {section.note !== undefined && <span className="cs-note">{section.note}</span>}
      </h2>
      <SectionBody section={section} />
    </section>
  )
}

export interface PrintSheetProps {
  /** `card`: the 3×5 inch index card. `letter`: the full letter page. */
  variant: 'card' | 'letter'
}

/**
 * The sheet as it prints. The index card is also the true-size preview on screen, so
 * what the student sees there is what the printer gets.
 */
export function PrintSheet({ variant }: PrintSheetProps): ReactNode {
  const layout = variant === 'card' ? CARD_LAYOUT : LETTER_LAYOUT
  return (
    <PrintedContext value={true}>
      <div className={`cs-sheet cs-printed cs-${variant}`}>
        {variant === 'letter' && (
          // Not a heading: the page keeps its one <h1>.
          <p className="cs-title">
            <span>x86-64 cheat sheet</span>
            <span className="cs-title-note">Stack Step · Intel syntax</span>
          </p>
        )}
        <div className="cs-cols">
          {layout.columns.map((ids) => (
            <div key={ids.join(' ')} className="cs-col">
              {ids.map((id) => (
                <PrintSection key={id} section={sectionById(id)} />
              ))}
            </div>
          ))}
        </div>
        {layout.footer.length > 0 && (
          <div className="cs-foot">
            {layout.footer.map((id) => (
              <PrintSection key={id} section={sectionById(id)} />
            ))}
          </div>
        )}
      </div>
    </PrintedContext>
  )
}
