import { useId, type ReactNode } from 'react'
import { MiniStepper } from '../../../components/ministepper/MiniStepper'
import { Callout } from '../../../components/ui/Callout'
import { cx } from '../../../components/ui/cx'
import { RichText } from '../../../components/ui/RichText'
import type { LessonContent } from '../types'
import { CheckQuestion } from './CheckQuestion'
import { COLUMN } from './layout'

interface SectionProps {
  title: string
  /** The heading and the first lines stay in the reading column; `wide` content does not. */
  children: ReactNode
  wide?: ReactNode
}

function Section({ title, children, wide }: SectionProps): ReactNode {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="mt-12 md:mt-14">
      <div className={COLUMN}>
        <h2 id={headingId} className="text-2xl leading-tight font-extrabold tracking-tight">
          {title}
        </h2>
        {children}
      </div>
      {wide}
    </section>
  )
}

export interface LessonArticleProps {
  content: LessonContent
  /** Called after every right answer to the check question. */
  onRight: () => void
  /** Shown under the feedback after a right answer. */
  afterRight?: ReactNode
}

/**
 * Everything a lesson file holds, in the order the student meets it: the idea, the
 * analogy, the explanation, the live example with what to watch for, the check question
 * and the lines to remember.
 */
export function LessonArticle({ content, onRight, afterRight }: LessonArticleProps): ReactNode {
  const { idea, analogy, body, example, check, recap } = content
  return (
    <>
      <div className={COLUMN}>
        <p data-lesson-idea="" className="text-xl leading-relaxed text-pretty md:text-[1.375rem]">
          <RichText text={idea} />
        </p>
        <Callout tone="analogy" className="mt-6">
          <p className="font-semibold">
            <RichText text={analogy.title} />
          </p>
          <p className="text-pretty">
            <RichText text={analogy.text} />
          </p>
        </Callout>
        <div className="prose mt-8 max-w-none">{body}</div>
      </div>

      <Section
        title="Try it"
        wide={
          // "Watch for" comes first: on a phone the example is taller than the screen, so a
          // list below it would never be in view while the student steps. On a wide screen
          // the list stands to the right of the example.
          <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="rounded-xl border border-line bg-surface p-4 shadow-xs lg:col-start-2 lg:row-start-1">
              <h3 className="font-semibold">Watch for</h3>
              <ul className="mt-2 list-disc space-y-2 pl-5 text-pretty marker:text-muted">
                {example.watchFor.map((item, index) => (
                  <li key={index}>
                    <RichText text={item} />
                  </li>
                ))}
              </ul>
            </div>
            <div className="min-w-0 lg:col-start-1 lg:row-start-1">
              <MiniStepper {...example.stepper} />
            </div>
          </div>
        }
      >
        <p className="mt-3 text-lg text-pretty">
          <RichText text={example.intro} />
        </p>
      </Section>

      <Section title="Check yourself">
        <div className="mt-4 rounded-2xl border border-line bg-surface p-4 shadow-xs sm:p-6">
          <CheckQuestion question={check} onRight={onRight} afterRight={afterRight} />
        </div>
      </Section>

      <Section title="Remember">
        <ul
          className={cx(
            'mt-4 list-disc space-y-2 rounded-2xl border border-line bg-surface py-4 pr-4 pl-9 shadow-xs sm:py-5 sm:pr-6',
            'text-pretty marker:text-primary',
          )}
        >
          {recap.map((line, index) => (
            <li key={index}>
              <RichText text={line} />
            </li>
          ))}
        </ul>
      </Section>
    </>
  )
}
