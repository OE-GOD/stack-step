/**
 * The React face of a `StepperSession`.
 *
 *   const { state, session } = useEmulatorSession(() => ({ source: example.source }))
 *   <Button onClick={() => session.step()}>Step</Button>
 *
 * The session is made once, on the first render (the init function is not called again),
 * and its timers are stopped when the component goes away. A component re-renders when
 * the session's state changes; `state` is the same object until then.
 *
 * To run a different program, call `session.load(…)` or `session.setSource(…)`, or give
 * the component a new `key`.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { StepperSession, type SessionInit, type SessionState } from './session'

export interface EmulatorSessionHandle {
  state: SessionState
  session: StepperSession
}

export function useEmulatorSession(init: SessionInit | (() => SessionInit)): EmulatorSessionHandle {
  const [session] = useState(() => new StepperSession(typeof init === 'function' ? init() : init))
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState)
  // Stop auto-play when the component goes away. Under StrictMode React runs this
  // cleanup once right after the first mount too: `dispose` only stops the timers, so
  // the session keeps working.
  useEffect(() => () => session.dispose(), [session])
  return { state, session }
}
