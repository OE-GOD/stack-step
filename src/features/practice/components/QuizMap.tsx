import { useId, type ReactNode } from 'react'
import { cx } from '../../../components/ui/cx'
import { CheckIcon } from '../../../components/ui/icons'
import { isBlank, type QuizAnswers, type QuizQuestion } from '../session'

export interface QuizMapProps {
  questions: readonly QuizQuestion[]
  answers: QuizAnswers
  /** The question on the screen (0-based). */
  index: number
  onGo: (index: number) => void
}

/**
 * One button per question of the quiz, to jump straight to it. Each says, by a shape and
 * not by color alone, whether the question has an answer: a check mark and a solid edge,
 * or a dash and a dashed edge. The question on the screen has a thick ring.
 */
export function QuizMap({ questions, answers, index, onGo }: QuizMapProps): ReactNode {
  const helpId = useId()
  return (
    <nav aria-label="All questions" aria-describedby={helpId} data-quiz-map="">
      <p id={helpId} className="text-sm text-muted">
        Go to any question. A check mark means it has an answer. A dash means it has none yet.
      </p>
      <ol className="mt-2 flex flex-wrap gap-1.5">
        {questions.map((question, position) => {
          const answered = !isBlank(answers[question.number])
          const current = position === index
          return (
            <li key={question.number}>
              <button
                type="button"
                onClick={() => onGo(position)}
                aria-current={current ? 'step' : undefined}
                aria-label={`Question ${question.number}: ${answered ? 'answered' : 'no answer yet'}`}
                data-quiz-go={question.number}
                data-answered={answered ? 'yes' : 'no'}
                className={cx(
                  'flex size-11 flex-col items-center justify-center rounded-lg border text-sm leading-none font-semibold tabular-nums',
                  answered
                    ? 'border-line-strong bg-surface text-ink'
                    : 'border-dashed border-line-strong bg-surface-2 text-muted',
                  current && 'border-primary ring-2 ring-primary',
                )}
              >
                <span>{question.number}</span>
                {answered ? (
                  <CheckIcon size={12} className="mt-0.5 text-good" />
                ) : (
                  <span aria-hidden="true" className="text-sm leading-none">
                    –
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
