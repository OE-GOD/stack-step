/**
 * The fourteen lessons, in the order the course teaches them.
 *
 * Only the list lives here (id, number, title, one-sentence summary), so that the Learn
 * page, the progress page and the practice topics can all name a lesson without loading
 * its content.
 *
 * `title` is plain text. `summary` says what the student will be able to do; it may hold
 * code in backticks, so show it with <RichText> (src/components/ui/RichText).
 */
export const LESSONS = [
  {
    id: 'registers-and-memory',
    number: 1,
    title: 'Registers are your hands, memory is the fridge',
    summary: 'Say what a register is, what memory is, and why a program needs both.',
  },
  {
    id: 'register-names',
    number: 2,
    title: 'One register, many names',
    summary:
      'Read a name such as `rax`, `eax`, `ax` or `al` and say which part of the register it means.',
  },
  {
    id: 'partial-writes',
    number: 3,
    title: 'Writing part of a register',
    summary: 'Predict what the whole register holds after you write to one part of it.',
  },
  {
    id: 'line-format',
    number: 4,
    title: 'Directives, labels and comments',
    summary:
      'Look at any line of a program and name its parts: the directive, the label, the instruction and the comment.',
  },
  {
    id: 'mov',
    number: 5,
    title: 'mov: copy a value',
    summary: 'Use `mov` to copy a value, and say which forms of `mov` are not allowed.',
  },
  {
    id: 'stack-and-rsp',
    number: 6,
    title: 'The stack and rsp',
    summary: 'Follow rsp while `push` adds a box to the stack and `pop` removes a box.',
  },
  {
    id: 'rip-cycle',
    number: 7,
    title: 'rip and the fetch, move, run cycle',
    summary: 'Say which address rip holds at each moment while one instruction runs.',
  },
  {
    id: 'call-and-ret',
    number: 8,
    title: 'call and ret',
    summary:
      'Explain how `call` saves a return address on the stack and how `ret` uses it to go back.',
  },
  {
    id: 'add-sub-flags',
    number: 9,
    title: 'add, sub and the flags',
    summary: 'Find the result of `add` and `sub`, and say what each of the four flags holds.',
  },
  {
    id: 'indirect-addressing',
    number: 10,
    title: 'Indirect addressing',
    summary: 'Read an operand such as `[rbp-8]` and find the memory address it means.',
  },
  {
    id: 'lea-vs-mov',
    number: 11,
    title: 'lea vs. mov',
    summary: '`lea` gives you an address, and `mov` gives you the contents stored at that address.',
  },
  {
    id: 'local-variables',
    number: 12,
    title: 'Local variables and rbp',
    summary: 'Find the local variables of a function on the stack by their distance from rbp.',
  },
  {
    id: 'loops-and-ifs',
    number: 13,
    title: 'Loops and ifs',
    summary: 'Read `cmp` and a jump together, and follow a loop or an if in assembly.',
  },
  {
    id: 'calling-convention',
    number: 14,
    title: 'The calling convention',
    summary:
      'Say which registers hold the arguments and the result of a function, and which registers a call may change.',
  },
] as const satisfies readonly { id: string; number: number; title: string; summary: string }[]

export type Lesson = (typeof LESSONS)[number]
export type LessonId = Lesson['id']

export function isLessonId(value: string): value is LessonId {
  return LESSONS.some((lesson) => lesson.id === value)
}

/** The list entry of one lesson. */
export function lessonById(id: LessonId): Lesson {
  const found = LESSONS.find((lesson) => lesson.id === id)
  if (!found) throw new Error(`Unknown lesson id: ${String(id)}`)
  return found
}
