/**
 * Waits until a value stops changing for `delay` ms, then hands over the newest one.
 *
 *   const edits = new Debouncer(300, (text) => session.setSource(text))
 *   edits.push(text)   // on every key press
 *   edits.flush()      // before Step: use the newest text now
 *
 * The page uses one for "the student stopped typing" and one for saving the program.
 */
export class Debouncer<T> {
  private readonly delay: number
  private readonly onSettle: (value: T) => void
  private pending: { handle: ReturnType<typeof setTimeout>; value: T } | null = null

  constructor(delay: number, onSettle: (value: T) => void) {
    this.delay = delay
    this.onSettle = onSettle
  }

  /** A new value: the wait starts again. */
  push(value: T): void {
    this.cancel()
    this.pending = { handle: setTimeout(() => this.flush(), this.delay), value }
  }

  /** Hand over the waiting value now. Returns false when nothing was waiting. */
  flush(): boolean {
    const pending = this.pending
    if (pending === null) return false
    this.pending = null
    clearTimeout(pending.handle)
    this.onSettle(pending.value)
    return true
  }

  /** Forget the waiting value. */
  cancel(): void {
    if (this.pending === null) return
    clearTimeout(this.pending.handle)
    this.pending = null
  }

  get waiting(): boolean {
    return this.pending !== null
  }
}
