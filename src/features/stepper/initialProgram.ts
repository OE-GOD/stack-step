/**
 * Which program the stepper page opens with. In this order:
 *
 *   1. `?s=<payload>`      a shared link (code, starting state, note)
 *   2. `?example=<id>`     one of the ready-made examples
 *   3. the program the student edited last (saved in localStorage, with its starting
 *      state when it came from a practice link)
 *   4. the Hello World example
 *
 * A link that cannot be read is not an error page: the student gets a friendly notice
 * and the next program in the list. Pure: the saved texts are passed in.
 */
import type { EmulatorOptions } from '../../emulator'
import { EXAMPLES, exampleById, type ExampleProgram } from '../../examples'
import { decodePayload, encodePayload } from '../../lib/share'
import { STORAGE_PREFIX } from '../../lib/storage'

/** Where the page keeps the last program the student edited. */
export const CODE_STORAGE_KEY = `${STORAGE_PREFIX}stepper:code`
/**
 * Where the page keeps the starting state of that program (the registers and memory of a
 * practice problem). Missing when the program starts from the usual state.
 */
export const OPTIONS_STORAGE_KEY = `${STORAGE_PREFIX}stepper:options`
/** Where the page keeps the auto-play speed. */
export const SPEED_STORAGE_KEY = `${STORAGE_PREFIX}stepper:speed`
/**
 * Where the page keeps the student's own program while an example is loaded over it, so
 * "Your own program" in the Example menu can bring it back (also after a reload).
 */
export const OWN_CODE_STORAGE_KEY = `${STORAGE_PREFIX}stepper:own`
/** The starting state of that program (see `optionsToText`). Missing for the usual state. */
export const OWN_OPTIONS_STORAGE_KEY = `${STORAGE_PREFIX}stepper:own-options`
/** 'off' when the student switched the single-key shortcuts (S, B, R, 0) off. */
export const SINGLE_KEYS_STORAGE_KEY = `${STORAGE_PREFIX}stepper:single-keys`

/**
 * A link's note is cut to this many characters. Real notes are one sentence; a crafted
 * link with a very long note could push the code off the screen.
 */
export const MAX_NOTE_LENGTH = 300

/** The note as it is shown: without space around it, cut with "…" when it is too long. */
export function shortNote(note: string): string {
  const text = note.trim()
  if (text.length <= MAX_NOTE_LENGTH) return text
  return `${text.slice(0, MAX_NOTE_LENGTH - 1).trimEnd()}…`
}

/** The starting state as text for storage (the share-link encoding), or null for none. */
export function optionsToText(options: EmulatorOptions | undefined): string | null {
  return options === undefined ? null : encodePayload({ code: '', options })
}

/** The starting state saved by `optionsToText`; undefined when there is none or it is broken. */
export function optionsFromText(text: string | null): EmulatorOptions | undefined {
  if (text === null || text === '') return undefined
  return decodePayload(text)?.options
}

const DEFAULT_EXAMPLE_ID = 'hello-world'

/** A program and the starting state it runs with. */
export interface StoredProgram {
  code: string
  options: EmulatorOptions | undefined
}

/** The value of "Your own program" in the Example menu. */
export const OWN_PROGRAM = 'own'
/**
 * The value of "Your earlier program" in the Example menu: the student's other program,
 * kept aside, while the editor holds one of their own programs too.
 */
export const EARLIER_PROGRAM = 'earlier'
/** The value of "Program from the link" in the Example menu (a link's program, not changed). */
export const LINK_PROGRAM = 'link'

export interface InitialProgram {
  code: string
  /** The starting state from a shared link (practice problems). */
  options?: EmulatorOptions
  /** The note of a shared link, shown above the editor. */
  note: string | null
  /** A friendly sentence when the link could not be used. */
  notice: string | null
}

export interface ProgramQuery {
  /** The value of `?s=`, or null. */
  s: string | null
  /** The value of `?example=`, or null. */
  example: string | null
}

function defaultExample(): ExampleProgram {
  return exampleById(DEFAULT_EXAMPLE_ID) ?? EXAMPLES[0]
}

/**
 * The program to open, and a notice when the link asked for something that is not there.
 * `saved` is the last program; `savedOptions` its starting state (see `optionsToText`).
 */
export function initialProgram(
  query: ProgramQuery,
  saved: string | null,
  savedOptions: string | null = null,
): InitialProgram {
  let problem: string | null = null

  if (query.s !== null) {
    const payload = decodePayload(query.s)
    if (payload !== null) {
      return {
        code: payload.code,
        ...(payload.options === undefined ? {} : { options: payload.options }),
        note:
          payload.note !== undefined && payload.note.trim() !== '' ? shortNote(payload.note) : null,
        notice: null,
      }
    }
    problem = 'This link is damaged, so its program could not be opened.'
  }

  if (query.example !== null) {
    const example = exampleById(query.example)
    if (example !== undefined) {
      const notice = problem === null ? null : `${problem} Here is the example “${example.title}”.`
      return { code: example.source, note: null, notice }
    }
    problem ??= 'This link asks for an example that does not exist.'
  }

  const useSaved = saved !== null && saved.trim() !== ''
  const code = useSaved ? saved : defaultExample().source
  const instead = useSaved ? 'Here is your last program.' : 'Here is the Hello World example.'
  const options = useSaved ? optionsFromText(savedOptions) : undefined
  return {
    code,
    ...(options === undefined ? {} : { options }),
    note: null,
    notice: problem === null ? null : `${problem} ${instead}`,
  }
}

/** The example whose program is exactly `code`, if there is one. */
export function exampleWithSource(code: string): ExampleProgram | undefined {
  return EXAMPLES.find((example) => example.source === code)
}

/** True for a program the student wrote: not empty, and not one of the examples. */
export function isOwnProgram(code: string): boolean {
  return code.trim() !== '' && exampleWithSource(code) === undefined
}

/**
 * The student's own program that the page had saved, when a link opens another program:
 * null when there is none, or when it is an example or the link's own program. The page
 * keeps it aside (see `OWN_CODE_STORAGE_KEY`) as soon as the link's program takes its
 * place for good (the first edit, or another example).
 */
export function savedOwnProgram(
  saved: string | null,
  savedOptions: string | null,
  linkCode: string,
): StoredProgram | null {
  if (saved === null || !isOwnProgram(saved) || saved === linkCode) return null
  return { code: saved, options: optionsFromText(savedOptions) }
}

/** One choice of the Example menu that is not an example. */
export interface MenuChoice {
  value: string
  label: string
}

const OWN_CHOICE: MenuChoice = { value: OWN_PROGRAM, label: 'Your own program' }
const EARLIER_CHOICE: MenuChoice = { value: EARLIER_PROGRAM, label: 'Your earlier program' }
const LINK_CHOICE: MenuChoice = { value: LINK_PROGRAM, label: 'Program from the link' }

/**
 * What the Example menu shows for the program in the editor, above the examples:
 *
 * - an example: its title is chosen; "Your own program" brings the student's program back;
 * - the program of a link that the student has not changed: "Program from the link" is
 *   chosen; "Your own program" brings back the program the student had before;
 * - the student's own program: "Your own program" is chosen; "Your earlier program"
 *   brings back the other one (the two change places, so neither is lost).
 *
 * `hasOther`: the student has another program to come back to.
 */
export function programMenu({
  source,
  linkProgram,
  hasOther,
}: {
  source: string
  linkProgram: boolean
  hasOther: boolean
}): { value: string; choices: MenuChoice[] } {
  const example = exampleWithSource(source)
  if (example !== undefined) return { value: example.id, choices: hasOther ? [OWN_CHOICE] : [] }
  if (linkProgram) {
    return { value: LINK_PROGRAM, choices: hasOther ? [LINK_CHOICE, OWN_CHOICE] : [LINK_CHOICE] }
  }
  return { value: OWN_PROGRAM, choices: hasOther ? [OWN_CHOICE, EARLIER_CHOICE] : [OWN_CHOICE] }
}
