import type { ReactNode } from 'react'
import { FormProblemView, type FormProblemViewProps } from './FormProblemView'
import TraceTableView from './TraceTableView'

/**
 * Shows any problem: the form for `view: 'form'`, the drag-and-drop trace table for
 * `view: 'trace-table'`. The Enter-key extras only apply to the form.
 */
export function ProblemView({
  onEnterLast,
  onEnterLocked,
  lastEnterHint,
  ...view
}: FormProblemViewProps): ReactNode {
  if (view.problem.view === 'trace-table') return <TraceTableView {...view} />
  return (
    <FormProblemView
      {...view}
      onEnterLast={onEnterLast}
      onEnterLocked={onEnterLocked}
      lastEnterHint={lastEnterHint}
    />
  )
}
