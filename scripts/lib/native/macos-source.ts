/**
 * Rewriting a program for the macOS assembler (clang, Mach-O).
 *
 * The emulator reads programs the way gcc writes them for Linux. macOS needs a few
 * mechanical changes that do not change what the program does:
 *
 *   - C names get a leading underscore: `main` → `_main`, `call printf@PLT` → `call _printf`
 *   - ELF-only directives are removed (`.type`, `.size`, …); section names are translated
 *   - a label that is used ONLY as a jump target becomes an assembler-local label
 *     (`loop_end` → `Lss_loop_end`). clang gives a jump to an ordinary label the long
 *     5- or 6-byte encoding, because on macOS every ordinary label starts a new linker
 *     unit. With a local label the jump gets the same short encoding as on Linux, so
 *     instruction addresses can be compared with the emulator's.
 *   - any other label that starts with `l` or `L` gets the prefix `ss_`: macOS treats
 *     such names as private and would drop them from the finished program
 *   - `movsx r64, r/m32` is spelled `movsxd` (clang does not accept the other spelling)
 */

const IDENTIFIER = /[A-Za-z_.$][A-Za-z0-9_.$]*/g
const LABEL_AT_START = /^\s*([A-Za-z_.$][A-Za-z0-9_.$]*)\s*:/

/** Directives that have no meaning on macOS and no effect in the emulator. */
const DROPPED_DIRECTIVES = new Set([
  '.type',
  '.size',
  '.weak',
  '.local',
  '.loc',
  '.file',
  '.ident',
  '.addrsig',
  '.addrsig_sym',
  '.align',
  '.p2align',
  '.balign',
])

const REGISTERS_32 = new Set([
  'eax',
  'ebx',
  'ecx',
  'edx',
  'esi',
  'edi',
  'ebp',
  'esp',
  ...Array.from({ length: 8 }, (_unused, n) => `r${n + 8}d`),
])

export interface MacSource {
  source: string
  /** Label in the original program → its name in the macOS program. */
  labels: Map<string, string>
  /** Original names of the labels that became assembler-local (not in the symbol table). */
  localLabels: Set<string>
}

interface ParsedLine {
  /** Labels defined at the start of the line. */
  labels: string[]
  /** The directive or instruction without labels and comment ('' when there is none). */
  statement: string
  /** The comment with its `#`, or ''. */
  comment: string
  indent: string
}

/** Where the comment starts: the first `#` that is not inside a string or a character. */
function commentStart(line: string): number {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote !== null) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#') {
      return i
    }
  }
  return line.length
}

function parseLine(line: string): ParsedLine {
  const cut = commentStart(line)
  const comment = line.slice(cut)
  let rest = line.slice(0, cut)
  const indent = /^\s*/.exec(rest)?.[0] ?? ''
  const labels: string[] = []
  for (let match = LABEL_AT_START.exec(rest); match !== null; match = LABEL_AT_START.exec(rest)) {
    labels.push(match[1] ?? '')
    rest = rest.slice(match[0].length)
  }
  return { labels, statement: rest.trim(), comment, indent }
}

function firstWord(statement: string): string {
  return (/^\S+/.exec(statement)?.[0] ?? '').toLowerCase()
}

function afterFirstWord(statement: string): string {
  return statement.replace(/^\S+\s*/, '')
}

/** Call `visit` for every identifier that is outside string and character literals. */
function mapIdentifiers(text: string, visit: (name: string) => string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === '"' || ch === "'") {
      // Copy the literal untouched.
      let end = i + 1
      while (end < text.length && text[end] !== ch) end += text[end] === '\\' ? 2 : 1
      out += text.slice(i, Math.min(end + 1, text.length))
      i = end + 1
      continue
    }
    IDENTIFIER.lastIndex = i
    const match = IDENTIFIER.exec(text)
    if (match?.index === i) {
      out += visit(match[0])
      i += match[0].length
    } else {
      // A digit run (and what sticks to it, such as 0x1f) is a number, not a name.
      const number = /^[0-9][A-Za-z0-9_]*/.exec(text.slice(i))
      const piece = number?.[0] ?? ch
      out += piece
      i += piece.length
    }
  }
  return out
}

function identifiersIn(text: string): string[] {
  const names: string[] = []
  mapIdentifiers(text, (name) => {
    names.push(name)
    return name
  })
  return names
}

function isJump(mnemonic: string): boolean {
  return /^j[a-z]+$/.test(mnemonic)
}

function macSection(argument: string): string | null {
  const name = argument.trim().split(/[\s,]/)[0] ?? ''
  if (name.startsWith('.text')) return '.text'
  if (name.startsWith('.data')) return '.data'
  if (name.startsWith('.bss')) return '.bss'
  if (name.startsWith('.note')) return null
  // .rodata, and anything unknown (the emulator treats unknown sections as read-only data).
  return '.section __TEXT,__const'
}

/**
 * Rewrite `source` for clang on macOS. `entry` is the name `main` gets: `_main` for a
 * normal program, another name when a C driver provides the real `main`.
 */
export function rewriteForMacOS(source: string, entry: string): MacSource {
  const lines = source.split(/\r?\n/).map(parseLine)

  // Pass 1: which labels exist, and how each one is used.
  const defined = new Set<string>()
  for (const line of lines) for (const label of line.labels) defined.add(label)
  const jumpTargets = new Set<string>()
  const otherUses = new Set<string>()
  for (const line of lines) {
    if (line.statement === '') continue
    const word = firstWord(line.statement)
    const names = identifiersIn(afterFirstWord(line.statement)).filter((name) => defined.has(name))
    for (const name of names) (isJump(word) ? jumpTargets : otherUses).add(name)
  }

  // Pass 2: the new name of every label.
  const labels = new Map<string, string>()
  const localLabels = new Set<string>()
  const taken = new Set<string>(defined)
  const unique = (wanted: string): string => {
    let name = wanted
    while (taken.has(name)) name += '_'
    taken.add(name)
    return name
  }
  for (const name of defined) {
    if (name === 'main') {
      labels.set(name, entry)
    } else if (jumpTargets.has(name) && !otherUses.has(name)) {
      labels.set(name, unique(`Lss_${name}`))
      localLabels.add(name)
    } else if (/^[lL]/.test(name)) {
      labels.set(name, unique(`ss_${name}`))
    } else {
      labels.set(name, name)
    }
  }
  const rename = (name: string): string => labels.get(name) ?? name

  // Pass 3: rewrite every line.
  const out: string[] = []
  for (const line of lines) {
    const labelText = line.labels.map((label) => `${rename(label)}:`).join(' ')
    let statement = line.statement
    const word = firstWord(statement)
    const rest = afterFirstWord(statement)

    if (word.startsWith('.')) {
      if (DROPPED_DIRECTIVES.has(word) || word.startsWith('.cfi_')) statement = ''
      else if (word === '.section') statement = macSection(rest) ?? ''
      else if (word === '.rodata') statement = '.section __TEXT,__const'
      else if (rest !== '')
        statement = `${statement.slice(0, word.length)} ${mapIdentifiers(rest, rename)}`
    } else if (word === 'call') {
      const target = rest.trim().replace(/@plt$/i, '')
      if (defined.has(target)) statement = `call ${rename(target)}`
      else statement = `call _${target === '__isoc99_scanf' ? 'scanf' : target}`
    } else if (statement !== '') {
      let mnemonic = statement.slice(0, word.length)
      if (word === 'movsx') {
        const sourceOperand = (rest.split(',')[1] ?? '').trim().toLowerCase()
        if (REGISTERS_32.has(sourceOperand) || sourceOperand.startsWith('dword ptr')) {
          mnemonic = 'movsxd'
        }
      }
      statement = rest === '' ? mnemonic : `${mnemonic} ${mapIdentifiers(rest, rename)}`
    }

    const code = [labelText, statement].filter((part) => part !== '').join(' ')
    // Keep the original indentation for instructions; labels start at the left edge.
    const indent = labelText === '' ? line.indent : ''
    const text =
      code === ''
        ? line.comment
        : `${indent}${code}${line.comment === '' ? '' : `  ${line.comment}`}`
    out.push(text.trimEnd())
  }

  return { source: out.join('\n'), labels, localLabels }
}

/**
 * Markers around the program's code, for the built-in tracer: it must know which
 * addresses belong to the program. Everything a file puts in `.text` ends up in one
 * block, in order, so a label at the very start and one at the very end bracket it.
 */
export function withTextMarkers(source: string, start: string, end: string): string {
  return [
    '    .text',
    `    .globl ${start}`,
    `${start}:`,
    source,
    '    .text',
    `    .globl ${end}`,
    `${end}:`,
    '',
  ].join('\n')
}
