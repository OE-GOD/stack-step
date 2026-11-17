# Stack Step: build plan

Stack Step is a static website that teaches beginner x86-64 assembly (Intel syntax, as
`gcc` / GNU `as` write it) to community-college students. Its heart is an in-browser
**stepper**: paste a short program, press Step, and see every register, the stack, rsp,
rip and the flags change. Around it: short lessons, endless auto-checked practice, a
printable cheat sheet, progress tracking, and an optional AI tutor.

The student is new to assembly, may be learning English, and learns best from **small
steps, everyday analogies, and instant right/wrong feedback**. Every sentence on the
site is short and plain.

This file is the single source of truth for the architecture. `CHANGELOG.md` records
what each milestone actually added.

---

## 1. Architecture at a glance

```
            ┌──────────────────────────── browser (static site) ─────────────────────────────┐
            │                                                                                 │
 source ──► │  src/emulator  (pure TypeScript, no React)                                      │
  text      │    lexer → parser → validate → assembler ──► Program                            │
            │    Emulator(Program): step / stepBack / run / reset / breakpoints               │
            │         └─ every step returns a diff + a plain-English explanation              │
            │                                                                                 │
            │  src/features/*  (React pages)                                                  │
            │    stepper   uses the emulator directly                                         │
            │    lessons   embed a MiniStepper (same emulator)                                │
            │    practice  generators build a program, RUN IT IN THE EMULATOR to get the      │
            │              answer key, then check the student's answer and name the mistake   │
            │    cheatsheet, progress, about                                                  │
            │                                                                                 │
            │  src/lib: hash router · safe localStorage · progress store · share links        │
            └────────────────────────────────────┬────────────────────────────────────────────┘
                                                 │ only if the optional tutor is enabled
                                   POST /api/tutor (one small serverless function)
                                                 │  ANTHROPIC_API_KEY stays on the server
                                          Anthropic Messages API
```

- **No server, no login.** Everything except the optional tutor runs in the browser.
  `npm run build` produces a folder of static files.
- **One emulator, used three ways** (stepper, lesson examples, practice answer keys), so
  what a lesson says, what a problem expects and what the stepper shows can never disagree.
- **Hash routing** (`#/stepper`, `#/learn/mov`): works on Vercel, Netlify and GitHub
  Pages with zero server config, and share links put the program in the URL hash.

### Tech stack (versions as installed)

| Piece       | Choice                                                                           |
| ----------- | -------------------------------------------------------------------------------- |
| Build       | Vite 8, React 19, TypeScript 6.0 (strict)                                        |
| Styling     | Tailwind CSS 4 with semantic color tokens (`src/index.css`), light + dark        |
| Editor      | CodeMirror 6 (lazy-loaded) with our own assembly highlighter                     |
| Drag & drop | `@dnd-kit/core` plus tap-to-place                                                |
| Unit tests  | Vitest 5 (Node environment; jsdom opt-in per file)                               |
| E2E tests   | Playwright (desktop 1280×800 and phone 360×740 projects)                         |
| Lint/format | ESLint 9 (typescript-eslint type-checked, react-hooks, jsx-a11y) + Prettier      |
| Tutor       | One function (`api/tutor.ts` for Vercel, `netlify/functions/tutor.ts`) using the |
|             | official `@anthropic-ai/sdk`                                                     |

Why these pins: `typescript-eslint` supports TypeScript below 6.1, so TypeScript is 6.0
(not 7). `eslint-plugin-jsx-a11y` supports ESLint up to 9, so ESLint is 9 (not 10).
Routing is a ~100-line hash router of our own instead of a router package: ten routes do
not need more, and it keeps the first load small.

---

## 2. File tree

```
stack-step/
├─ PLAN.md  CHANGELOG.md  README.md
├─ index.html                      theme bootstrap (no flash), root element
├─ vite.config.ts  tsconfig*.json  eslint.config.js  .prettierrc.json  playwright.config.ts
├─ vercel.json  netlify.toml       static hosting + function config            (M7/M8)
├─ api/tutor.ts                    Vercel function  → server/tutorCore         (M7)
├─ netlify/functions/tutor.ts      Netlify function → server/tutorCore         (M7)
├─ server/
│  ├─ tutorCore.ts                 validation, rate limit, API call            (M7)
│  ├─ tutorPrompt.ts  rateLimit.ts the tutor's system prompt; the rate limiter (M7)
│  └─ devPlugin.ts                 serves /api/tutor during `npm run dev`      (M7)
├─ scripts/
│  ├─ screenshots.mjs              browser check: screenshots + overflow + console errors
│  ├─ run-ts.mjs                   run a scratch .ts file that imports the sources
│  ├─ verify-native.mjs            optional: step the examples on a real CPU and compare
│  ├─ make-size-fixture.mjs        instruction sizes from a real assembler (clang)
│  ├─ make-truth-fixture.mjs       arithmetic + flags from a real CPU
│  ├─ make-cpu-fuzz-fixture.mjs    600 random programs run on a real CPU
│  └─ lib/                         the TypeScript behind the scripts above
├─ e2e/                            Playwright tests
├─ docs/screenshots/<milestone>/   browser-check screenshots
├─ public/favicon.svg
└─ src/
   ├─ main.tsx  App.tsx  index.css
   ├─ emulator/                    PURE TypeScript. No React, no DOM.
   │  ├─ types.ts                  the shared contract (read this first)
   │  ├─ bits.ts                   masks, sign helpers
   │  ├─ registers.ts              register table + the sub-register write rules
   │  ├─ memory.ts                 sparse little-endian byte memory with regions
   │  ├─ alu.ts                    add/sub/inc/dec/imul/logic + flags, jump conditions
   │  ├─ format.ts                 hex formatting and hex-answer parsing
   │  ├─ errors.ts                 every assemble-time message, in one place
   │  ├─ runtimeErrors.ts          every run-time message, in one place
   │  ├─ lexer.ts  parser.ts       source text → statements
   │  ├─ validate.ts               the operand rules of each instruction
   │  ├─ sizes.ts                  instruction size table (documented)
   │  ├─ assembler.ts              layout, symbols → Program
   │  ├─ executor.ts               what each instruction does
   │  ├─ explain.ts                the plain-English explanation of each step
   │  ├─ libc.ts                   printf, scanf, puts, putchar, exit
   │  ├─ emulator.ts               Emulator class: step, stepBack, run, reset, breakpoints
   │  ├─ index.ts                  public exports (pages import ONLY from here)
   │  ├─ __fixtures__/             results recorded from a real assembler and a real CPU
   │  └─ *.test.ts                 unit tests (several thousand cases)
   ├─ examples/                    ready-made programs (also used as test fixtures)
   ├─ lib/
   │  ├─ router.tsx  routerCore.ts tiny hash router (Link, useRoute, navigate)
   │  ├─ asmHighlight.ts           one tokenizer for the editor and every code listing
   │  ├─ storage.ts                localStorage wrapped in try/catch
   │  ├─ progress.ts               lessons done + practice accuracy per topic
   │  ├─ share.ts                  program (+ starting state) ↔ URL hash
   │  ├─ theme.ts                  light/dark
   │  └─ rng.ts                    seeded random numbers (reproducible problems)
   ├─ content/
   │  ├─ topics.ts                 practice topic ids/labels shared by practice + progress
   │  └─ lessonList.ts             the 14 lessons: id, number, title, one-line summary
   ├─ components/
   │  ├─ ui/                       Button, Panel, Callout, Badge, Popover, RichText, …
   │  ├─ layout/                   AppShell, SiteNav, ThemeToggle, Logo, Page
   │  ├─ machine/                  RegistersPanel, StackPanel, FlagsPanel, HexValue,
   │  │                            ExplanationPanel, OutputPanel, CodeListing
   │  └─ ministepper/              MiniStepper (lessons, practice "show me"); types.ts = its contract
   └─ features/
      ├─ home/  about/
      ├─ stepper/                  StepperPage, editor/ (CodeMirror), controls, shortcuts
      ├─ lessons/                  types.ts (contract), index page, lesson page,
      │                            content/NN-<id>.tsx (one lazy file per lesson)
      ├─ practice/                 types.ts (contract), check.ts, gen/helpers.ts,
      │                            generators/<topic>.ts, hub, session, quiz, components/
      ├─ cheatsheet/               page + print styles (3×5 card and letter)
      ├─ progress/
      └─ tutor/                    TutorMount (renders nothing unless enabled), drawer
```

**Routes** (all under `#`): `/` · `/stepper` · `/learn` · `/learn/:lessonId` ·
`/practice` · `/practice/:topicId` · `/practice/weak` · `/practice/quiz` · `/cheatsheet`
· `/progress` · `/about`.

---

## 3. Emulator design (`src/emulator/`)

The contract lives in `src/emulator/types.ts`. This section explains the decisions.

### 3.1 Pipeline

```
source ─► lexer ─► parser ─► validate ─► assembler ─► Program ─► Emulator
          tokens   statements  operand     sizes,       (immutable)   (mutable state,
                   + operands  rules       addresses,                  history, diffs)
                                           symbols
```

`assemble(source, options)` returns either a `Program` plus warnings, or a list of
errors (one per bad line, each with a line number and a beginner-friendly message).
It never throws on bad input.

### 3.2 What the parser accepts

- Line shape: `label: op dest, src  # comment`. Labels, `#` comments, blank lines.
- Mnemonics and register names in any letter case; labels are case-sensitive.
- Directives: `.intel_syntax noprefix`, `.text`, `.data`, `.globl`/`.global`, `.type`,
  `.string "…"`, `.equ name, value` (also `.set` and `name = value`).
  Also understood: `.section .rodata|.data|.text`, `.asciz`, `.ascii`, `.quad`,
  `.long`/`.int`, `.word`/`.short`, `.byte`, `.zero`/`.space`/`.skip`.
  `.bss` is a data section. Silently ignored: `.file`, `.ident`, `.size`, `.loc`,
  `.weak`, `.local`, `.addrsig`, `.addrsig_sym` and `.cfi_*` (they only matter to the
  linker or the debugger), and `.align`/`.p2align`/`.balign` (on a real machine they can
  move later data; here the data stays packed). `.comm` and `.lcomm` get
  a warning with the line to write instead (`name: .zero N` after `.data`). Any other
  directive: a **warning**, never a crash.
- Numbers: decimal, `0x` hex, `0b` binary, negatives, `'A'` characters, and simple
  constant sums/products of numbers and `.equ` names (`count+8`).
  A leading-zero number such as `010` is an **error** with an explanation (gcc would
  silently read it as octal 8).
- String escapes: `\n \t \\ \" \0 \r \b \f`, octal (`\101`) and hex (`\x41`), giving
  the same bytes as gcc.
- Memory operands, every form the class uses: `[rax]`, `[rbp-8]`, `-8[rbp]`, `8[rsp]`,
  `name[rbp]` (`name` from `.equ`), `message[rip]`, `[rax+rbx*8+16]`, `array[rax*8]`,
  with optional `byte ptr` / `word ptr` / `dword ptr` / `qword ptr` (any case).
  `offset label` (and gcc's `OFFSET FLAT:label`) is the address of a label as a number.
- A bare `.equ` name is a number. A bare data label is a memory operand (as in gas).
- Friendly errors for common slips: AT&T syntax (`%rax`, `$5`, `movq`; a whole AT&T
  line gets the same line written the Intel way, destination first), NASM habits
  (`resb`, `equ`: the gcc line to write), `;` or `//` comments, unknown register (with
  "did you mean"), unknown instruction (with "did you mean"), a real instruction outside
  the teaching subset. At most 20 errors are listed, then one line says there are more.

### 3.3 Machine model

- **Registers**: 16 general registers, 64 bits each, stored as `bigint`. All 68 names
  are known (`rax/eax/ax/ah/al`, … `sil/dil/bpl/spl`, `r8`–`r15` with `d/w/b`).
- **Write rules** (the #1 beginner mistake; implemented once in
  `registers.ts::mergeRegisterWrite` and tested for every name):
  - 8-bit and 16-bit names change only their own bits;
  - **a 32-bit name zeroes the upper 32 bits**;
  - `ah/bh/ch/dh` are bits 15–8.
- **rip** always holds the address of the **next** instruction. Each instruction has a
  realistic byte size (see 3.6), so addresses look like the ones `gdb` shows.
- **Flags**: CF, ZF, SF, OF, each 0 or 1.
  - `add`, `sub`, `cmp`: all four, exactly as on the CPU.
  - `inc`, `dec`: ZF, SF, OF; **CF is left alone**.
  - `and`, `or`, `xor`, `test`: CF = OF = 0; ZF, SF from the result.
  - `imul`: CF = OF = 1 when the signed result does not fit (exactly as on the CPU).
    SF and ZF are officially **undefined** after `imul` on a real CPU. We set both from
    the result (a documented choice, stated in About), and the stepper warns when a
    jump reads ZF or SF that `imul` wrote: use `cmp` or `test` first.
  - `mov`, `lea`, `push`, `pop`, `call`, `ret`, jumps: flags unchanged.
- **Memory**: sparse, byte-addressed, little-endian. Regions:

  | Region    | Default start    | Notes                                                 |
  | --------- | ---------------- | ----------------------------------------------------- |
  | code      | `0x401126`       | not writable                                          |
  | read-only | `0x402010`       | `.string` etc. written in `.text` or `.rodata`        |
  | data      | `0x404030`       | `.data`, writable                                     |
  | stack     | `0x7ffffffde000` | grows **down**; 1 MiB; bytes nobody wrote are "unset" |

  When the code is longer than the room before the read-only data (or the data), that
  area moves to the next page after the code, as a linker does, so long programs never
  overlap their data.

  Anything else is unmapped: touching it stops the program with a friendly
  "segmentation fault" explanation. As on a real machine, the code and data areas are
  mapped in whole 4 KiB pages (a read a little past the last string reads 0), and the
  lowest addresses (0x0–0x3f) are never memory, so a NULL pointer always faults, also in
  the small layouts that practice problems use.

- **Starting state**: all registers 0 except rsp. The stack "starts" at
  `0x7ffffffde000`; the "OS" has already called `main`, so the 8 bytes just below hold a
  fake return address (`0x7ffff7c29d90`) and **rsp starts at `0x7ffffffddff8`**.
  `ret` from `main` pops that address and ends the program cleanly.
  _Why not start rsp at …e000?_ With rsp ending in 8 at entry, rsp ends in **0 at every
  correctly aligned `call`**, exactly like a real Linux machine. That makes the
  "multiples of 16" rule something students can see. `initialRsp` is configurable, and
  practice problems use random starting values.
- Execution starts at `main` if the label exists, otherwise at the first instruction.

### 3.4 Instructions

Supported (the course subset): `mov`, `movzx`, `movsx`, `lea`, `push`, `pop`, `add`,
`sub`, `inc`, `dec`, `imul` (2-operand), `cmp`, `test`, `and`, `or`, `xor`, `jmp`,
`je/jz`, `jne/jnz`, `jg`, `jge`, `jl`, `jle`, `ja`, `jae`, `jb`, `jbe`, `call`, `ret`,
`nop`.

Small extras that cost little and avoid dead ends: `leave`, `movsxd` (the 32-to-64-bit
`movsx`), `js/jns/jo/jno`, the usual jump spellings (`jnle`, `jnb`, `jc`, …), and
`endbr64` (treated as `nop`, because gcc output starts functions with it).

Rules that are enforced **and explained** when broken:

| Rule                                                                   | Code                    |
| ---------------------------------------------------------------------- | ----------------------- |
| No memory → memory                                                     | `memory-to-memory`      |
| A number cannot be the destination                                     | `immediate-destination` |
| Operand sizes must match                                               | `size-mismatch`         |
| Memory destination + number source needs a `ptr` size                  | `missing-size`          |
| `push`/`pop` take only 64-bit registers (or a number for `push`)       | `push-pop-operand`      |
| The number must fit in the destination                                 | `immediate-too-large`   |
| `ah/bh/ch/dh` cannot be mixed with `sil/dil/spl/bpl` or `r8`–`r15`     | `high-byte-rex`         |
| Addresses use 64-bit registers; scale is 1, 2, 4 or 8; rsp is no index | `address-register`      |
| `lea` needs a register and a memory expression; other bad combinations | `invalid-operands`      |

Example message: `Line 7: you can't move memory into memory. Load it into a register first.`

### 3.5 Library calls

`call printf@PLT` (or `call printf`), `scanf`, plus `puts`, `putchar`, `exit`.

- **Calls go through the real stack, in two visible steps.** Step 1 is the `call`
  instruction: it pushes the return address and jumps into the library, so the student
  **sees the return address appear on the stack**. Step 2 is the library function
  itself, run as one step: it does its job, puts its result in `eax`, and its `ret` pops
  the return address back into rip.
- `printf` reads the format string at `rdi`; arguments come from `rsi, rdx, rcx, r8, r9`
  (then the stack). Supports `%d %i %u %x %X %c %s %p %%`, the `hh`/`h`/`l`/`ll`
  length modifiers, width and precision (also `*`), and the `-`, `0`, `+`, space and
  `#` flags. Output goes to the Output panel. **Returns the number of bytes printed in
  `eax`**, like the real one (for plain ASCII text, the number of characters). Like glibc, `%p` of 0 prints `(nil)`. One call may
  print at most 65,536 characters, a program 1,048,576; both limits count characters
  (code points), so an emoji counts as one.
- `scanf` parses `%d`/`%i` (also `%u %x %c %s`, with the same length modifiers, widths
  and `*`) and writes to the addresses in
  `rsi, rdx, …`. If no input is waiting, the emulator pauses with status
  `waiting-input`; the UI shows an input box and calls `provideInput(text)`. Input that
  does not match stays in the input, as in C (a note says so).
- **Realism option (on by default):** after a library call the caller-saved registers
  (`rcx, rdx, rsi, rdi, r8`–`r11`) hold junk, as they do on a real machine, and the
  explanation says so. A student who keeps a loop counter in `rcx` across `printf`
  finds the bug here instead of in graded homework.
- A warning note appears when rsp is not a multiple of 16 at a `call` (real `printf`
  can crash there).
- `exit` explains the exit code the shell sees: the lowest 8 bits of the value in `edi`
  (`exit(300)` gives 44). A `ret` from `main` names the value it returned in `eax`.

### 3.6 Instruction sizes

Each instruction gets its **real x86-64 encoding length**, computed by a small rule
table documented at the top of `sizes.ts`:

| Part         | Bytes                                                                       |
| ------------ | --------------------------------------------------------------------------- |
| prefix `66`  | 1 for 16-bit operands                                                       |
| REX          | 1 for 64-bit operands, `r8`–`r15`, `sil/dil/spl/bpl`                        |
| opcode       | 1 (2 for `movzx`, `movsx`, `imul r, r/m`, near `jcc`)                       |
| ModRM        | 1 when there is a register/memory operand pair                              |
| SIB          | 1 for an index register, an rsp/r12 base, or an absolute address            |
| displacement | 0, 1 (fits a signed byte) or 4; rip-relative and absolute: 4                |
| immediate    | 1 when a short signed form exists and fits, else 1/2/4 (8 for a 64-bit mov) |

So `push rbx` = 1, `mov rbp, rsp` = 3, `mov eax, 0` = 5, `sub rsp, 16` = 4,
`lea rdi, msg[rip]` = 7, `call` = 5, `ret` = 1; `jmp`/`jcc` are 2 bytes when the target
is near, else 5/6. The table is checked against a real assembler by a fixture
(`scripts/make-size-fixture.mjs`: 427 instruction forms and 25 small programs, 23 with
jumps and calls and 2 with addresses, assembled with clang for a Linux target). Where clang and GNU `as` pick different encodings (only
`add rax, offset label` and its relatives were found), the table follows clang, which is
what we could measure.

### 3.7 Execution API

```ts
const result = assemble(source, options) // { ok, program, diagnostics }
const emu = new Emulator(result.program, options)

emu.step() // StepResult: diff + explanation + notes + status
emu.stepBack() // undo one step (history of diffs, not full copies)
emu.run() // until end / breakpoint / input needed / error / 10 000 steps
emu.reset()
emu.setBreakpoints([7, 12])
emu.toggleBreakpoint(9)
emu.provideInput('42\n')
emu.getSnapshot() // immutable MachineState for the UI
emu.subscribe(fn) // change notifications (fits React's useSyncExternalStore)
```

- **Diff**: every step lists the registers, flags and memory bytes that changed (with
  before/after) plus rip. The UI uses it for highlighting.
- **Explanation**: one to three short sentences with the real numbers, for example
  `` `push rbx`: rsp went down by 8 (0x…dff8 → 0x…dff0), then rbx's value 0x5 was copied
into the new top box. ``
- **Stack view**: 8-byte boxes, high addresses first, each with a label when known
  ("return address (back to line 12)", "saved rbp", an `.equ` name such as "count"),
  flags for where rsp and rbp point, and whether the box is a leftover below rsp.
- **Run guard**: `run()` stops after 10 000 steps with "The program ran 10,000 steps
  without ending, so it may be stuck in a loop that never ends: check the jump that
  should end it." The stepper's auto-play (speeds 1–9) stops after 1,000 steps with the
  same sentence, which then says "1,000 steps" (`AUTO_PLAY_MAX_STEPS` in
  `src/features/stepper/session.ts`).
- **Run-time errors are lessons**, e.g. `ret` popping something that is not a return
  address: "the top of the stack did not hold a return address. Did you push something
  and forget to pop it?" A bug inside the emulator itself never crashes the page: it
  stops the program with the run-time code `'internal'`.
- **Explanations stay short**: at most 400 characters, also for the last step of a
  program that stops with an error. Only a very long label name (about 80 characters or
  more) can make one longer.

### 3.8 Tests

- Unit tests per module, plus whole-program tests: sum low-to-high loop, iterative
  factorial, Hello World + character count, every example in the dropdown.
- Every illegal form → its exact error code and message.
- Ground truth from real x86-64 execution (clang; through Rosetta 2 on an Apple Silicon
  Mac), stored as fixtures that unit tests replay on every `npm test`, so the tests
  themselves need no compiler:
  - `alu-truth.json` (`make-truth-fixture.mjs`): 4,660 single instructions with their
    result and flags, and every register name as a destination;
  - `cpu-fuzz.json` (`make-cpu-fuzz-fixture.mjs`): 600 random programs with the final
    registers, flags and memory;
  - `encoding-sizes.json` (`make-size-fixture.mjs`): instruction sizes.
- Tests written "blind" from the behaviour contract by an engineer who may not read the
  implementation (`*.blind.test.ts`), and property tests (`*.property.test.ts`).
- `npm run verify:native` (optional): builds every example as a real program and
  compares it with the emulator **instruction by instruction**: with gcc + gdb on
  x86-64 Linux, with lldb or a built-in single-step tracer on a Mac; if no stepping is
  possible it compares the printed output; it skips cleanly when no compiler is found.

---

## 4. Pages

1. **Home**: one sentence + three big buttons (Step Through Code, Learn, Practice).
2. **Stepper**: CodeMirror editor (highlighting, line numbers, current line,
   breakpoints) · Step / Back / Run / Reset + speed slider · Registers (16 + rip, click
   to expand into 64/32/16/8 parts with shaded bits, changed values flash) · Stack
   (boxes, rsp and rbp arrows, labels, new boxes slide in) · Flags (four lights with
   explanations) · Explanation · Output (+ scanf input box) · Examples dropdown (Hello
   World, Hello World + count, push/pop swap vs. restore, locals with `.equ`, sum loop,
   factorial, power, max of an array, nested call, read a number) · Share link.
3. **Learn**: 14 short lessons, each with one idea, one everyday analogy, one tiny live
   example in a MiniStepper, one check question with instant feedback, and a Next
   button. Finishing the check marks the lesson done.
4. **Practice**: unlimited generated problems, answer keys computed by the emulator:
   register names · sub-register writes · rsp tracker · rip · call/ret · indirect
   addressing (mov vs. lea) · legal or illegal mov · homework-style table with
   drag-and-drop chips (tap-to-place on phones) · 15-question mixed quiz.
   Every wrong answer shows the right one, a one-line reason, the **named mistake**
   when recognised (forgot to zero the top half, decimal instead of hex subtraction,
   rsp moved the wrong way, return address put in rip, address vs. contents, stale
   register value, part left blank), and a "Show me" button that opens the stepper with
   that exact problem loaded.
5. **Cheat sheet**: one page that prints onto a 3×5 index card (about 6 pt, one side)
   or a letter page.
6. **Progress**: lessons done, accuracy per topic, three weakest topics, "Practice my
   weak spots", reset. Stored in `localStorage` (wrapped in try/catch).
7. **AI tutor** (optional, off by default): a chat drawer on Stepper and Practice.
   Hidden completely unless the server function reports that a key is configured. It is
   not on the mixed quiz (or the practice hub): the quiz works like a test.
8. **About**: what the emulator covers and what it does not.

### Design language

- Calm "paper notebook" look: warm off-white page, white cards, one blue for actions.
  Dark mode is a real second theme, not an afterthought.
- **Color-blind safe**: blue = action and rsp, purple = rbp, orange = "just changed",
  teal = right, burnt orange = wrong. Never red against green, and never color alone:
  a changed value is also **bold with a dot**, feedback always has an icon and a word.
- System fonts (no web-font download); monospace for anything a student might type.
- Phone first: at 360 px nothing scrolls sideways; controls are thumb-sized.
- Keyboard: shortcuts for Step / Back / Run (listed in a help popover), visible focus
  outlines, labels on every control, live regions for explanations and feedback.

### Writing rules (lessons, problems, emulator messages)

Short sentences. Common words. One idea per sentence. No idioms. The same word for the
same thing every time: a **box** is 8 bytes of stack, the **top of the stack** is where
rsp points, `mov` **copies**. Numbers a student must type are shown in hex with `0x`.
All text is original; nothing is copied from a textbook or course slides.

---

## 5. Milestones

Each milestone ends with: unit tests green, lint and typecheck clean, the app run and
checked in a real browser with Playwright (screenshots at 1280 px and 360 px saved in
`docs/screenshots/`), problems fixed, and a `CHANGELOG.md` entry.

| #   | Milestone                                | Done when                                                                                              |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Setup, parser, register model, app shell | Toolchain works end to end; parser + assembler + register/memory/ALU modules tested; site shell loads  |
| 2   | Full emulator                            | All instructions, stack, call/ret, flags, printf/scanf, history; sample programs print expected output |
| 3   | Stepper page                             | All panels, step/back/run/reset, speed, breakpoints, examples, share links, shortcuts                  |
| 4   | Lessons                                  | 14 lessons with MiniSteppers and check questions; done-tracking                                        |
| 5   | Practice                                 | All generators + checker + named mistakes + drag-and-drop table + mock quiz + "Show me"                |
| 6   | Cheat sheet and progress                 | Prints on one 3×5 card side and on a letter page; progress page with weak spots                        |
| 7   | Optional AI tutor                        | Function + drawer; hidden without a key; rate limited; refuses to write homework                       |
| 8   | Polish                                   | Accessibility pass, phone pass, bundle under 300 KB gzip first load, full Playwright suite, README     |

Milestones 4–7 do not depend on each other, only on 1–3, so they are built side by
side and each is checked in the browser on its own.

All eight milestones are done (see `CHANGELOG.md`). Not tried yet, because they need
the owner's accounts or another machine: a live tutor call with a real API key; real
GitHub Pages, Vercel and Netlify deploys (the repository has no remote yet, so the Pages
workflow has never run); and `npm run verify:native` in its gdb mode on x86-64 Linux
(tested only with recorded gdb output).

---

## 6. Decisions worth knowing about

1. **rsp starts at `0x7ffffffddff8`**, 8 below the stack start, for true alignment (3.3).
2. **Library calls take two steps** and leave junk in caller-saved registers (3.5).
3. **Real encoding sizes** rather than a rough table (3.6).
4. **Leading-zero numbers are an error**, never silent octal (3.2).
5. **Hash router of our own**; share links are `#/stepper?s=<encoded program>`.
6. **TypeScript 6.0 and ESLint 9** because of plugin support (section 1).
7. **Extras beyond the brief**: `leave`, `endbr64`, more jump spellings, `puts`,
   `putchar`, `exit`, the data directives, a "read a number" example for scanf.
8. **Tutor model**: `claude-opus-5-5` by default, overridable with `TUTOR_MODEL`.
9. **`imul` leaves SF and ZF undefined on a real CPU.** The emulator sets them from the
   result and warns when a jump depends on them (3.3).
10. **Pages import the emulator only through `src/emulator/index.ts`**; the UI never
    reaches into single emulator files.
11. **Contracts first**: `src/emulator/types.ts`, `src/features/practice/types.ts`,
    `src/features/lessons/types.ts`, `src/components/ministepper/types.ts` and
    `src/features/stepper/editor/types.ts` were written before the code behind them, so
    several parts could be built side by side and tested against the same shapes.
12. **Where the contract and real Linux disagreed, real Linux won** (decided after the
    M2 reviews): `%p` of 0 prints `(nil)`, unread scanf input stays in the input, memory
    comes in whole pages, a NULL pointer always faults. Reading code bytes still gives 0
    (the emulator stores no machine code), with a warning that says so.
13. **Ownership while building**: each engineer owned a list of files and asked the lead
    for changes elsewhere, so several engineers could work in one folder at once.
14. **The memory-to-memory message keeps the brief's own sentence** ("you can't move
    memory into memory. Load it into a register first."), although the writing rules say
    `mov` copies: it is the example the brief gives, so students and teachers who read
    the brief see the same words on the site.
