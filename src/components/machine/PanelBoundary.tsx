import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Panel } from '../ui/Panel'
import { CANNOT_SHOW_EXAMPLE, CANNOT_SHOW_PART } from './words'

export interface PanelBoundaryProps {
  /** The name of the part, for the heading of the message ("Stack"). */
  title: string
  /** When this changes (the next step, another program), the part is tried again. */
  resetKey?: unknown
  /** Inside the MiniStepper: a light box instead of a card with a heading. */
  compact?: boolean
  children: ReactNode
}

interface PanelBoundaryState {
  failed: boolean
  /** The `resetKey` the boundary saw last. */
  key: unknown
}

/**
 * Catches a crash inside one part of the stepper (a panel, or a whole MiniStepper in a
 * lesson) and shows a calm message in its place, so everything around it keeps working:
 * the code, the controls, the other panels. The part is tried again as soon as
 * `resetKey` changes, for example on the next step.
 */
export class PanelBoundary extends Component<PanelBoundaryProps, PanelBoundaryState> {
  override state: PanelBoundaryState = { failed: false, key: this.props.resetKey }

  static getDerivedStateFromError(): Partial<PanelBoundaryState> {
    return { failed: true }
  }

  static getDerivedStateFromProps(
    props: PanelBoundaryProps,
    state: PanelBoundaryState,
  ): Partial<PanelBoundaryState> | null {
    return Object.is(props.resetKey, state.key) ? null : { failed: false, key: props.resetKey }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the details for whoever opens the browser console.
    console.error(`Stack Step could not show "${this.props.title}".`, error, info.componentStack)
  }

  override render(): ReactNode {
    const { failed } = this.state
    const { title, compact = false, children } = this.props
    if (!failed) return children
    if (compact) {
      return (
        <div role="note" className="rounded-lg border border-line bg-surface-2 px-3 py-2">
          <p className="text-sm text-muted">{CANNOT_SHOW_EXAMPLE}</p>
        </div>
      )
    }
    return (
      <Panel title={title}>
        <p className="text-sm text-muted">{CANNOT_SHOW_PART}</p>
      </Panel>
    )
  }
}
