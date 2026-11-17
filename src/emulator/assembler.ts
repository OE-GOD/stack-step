/**
 * The assembler: program text → `Program` (behaviour contract: `assemble`).
 *
 * A name may be used before the line that defines it, so the work is done in passes:
 *
 *   1. collect   read every line: labels, `.equ` constants, data directives and
 *                instructions (operands still raw). Mistakes that need no names are
 *                found here.
 *   2. constants work out every `.equ` value (they may use each other in any order),
 *                and which constants gcc already knows at a given line (see below).
 *   3. data      work out the bytes of every data item, and give it its address
 *                (read-only area and data area).
 *   4. resolve   turn raw operands into `Operand`s, check the operand rules, and
 *                give every instruction its size (jumps start in the 2-byte form).
 *   5. layout    grow the jumps that do not reach, then give every instruction and
 *                every code label its address. A data area that the code now reaches
 *                into moves up to the next page after the code, as a linker does.
 *   6. resolve   once more, now with the final addresses in the operands.
 *   7. build     fill in the data bytes and build the `Program`.
 *
 * gcc reads a file from top to bottom. A `.equ` constant used as a number before gcc
 * knows it (its line, or the line of a constant in its value, comes later) is read by
 * gcc as a memory address; this emulator uses the value and warns. As the scale of a
 * register gcc refuses it (an error), and in an address gcc gives it 4 bytes (a size).
 *
 * Mistakes in the student's program become `Diagnostic`s: at most one error per line.
 * `assemble` never throws.
 */
import * as say from './errors'
import { lexLine } from './lexer'
import {
  AsmError,
  evaluateConstant,
  exprNames,
  parseLine,
  reservedNameReason,
  resolveOperands,
  unknownName,
  type ConstantUse,
  type Expr,
  type FillStatement,
  type InstructionStatement,
  type StringsStatement,
  type SymbolEnv,
  type ValuesStatement,
} from './parser'
import { lookupRegister } from './registers'
import { NEAR_JUMP_SIZE, instructionSize } from './sizes'
import {
  DEFAULT_OPTIONS,
  type AssembleResult,
  type DataItem,
  type Diagnostic,
  type EmulatorOptions,
  type Instruction,
  type Operand,
  type OperandSize,
  type Program,
  type SectionName,
  type SymbolInfo,
} from './types'
import { fitsBits, isConditionalJump, validateInstruction } from './validate'

/** `assemble` stops collecting after this many errors. */
const MAX_ERRORS = 20

/** The most bytes one `.zero` / `.space` / `.skip` may make (1 MiB). */
const MAX_FILL_BYTES = 0x100000

/** The most zero bytes all of them together may make (16 MiB), so a page cannot run out of memory. */
const MAX_TOTAL_FILL_BYTES = 0x1000000

/** How many `.equ` constants may be defined one through the next (keeps the call stack small). */
const MAX_CONSTANT_DEPTH = 100

/** Memory comes in pages of 4 KiB. A data area that has to move starts on a new page. */
const PAGE = 0x1000n

type DataStatement = StringsStatement | ValuesStatement | FillStatement

interface DataRecord {
  line: number
  section: 'rodata' | 'data'
  statement: DataStatement
  label: string | null
  address: bigint
  bytes: number[]
  /** How many bytes the item takes. */
  size: number
}

interface LabelRecord {
  name: string
  line: number
  kind: 'code' | 'data'
  /** Code label: index of the instruction it names (the instruction count = end of code). */
  instruction: number
  /** Data label: the item it names, or null for the end of `area`. */
  item: DataRecord | null
  area: 'rodata' | 'data'
  address: bigint
}

interface ConstantRecord {
  name: string
  line: number
  /** How it was defined: `.equ`, `.set` or `=`. */
  written: string
  /** Null when the value could not be read (the line already has an error). */
  expr: Expr | null
  value: bigint
  state: 'waiting' | 'working' | 'done'
  /**
   * gcc knows the value on the lines after this one: every constant in `expr` was
   * known on this line. (False when `expr` uses a constant defined further down.)
   */
  ready: boolean
}

interface InstructionRecord {
  /** Position in the program. */
  index: number
  line: number
  statement: InstructionStatement
  operands: Operand[]
  opSize: OperandSize | null
  size: number
  address: bigint
  /** False when the line has an error. */
  valid: boolean
  /** For a jump to a label: index of the instruction it jumps to, else -1. */
  jumpTo: number
  /** The jump needs its far form. */
  long: boolean
}

/** Directives that place data: the ones gcc uses inside a `.note` section. */
const DATA_DIRECTIVES: ReadonlySet<string> = new Set([
  ...['.string', '.asciz', '.ascii', '.quad', '.long', '.int', '.word', '.short', '.byte'],
  ...['.zero', '.space', '.skip'],
])

/**
 * Inside `.section .note…` gcc writes bookkeeping that is not part of the program:
 * numeric labels (`0:`) and data (`.long 1f - 0f`). Is this line one of those?
 * Such lines are skipped; every other line is read as usual.
 */
function isNoteContent(text: string): boolean {
  const { tokens } = lexLine(text)
  let position = 0
  for (;;) {
    const token = tokens.at(position)
    const next = tokens.at(position + 1)
    const numeric =
      token !== undefined &&
      (token.kind === 'number' || (token.kind === 'problem' && token.problem.type === 'number'))
    if (!numeric || next === undefined || next.kind !== 'punct' || next.text !== ':') break
    position += 2
  }
  const numericLabels = position > 0
  const first = tokens.at(position)
  if (first === undefined) return numericLabels
  if (first.kind !== 'ident' || !first.text.startsWith('.')) return false
  const next = tokens.at(position + 1)
  if (next !== undefined && next.kind === 'punct' && next.text === ':') return false
  return numericLabels || DATA_DIRECTIVES.has(first.text.toLowerCase())
}

/** Bits in a data element of 1, 2, 4 or 8 bytes. */
const ELEMENT_BITS = { 1: 8, 2: 16, 4: 32, 8: 64 } as const

/** The first multiple of `step` at or above `value`. */
function roundUp(value: bigint, step: bigint): bigint {
  const rest = ((value % step) + step) % step
  return rest === 0n ? value : value + (step - rest)
}

/** Add `value` to `bytes` as `count` little-endian bytes. */
function pushLittleEndian(bytes: number[], value: bigint, count: number): void {
  let rest = BigInt.asUintN(count * 8, value)
  for (let i = 0; i < count; i++) {
    bytes.push(Number(rest & 0xffn))
    rest >>= 8n
  }
}

class Assembly {
  private readonly source: string
  private readonly textBase: bigint
  private readonly rodataBase: bigint
  private readonly dataBase: bigint

  private readonly errors = new Map<number, Diagnostic>()
  private readonly warnings: Diagnostic[] = []
  private readonly labels = new Map<string, LabelRecord>()
  private readonly constants = new Map<string, ConstantRecord>()
  private readonly items: DataRecord[] = []
  private readonly instructions: InstructionRecord[] = []
  /** Labels waiting for the next instruction or data item of their section. */
  private readonly waiting: Record<SectionName, LabelRecord[]> = { text: [], rodata: [], data: [] }
  private sawIntelSyntax = false
  /** Zero bytes asked for so far by `.zero` / `.space` / `.skip`. */
  private fillBytes = 0
  /** The "too many zero bytes in all" error was reported (it is reported once). */
  private fillTotalReported = false
  private textEnd = 0n
  /** Where the read-only data and the data really start (they move up after long code). */
  private rodataStart = 0n
  private dataStart = 0n
  private rodataEnd = 0n
  private dataEnd = 0n

  /** What the operand parser may ask about names. */
  private readonly env: SymbolEnv = {
    constant: (name) => this.constants.get(name)?.value,
    label: (name) => {
      const label = this.labels.get(name)
      return label === undefined ? undefined : { kind: label.kind, address: label.address }
    },
    names: () => [...this.labels.keys(), ...this.constants.keys()],
  }

  constructor(source: string, options: EmulatorOptions) {
    this.source = source
    this.textBase = options.textBase ?? DEFAULT_OPTIONS.textBase
    this.rodataBase = options.rodataBase ?? DEFAULT_OPTIONS.rodataBase
    this.dataBase = options.dataBase ?? DEFAULT_OPTIONS.dataBase
    this.textEnd = this.textBase
    this.rodataStart = this.rodataBase
    this.dataStart = this.dataBase
    this.rodataEnd = this.rodataBase
    this.dataEnd = this.dataBase
  }

  run(): AssembleResult {
    this.collect()
    this.evaluateConstants()
    this.findReadyConstants()
    this.sizeData()
    this.placeData()
    this.resolveInstructions(false)
    this.layoutCode()
    // Now the end of the code is known: a data area it reaches into moves up.
    this.placeData()
    this.resolveInstructions(true)
    this.fillData()
    return this.finish()
  }

  /** Keep the first error of each line. */
  private report(diagnostic: Diagnostic): void {
    if (!this.errors.has(diagnostic.line)) this.errors.set(diagnostic.line, diagnostic)
  }

  /* ───────────────────────────── 1. collect ───────────────────────────── */

  private collect(): void {
    const lines = this.source.split(/\r\n|\n|\r/)
    let section: SectionName = 'text'
    let sectionName = '.text'
    let inNote = false

    for (let i = 0; i < lines.length; i++) {
      const line = i + 1
      if (inNote && isNoteContent(lines[i])) continue

      const parsed = parseLine(lines[i], line)
      if (parsed.error !== null) this.report(parsed.error)
      if (parsed.warning !== null) this.warnings.push(parsed.warning)
      for (const name of parsed.labels) this.defineLabel(name, line, section)
      if (parsed.brokenEqu !== null && reservedNameReason(parsed.brokenEqu) === null) {
        this.defineConstant(parsed.brokenEqu, line, '.equ', null)
      }

      const statement = parsed.statement
      if (statement === null) continue
      switch (statement.kind) {
        case 'intel-syntax':
          this.sawIntelSyntax = true
          break
        case 'section':
          inNote = statement.section === 'note'
          if (statement.section === 'note') break
          section = statement.section
          sectionName = statement.name
          if (!statement.known) {
            const dotted = /^(text|data|rodata|bss)$/i.test(statement.name)
            const suggestion = dotted ? `.${statement.name.toLowerCase()}` : null
            this.warnings.push(
              say.unknownDirective(line, { reason: 'section', name: statement.name, suggestion }),
            )
          }
          break
        case 'ignored':
          break
        case 'common-symbol':
          this.warnings.push(say.commonSymbol(line, statement))
          break
        case 'unknown-directive': {
          const { name, suggestions } = statement
          this.warnings.push(
            name.toLowerCase() === '.att_syntax'
              ? say.unknownDirective(line, { reason: 'att-syntax', name })
              : say.unknownDirective(line, { reason: 'directive', name, suggestions }),
          )
          break
        }
        case 'equ':
          this.defineConstant(statement.name, line, statement.written, statement.value)
          break
        case 'strings':
        case 'values':
        case 'fill':
          this.addData(statement, line, section)
          break
        case 'instruction':
          if (section !== 'text') this.report(say.wrongSection(line, { section: sectionName }))
          else this.addInstruction(statement, line)
          break
      }
    }

    // A label with nothing after it names the end of its section: the end of the code,
    // or (it already says so) the end of its data area.
    for (const label of this.waiting.text) {
      label.kind = 'code'
      label.instruction = this.instructions.length
    }
  }

  /** Is the name free? If not, report it on `line` (the second place that defines it). */
  private isNewName(name: string, line: number, what: 'label' | 'name'): boolean {
    const earlier = this.labels.get(name) ?? this.constants.get(name)
    if (earlier === undefined) return true
    const bothLabels = what === 'label' && this.labels.has(name)
    this.report(
      say.duplicateLabel(line, {
        name,
        firstLine: earlier.line,
        what: bothLabels ? 'label' : 'name',
      }),
    )
    return false
  }

  private defineLabel(name: string, line: number, section: SectionName): void {
    if (!this.isNewName(name, line, 'label')) return
    const label: LabelRecord = {
      name,
      line,
      kind: section === 'text' ? 'code' : 'data',
      instruction: 0,
      item: null,
      area: section === 'data' ? 'data' : 'rodata',
      address: 0n,
    }
    this.labels.set(name, label)
    this.waiting[section].push(label)
  }

  private defineConstant(name: string, line: number, written: string, expr: Expr | null): void {
    // A broken `.equ` of a name that already exists changes nothing and says nothing new.
    if (expr === null && (this.labels.has(name) || this.constants.has(name))) return
    if (!this.isNewName(name, line, 'name')) return
    this.constants.set(name, {
      name,
      line,
      written,
      expr,
      value: 0n,
      state: 'waiting',
      ready: true,
    })
  }

  private addData(statement: DataStatement, line: number, section: SectionName): void {
    const waiting = this.waiting[section]
    const item: DataRecord = {
      line,
      section: section === 'data' ? 'data' : 'rodata',
      statement,
      label: waiting.length > 0 ? waiting[0].name : null,
      address: 0n,
      bytes: [],
      size: 0,
    }
    for (const label of waiting) {
      label.kind = 'data'
      label.item = item
    }
    waiting.length = 0
    this.items.push(item)
  }

  private addInstruction(statement: InstructionStatement, line: number): void {
    for (const label of this.waiting.text) {
      label.kind = 'code'
      label.instruction = this.instructions.length
    }
    this.waiting.text.length = 0
    this.instructions.push({
      index: this.instructions.length,
      line,
      statement,
      operands: [],
      opSize: null,
      size: 0,
      address: 0n,
      valid: false,
      jumpTo: -1,
      long: false,
    })
  }

  /* ──────────────────────────── 2. constants ──────────────────────────── */

  private evaluateConstants(): void {
    for (const constant of this.constants.values()) this.constantValue(constant, 0)
  }

  /** The value of a constant, worked out the first time it is needed. */
  private constantValue(constant: ConstantRecord, depth: number): bigint {
    if (constant.state === 'done') return constant.value
    constant.state = 'working'
    if (constant.expr !== null) {
      try {
        const { expr, line, written } = constant
        constant.value = this.valueOf(expr, line, 'equ', written, depth, constant)
      } catch (thrown) {
        if (!(thrown instanceof AsmError)) throw thrown
        this.report(thrown.diagnostic)
        constant.value = 0n
      }
    }
    constant.state = 'done'
    return constant.value
  }

  /**
   * Work out the expression of a directive.
   * - 'equ' and 'count': numbers and constants only.
   * - 'data': a label may also be used; it stands for its address.
   * `user` is the constant being defined, to notice one that is defined using itself.
   */
  private valueOf(
    expr: Expr,
    line: number,
    use: 'equ' | 'count' | 'data',
    written: string,
    depth = 0,
    user: ConstantRecord | null = null,
  ): bigint {
    return evaluateConstant(expr, (name) => {
      const constant = this.constants.get(name)
      if (constant !== undefined) {
        if (constant.state === 'working') {
          const circle = user ?? constant
          throw new AsmError(say.badDirective(line, { reason: 'equ-cycle', name: circle.name }))
        }
        if (depth >= MAX_CONSTANT_DEPTH) {
          throw new AsmError(say.badDirective(line, { reason: 'equ-too-deep', name }))
        }
        return this.constantValue(constant, depth + 1)
      }
      const label = this.labels.get(name)
      if (label !== undefined) {
        if (use === 'data') return label.address
        throw new AsmError(
          say.badDirective(line, { reason: 'not-a-number', written, name, what: 'label' }),
        )
      }
      if (lookupRegister(name) !== undefined || name.toLowerCase() === 'rip') {
        throw new AsmError(
          say.badDirective(line, { reason: 'not-a-number', written, name, what: 'register' }),
        )
      }
      throw new AsmError(unknownName(name, this.env, line))
    })
  }

  /**
   * Which constants gcc knows once their line is read: those whose value uses only
   * constants it already knew on that line. (`.equ a, b+1` followed by `.equ b, 2`:
   * gcc never treats `a` as a number.) The constants are in the order of their lines.
   */
  private findReadyConstants(): void {
    for (const constant of this.constants.values()) {
      constant.ready = true
      if (constant.expr === null) continue
      for (const name of exprNames(constant.expr)) {
        const used = this.constants.get(name)
        if (used !== undefined && (used.line >= constant.line || !used.ready)) {
          constant.ready = false
          break
        }
      }
    }
  }

  /**
   * Does gcc know the constant `name` on `line`? Names that are not constants, and
   * constants whose own line is broken (it already has an error), count as known.
   */
  private isKnownAt(name: string, line: number): boolean {
    const constant = this.constants.get(name)
    if (constant === undefined || constant.expr === null) return true
    return constant.line < line && constant.ready
  }

  /** Why gcc does not know the constant `name` on `line`, for the message. */
  private tooLate(name: string, line: number): say.ConstantTooLateDetail {
    const constant = this.constants.get(name)
    const value = constant?.value ?? 0n
    if (constant === undefined || constant.line > line) {
      return { reason: 'later', name, value, definedLine: constant?.line ?? line }
    }
    // Follow the chain down to the constant whose value uses a later one. Each step
    // goes to an earlier line, so this ends.
    let user = constant
    for (;;) {
      let next: ConstantRecord | undefined
      for (const usedName of user.expr === null ? [] : exprNames(user.expr)) {
        const used = this.constants.get(usedName)
        if (used === undefined || used.line === user.line) continue
        if (used.line > user.line) {
          const late = { late: used.name, lateLine: used.line, userLine: user.line }
          return { reason: 'depends', name, value, ...late }
        }
        if (!used.ready) {
          next = used
          break
        }
      }
      if (next === undefined) return { reason: 'later', name, value, definedLine: constant.line }
      user = next
    }
  }

  /* ─────────────────────────────── 3. data ─────────────────────────────── */

  /** Work out how many bytes each data item takes. Text and `.zero` bytes are filled in here. */
  private sizeData(): void {
    for (const item of this.items) item.size = this.sizeOfData(item)
  }

  /**
   * Give every data item and every data label its address. The read-only data starts at
   * `rodataBase` and the writable data at `dataBase`, unless the area would overlap the
   * code (or the other area): then it moves up to the next page after what it would
   * overlap, at the same place in that page, as a linker does. So a long program never
   * runs into its own data (`381 × mov rax, 0x1122334455667788` reaches past 0x402010).
   */
  private placeData(): void {
    const sizeOf = (section: 'rodata' | 'data'): bigint =>
      BigInt(
        this.items.reduce((sum, item) => (item.section === section ? sum + item.size : sum), 0),
      )
    const taken: { start: bigint; end: bigint }[] = []
    if (this.textEnd > this.textBase) taken.push({ start: this.textBase, end: this.textEnd })
    const overlapping = (start: bigint, end: bigint): { start: bigint; end: bigint } | undefined =>
      taken.find((range) => range.start < end && start < range.end)
    const areas = [
      { section: 'rodata' as const, base: this.rodataBase, size: sizeOf('rodata'), start: 0n },
      { section: 'data' as const, base: this.dataBase, size: sizeOf('data'), start: 0n },
    ].sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0))
    for (const area of areas) {
      let start = area.base
      // An empty area takes no room, so it never has to move. `start` only grows, past the
      // end of what it overlapped, so this ends.
      let other = area.size > 0 ? overlapping(start, start + area.size) : undefined
      while (other !== undefined) {
        start = roundUp(other.end, PAGE) + (((area.base % PAGE) + PAGE) % PAGE)
        other = overlapping(start, start + area.size)
      }
      area.start = start
      if (area.size > 0) taken.push({ start, end: start + area.size })
    }
    for (const area of areas) {
      if (area.section === 'data') this.dataStart = area.start
      else this.rodataStart = area.start
    }

    let rodata = this.rodataStart
    let data = this.dataStart
    for (const item of this.items) {
      if (item.section === 'data') {
        item.address = data
        data += BigInt(item.size)
      } else {
        item.address = rodata
        rodata += BigInt(item.size)
      }
    }
    this.rodataEnd = rodata
    this.dataEnd = data
    for (const label of this.labels.values()) {
      if (label.kind !== 'data') continue
      if (label.item !== null) label.address = label.item.address
      else label.address = label.area === 'data' ? data : rodata
    }
  }

  private sizeOfData(item: DataRecord): number {
    const statement = item.statement
    switch (statement.kind) {
      case 'strings':
        for (const bytes of statement.bytes) {
          // (A loop, not `push(...bytes)`: very long text must not overflow the call stack.)
          for (const byte of bytes) item.bytes.push(byte)
          if (statement.terminated) item.bytes.push(0)
        }
        return item.bytes.length
      case 'values':
        return statement.values.length * statement.elementSize
      case 'fill': {
        const count = this.fillCount(statement, item.line)
        item.bytes = new Array<number>(count).fill(0)
        return count
      }
    }
  }

  /** How many bytes a `.zero` asks for (0 when the count is wrong; the error is reported). */
  private fillCount(statement: FillStatement, line: number): number {
    const written = statement.directive
    try {
      const count = this.valueOf(statement.count, line, 'count', written)
      if (count < 0n) {
        this.report(
          say.badDirective(line, { reason: 'count-negative', written, text: statement.text }),
        )
        return 0
      }
      if (count > BigInt(MAX_FILL_BYTES)) {
        this.report(
          say.badDirective(line, { reason: 'count-too-big', written, limit: MAX_FILL_BYTES }),
        )
        return 0
      }
      if (this.fillBytes + Number(count) > MAX_TOTAL_FILL_BYTES) {
        // Said once, on the first line that goes over: the later lines are not the mistake.
        if (!this.fillTotalReported) {
          this.fillTotalReported = true
          this.report(
            say.badDirective(line, { reason: 'total-too-big', limit: MAX_TOTAL_FILL_BYTES }),
          )
        }
        return 0
      }
      this.fillBytes += Number(count)
      return Number(count)
    } catch (thrown) {
      if (!(thrown instanceof AsmError)) throw thrown
      this.report(thrown.diagnostic)
      return 0
    }
  }

  /* ─────────────────────────── 4 and 6. resolve ─────────────────────────── */

  /**
   * Understand the operands of every instruction and check the operand rules.
   * The first time (`final` false) code labels have no address yet; sizes never depend
   * on a label address, so this is enough to lay out the code. The second time the
   * addresses are final, and a number that is a label address can be checked for fit.
   */
  private resolveInstructions(final: boolean): void {
    const isLabel = (name: string): boolean => this.labels.has(name)
    for (const record of this.instructions) {
      record.valid = false
      if (this.errors.has(record.line)) continue
      const { mnemonic, written } = record.statement
      const resolved = resolveOperands(record.statement, this.env, record.line)
      if (!resolved.ok) {
        this.report(resolved.diagnostic)
        continue
      }
      // A constant gcc does not know yet on this line (see the file comment).
      const { uses } = resolved
      const tooEarly = (role: ConstantUse['role']): ConstantUse | undefined =>
        uses.find((use) => use.role === role && !this.isKnownAt(use.name, record.line))
      const scale = tooEarly('scale')
      if (scale !== undefined) {
        this.report(say.scaleUsedTooEarly(record.line, this.tooLate(scale.name, record.line)))
        continue
      }
      const checked = validateInstruction(record.line, mnemonic, written, resolved.operands)
      if (!checked.ok) {
        this.report(checked.diagnostic)
        continue
      }
      record.valid = true
      record.operands = resolved.operands
      record.opSize = checked.opSize
      if (final) continue
      const lateDisplacement = tooEarly('displacement') !== undefined
      record.size = instructionSize(mnemonic, written, record.operands, record.opSize, {
        isLabel,
        lateDisplacement,
      })
      const number = tooEarly('number')
      if (number !== undefined) {
        const detail = this.tooLate(number.name, record.line)
        this.warnings.push(say.constantUsedTooEarly(record.line, detail))
      }
    }
  }

  /* ────────────────────────────── 5. layout ────────────────────────────── */

  /** Grow the jumps that do not reach, then give instructions and code labels addresses. */
  private layoutCode(): void {
    const records = this.instructions
    const jumps: InstructionRecord[] = []
    for (const record of records) {
      const { mnemonic } = record.statement
      if (!record.valid || (mnemonic !== 'jmp' && !isConditionalJump(mnemonic))) continue
      const target = record.operands.at(0)
      if (target === undefined || target.kind !== 'target' || target.external) continue
      const label = this.labels.get(target.name)
      if (label === undefined || label.kind !== 'code') continue
      record.jumpTo = label.instruction
      jumps.push(record)
    }

    // Start with every jump near. A jump that does not reach becomes far, which moves
    // everything after it, so look again until nothing changes. Sizes only grow.
    const offsets = new Array<number>(records.length + 1).fill(0)
    for (;;) {
      for (let i = 0; i < records.length; i++) offsets[i + 1] = offsets[i] + records[i].size
      let changed = false
      for (const jump of jumps) {
        if (jump.long) continue
        const distance = offsets[jump.jumpTo] - (offsets[jump.index] + NEAR_JUMP_SIZE)
        if (distance < -128 || distance > 127) {
          const { mnemonic, written } = jump.statement
          jump.long = true
          jump.size = instructionSize(mnemonic, written, jump.operands, jump.opSize, {
            longJump: true,
          })
          changed = true
        }
      }
      if (!changed) break
    }

    for (let i = 0; i < records.length; i++) {
      records[i].address = this.textBase + BigInt(offsets[i])
    }
    this.textEnd = this.textBase + BigInt(offsets[records.length])
    for (const label of this.labels.values()) {
      if (label.kind === 'code') label.address = this.textBase + BigInt(offsets[label.instruction])
    }
  }

  /* ─────────────────────────────── 7. build ─────────────────────────────── */

  /** Work out the values of `.quad`, `.long`, … (they may be label addresses). */
  private fillData(): void {
    for (const item of this.items) {
      const statement = item.statement
      if (statement.kind !== 'values') continue
      const size = statement.elementSize
      const bits = ELEMENT_BITS[size]
      for (const value of statement.values) {
        let number = 0n
        try {
          number = this.valueOf(value.expr, item.line, 'data', statement.directive)
          if (!fitsBits(number, bits)) {
            this.report(
              say.immediateTooLarge(item.line, {
                reason: 'data',
                text: value.text,
                directive: statement.directive,
                size: bits,
              }),
            )
          }
        } catch (thrown) {
          if (!(thrown instanceof AsmError)) throw thrown
          this.report(thrown.diagnostic)
        }
        pushLittleEndian(item.bytes, number, size)
      }
    }
  }

  private finish(): AssembleResult {
    const errors = [...this.errors.values()].sort((a, b) => a.line - b.line)
    if (errors.length === 0 && this.instructions.length === 0) errors.push(say.emptyProgram())
    if (errors.length > 0) return this.failure(errors)

    const instructions: Instruction[] = this.instructions.map((record, index) => {
      const { mnemonic, written } = record.statement
      const operandText = record.operands.map((operand) => operand.text).join(', ')
      return {
        index,
        line: record.line,
        address: record.address,
        size: record.size,
        mnemonic,
        written,
        operands: record.operands,
        opSize: record.opSize,
        text: operandText === '' ? written : `${written} ${operandText}`,
      }
    })

    const symbols = new Map<string, SymbolInfo>()
    for (const label of this.labels.values()) {
      symbols.set(label.name, {
        name: label.name,
        address: label.address,
        kind: label.kind,
        line: label.line,
      })
    }
    for (const instruction of instructions) {
      for (const operand of instruction.operands) {
        if (operand.kind === 'target' && operand.external && !symbols.has(operand.name)) {
          symbols.set(operand.name, {
            name: operand.name,
            address: operand.address,
            kind: 'external',
            line: null,
          })
        }
      }
    }

    const constants = new Map<string, bigint>()
    for (const constant of this.constants.values()) constants.set(constant.name, constant.value)

    const data: DataItem[] = this.items.map((item) => {
      const statement = item.statement
      return {
        label: item.label,
        line: item.line,
        section: item.section,
        address: item.address,
        directive: statement.directive,
        elementSize: statement.kind === 'values' ? statement.elementSize : 1,
        bytes: item.bytes,
        text: statement.kind === 'strings' ? statement.strings.join('\0') : null,
      }
    })

    const main = this.labels.get('main')
    const hasMain = main !== undefined && main.kind === 'code'
    const wholeProgram: Diagnostic[] = []
    if (!this.sawIntelSyntax) wholeProgram.push(say.missingIntelSyntax())
    if (!hasMain) {
      // `main:` in front of data names the data, so it can't be where the program starts.
      wholeProgram.push(say.noMain({ dataLine: main === undefined ? null : main.line }))
    } else if (main.instruction >= this.instructions.length) {
      // A `main:` with no instruction after it is a code label at the end of the code: the
      // program starts there with nothing to run (the first step says so too).
      wholeProgram.push(say.emptyMain(main.line))
    }
    // Sorted by line. The sort is stable, so the warnings of one line keep their order.
    const warnings = [...wholeProgram, ...this.warnings].sort((a, b) => a.line - b.line)

    const program: Program = {
      source: this.source,
      instructions,
      symbols,
      constants,
      data,
      layout: {
        textBase: this.textBase,
        textEnd: this.textEnd,
        rodataBase: this.rodataStart,
        rodataEnd: this.rodataEnd,
        dataBase: this.dataStart,
        dataEnd: this.dataEnd,
      },
      entry: hasMain ? main.address : instructions[0].address,
      entryLabel: hasMain ? 'main' : null,
      addressToIndex: new Map(
        instructions.map((instruction) => [instruction.address, instruction.index]),
      ),
      lineToIndex: new Map(
        instructions.map((instruction) => [instruction.line, instruction.index]),
      ),
      warnings,
    }
    return { ok: true, program, diagnostics: warnings }
  }

  /**
   * The result for a program with mistakes: the first errors in line order, plus the
   * warnings that belong to a line (`unknown-directive`). The warnings about the whole
   * program (no `main`, no `.intel_syntax`) can wait until the errors are fixed. When
   * there are more than 20 errors, a note (line 0) says that more errors follow.
   */
  private failure(errors: Diagnostic[]): AssembleResult {
    const kept = errors.slice(0, MAX_ERRORS)
    const more = errors.length > MAX_ERRORS
    const lastLine = more ? kept[kept.length - 1].line : Infinity
    const warnings = this.warnings.filter((warning) => warning.line <= lastLine)
    if (more) warnings.push(say.moreErrors(lastLine))
    const diagnostics = [...kept, ...warnings].sort((a, b) => a.line - b.line)
    return { ok: false, program: null, diagnostics }
  }
}

/**
 * Turn program text into a `Program`.
 *
 * Never throws. On success `diagnostics` holds only warnings (the same list as
 * `program.warnings`). On failure `program` is null and `diagnostics` has at least
 * one error: at most one per source line, at most 20 in all, sorted by line.
 */
export function assemble(source: string, options: EmulatorOptions = {}): AssembleResult {
  try {
    return new Assembly(typeof source === 'string' ? source : '', options).run()
  } catch {
    // A bug in the emulator must never crash the page.
    return { ok: false, program: null, diagnostics: [say.internalProblem()] }
  }
}
