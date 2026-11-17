/**
 * The program of the stepper page: where it comes from, the text in the editor, typing,
 * saving it for the next visit, the examples, and the student's own programs.
 *
 *   const workspace = useWorkspaceProgram({ s, example })
 *   <CodeEditor value={workspace.code} onChange={workspace.onEdit} … />
 *   <Button onClick={() => { workspace.flushEdits(); workspace.session.step() }}>Step</Button>
 *
 * - Typing reaches the session when the student stops typing for a moment (300 ms), or at
 *   once when a control needs the newest text (`flushEdits`). The first key typed while
 *   Run is on pauses Run: the old program must not go on stepping under the new text.
 * - The program is saved for the next visit 700 ms after a change, and at once when the
 *   page goes away (a reload, a closed tab, a phone that switches apps). When the browser
 *   does not let the page save, `cannotSave` says so (the page tells the student).
 * - A program from a link (`?s=`, `?example=`) becomes the student's own on the first edit
 *   or example choice: the address goes back to plain `#/stepper` (no new history entry,
 *   no fresh start), and the program is saved with its starting state.
 * - Nothing the student wrote is thrown away. Choosing an example keeps their program
 *   aside, under its own key. So does a link: the program the student had saved is kept
 *   aside as soon as the link's program takes its place (the first edit, or an example).
 *   The Example menu brings the kept program back ("Your own program", or "Your earlier
 *   program" when the editor holds another program of the student: the two change places).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { exampleById, type ExampleProgram } from '../../examples'
import type { EmulatorOptions } from '../../emulator'
import { navigate } from '../../lib/router'
import { loadText, removeKey, saveText, storageAvailable } from '../../lib/storage'
import { Debouncer } from './debouncer'
import {
  CODE_STORAGE_KEY,
  EARLIER_PROGRAM,
  initialProgram,
  isOwnProgram,
  OPTIONS_STORAGE_KEY,
  optionsFromText,
  optionsToText,
  OWN_CODE_STORAGE_KEY,
  OWN_OPTIONS_STORAGE_KEY,
  OWN_PROGRAM,
  savedOwnProgram,
  SPEED_STORAGE_KEY,
  type ProgramQuery,
  type StoredProgram,
} from './initialProgram'
import { clampSpeed, DEFAULT_SPEED, type SessionState, type StepperSession } from './session'
import { useEmulatorSession } from './useEmulatorSession'

/** The program is read again this long after the last key press. */
const EDIT_DELAY_MS = 300
/** The program is saved for the next visit this long after the last change. */
const SAVE_DELAY_MS = 700

/**
 * The save that the workspace on the page is waiting to do (a program is saved a moment
 * after the last change). A new link opened in the same tab starts a new workspace while
 * the old one is still there: the new one does that save first, so that it reads the
 * newest program of the student, and never keeps an older one aside.
 */
let waitingSave: Debouncer<string> | null = null

function savedSpeed(): number {
  const text = loadText(SPEED_STORAGE_KEY)
  return text === null ? DEFAULT_SPEED : clampSpeed(Number(text))
}

/** Save `options` under `key` (the share-link encoding), or remove the key for none. */
function saveOptions(key: string, options: EmulatorOptions | undefined): void {
  const text = optionsToText(options)
  if (text === null) removeKey(key)
  else saveText(key, text)
}

function loadOwnProgram(): StoredProgram | null {
  const code = loadText(OWN_CODE_STORAGE_KEY)
  if (code === null || code.trim() === '') return null
  return { code, options: optionsFromText(loadText(OWN_OPTIONS_STORAGE_KEY)) }
}

/**
 * Why the student's program was just kept aside, so the page can say where it is:
 * - 'example': an example took its place (said with the example's description);
 * - 'link': the program of a link took its place; said until the student moves the
 *   machine (`moves` is the session's count of moves at that time).
 */
export type KeptNotice = { kind: 'example' } | { kind: 'link'; moves: number }

export interface WorkspaceProgram {
  state: SessionState
  session: StepperSession
  /** The newest text of the editor (it reaches the session when typing pauses). */
  code: string
  /** The note of a shared link, shown above the editor; null for none. */
  note: string | null
  /** A friendly sentence when the link could not be used; null for none. */
  notice: string | null
  dismissNotice: () => void
  /** Typing has not reached the session yet. */
  editPending: boolean
  /** The editor holds a link's program that the student has not changed. */
  linkProgram: boolean
  /** The student has another program to come back to (see `programMenu`). */
  hasOtherProgram: boolean
  /** The student's program was just kept aside (tell them where it is); null for none. */
  keptNotice: KeptNotice | null
  /** This browser does not let the page save the program (blocked or full storage). */
  cannotSave: boolean
  /** The student typed: the new text of the editor. */
  onEdit: (text: string) => void
  /** Give the session the text that is still waiting (before Step, Run, a breakpoint, …). */
  flushEdits: () => void
  /**
   * Load an example by id, or the student's other program (`OWN_PROGRAM`,
   * `EARLIER_PROGRAM`).
   */
  chooseExample: (id: string) => void
  /** The newest program and its starting state, for a share link. */
  getProgram: () => StoredProgram
  /** Save the speed of Run for the next visit and give it to the session. */
  changeSpeed: (speed: number) => void
}

export function useWorkspaceProgram({ s, example }: ProgramQuery): WorkspaceProgram {
  const linked = s !== null || example !== null
  const [initial] = useState(() => {
    waitingSave?.flush()
    const saved = loadText(CODE_STORAGE_KEY)
    const savedOptions = loadText(OPTIONS_STORAGE_KEY)
    const program = initialProgram({ s, example }, saved, savedOptions)
    return {
      ...program,
      // A damaged link opens the saved program itself: that one is the student's already.
      fromLink: linked && program.code !== saved,
      // The program the student had before the link, kept aside once the link's program
      // takes its place for good. Nothing is written while the link's program is unchanged.
      savedOwn: linked ? savedOwnProgram(saved, savedOptions, program.code) : null,
    }
  })
  const { state, session } = useEmulatorSession(() => ({
    source: initial.code,
    options: initial.options,
    speed: savedSpeed(),
  }))
  const [code, setCode] = useState(initial.code)
  const [note, setNote] = useState(initial.note)
  const [notice, setNotice] = useState(initial.notice)
  const [editPending, setEditPending] = useState(false)
  const [keptNotice, setKeptNotice] = useState<KeptNotice | null>(null)
  // The newest text, for callbacks that must not change on every key (the share link).
  const codeRef = useRef(initial.code)
  // The address still holds the link (it goes back to plain #/stepper on the first change).
  const addressHasLink = useRef(linked)
  // The editor holds the link's program, and the student has not changed it yet.
  const [linkProgram, setLinkProgram] = useState(initial.fromLink)
  // The student's program kept aside. Kept in memory too: that works when storage is blocked.
  const [kept, setKept] = useState(loadOwnProgram)
  const [cannotSave, setCannotSave] = useState(() => !storageAvailable())

  const [edits] = useState(
    () =>
      new Debouncer<string>(EDIT_DELAY_MS, (text) => {
        session.setSource(text)
        setEditPending(false)
      }),
  )
  const [saves] = useState(
    () =>
      new Debouncer<string>(SAVE_DELAY_MS, (text) => {
        // Blocked storage, or a full disk: the student must hear that the program is not saved.
        if (!saveText(CODE_STORAGE_KEY, text)) setCannotSave(true)
        saveOptions(OPTIONS_STORAGE_KEY, session.getOptions())
      }),
  )

  // Leaving the page: nothing waits any more, and the newest program is saved at once.
  useEffect(() => {
    waitingSave = saves
    return () => {
      edits.cancel()
      saves.flush()
      if (waitingSave === saves) waitingSave = null
    }
  }, [edits, saves])
  // Closing or reloading the tab, or switching to another app on a phone, does not unmount
  // the page: save the newest program then too, so the last keys typed are never lost.
  useEffect(() => {
    const save = () => {
      saves.flush()
    }
    const saveWhenHidden = () => {
      if (document.visibilityState === 'hidden') saves.flush()
    }
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', saveWhenHidden)
    return () => {
      window.removeEventListener('pagehide', save)
      document.removeEventListener('visibilitychange', saveWhenHidden)
    }
  }, [saves])

  /** The program in the editor is the student's now: the address no longer holds the link. */
  const leaveLink = useCallback(() => {
    setLinkProgram(false)
    if (!addressHasLink.current) return
    addressHasLink.current = false
    navigate('/stepper', { replace: true })
  }, [])

  /** Keep a program of the student aside: "Your own program" in the menu brings it back. */
  const keepAside = useCallback((program: StoredProgram) => {
    saveText(OWN_CODE_STORAGE_KEY, program.code)
    saveOptions(OWN_OPTIONS_STORAGE_KEY, program.options)
    setKept(program)
  }, [])

  const onEdit = useCallback(
    (text: string) => {
      // Run must not go on with the old program while the new one is being typed.
      if (session.getState().playing) session.pause()
      // The first change makes the link's program the student's own: the program they had
      // saved before goes aside (else the next save would write over it).
      if (linkProgram && initial.savedOwn !== null) {
        keepAside(initial.savedOwn)
        setKeptNotice({ kind: 'link', moves: session.getState().moves })
      } else {
        setKeptNotice((now) => (now?.kind === 'example' ? null : now))
      }
      codeRef.current = text
      setCode(text)
      setEditPending(true)
      edits.push(text)
      saves.push(text)
      leaveLink()
    },
    [session, edits, saves, leaveLink, keepAside, linkProgram, initial.savedOwn],
  )

  const flushEdits = useCallback(() => {
    edits.flush()
  }, [edits])

  /** Put a program in the editor and in the session, as a fresh start. */
  const loadProgram = useCallback(
    (source: string, options: EmulatorOptions | undefined) => {
      edits.cancel()
      setEditPending(false)
      codeRef.current = source
      setCode(source)
      session.load(source, options)
      setNote(null)
      setNotice(null)
      saves.push(source)
      leaveLink()
    },
    [edits, saves, session, leaveLink],
  )

  // The other program of the student: while the editor holds a link's unchanged program,
  // the one they had before the link; else the one kept aside. Never the program in the
  // editor itself.
  const candidate = linkProgram ? (initial.savedOwn ?? kept) : kept
  const otherProgram = candidate !== null && candidate.code !== code ? candidate : null

  const chooseExample = useCallback(
    (id: string) => {
      const current = codeRef.current
      // The program in the editor is the student's own (not an example, not a link's).
      const currentIsOwn = !linkProgram && isOwnProgram(current)
      if (id === OWN_PROGRAM || id === EARLIER_PROGRAM) {
        if (otherProgram === null) return
        // The two programs change places, so neither is lost.
        if (currentIsOwn) keepAside({ code: current, options: session.getOptions() })
        setKeptNotice(null)
        loadProgram(otherProgram.code, otherProgram.options)
        return
      }
      const chosen: ExampleProgram | undefined = exampleById(id)
      if (chosen === undefined) return
      const keep = currentIsOwn
        ? { code: current, options: session.getOptions() }
        : linkProgram
          ? initial.savedOwn
          : null
      if (keep !== null) keepAside(keep)
      setKeptNotice(keep !== null ? { kind: 'example' } : null)
      loadProgram(chosen.source, undefined)
    },
    [session, loadProgram, keepAside, linkProgram, otherProgram, initial.savedOwn],
  )

  const getProgram = useCallback(
    () => ({ code: codeRef.current, options: session.getOptions() }),
    [session],
  )

  const changeSpeed = useCallback(
    (speed: number) => {
      session.setSpeed(speed)
      saveText(SPEED_STORAGE_KEY, String(clampSpeed(speed)))
    },
    [session],
  )

  const dismissNotice = useCallback(() => setNotice(null), [])

  // The note about a link's program goes away once the student moves the machine.
  const shownKeptNotice =
    keptNotice?.kind === 'link' && keptNotice.moves !== state.moves ? null : keptNotice

  return {
    state,
    session,
    code,
    note,
    notice,
    dismissNotice,
    editPending,
    linkProgram,
    hasOtherProgram: otherProgram !== null,
    keptNotice: shownKeptNotice,
    cannotSave,
    onEdit,
    flushEdits,
    chooseExample,
    getProgram,
    changeSpeed,
  }
}
