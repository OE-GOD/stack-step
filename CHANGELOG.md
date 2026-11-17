# Changelog

What each milestone added, the newest milestone first.

## Milestone 8: polish (accessibility, phones, speed, tests, README)

### Three audits, then fixes

- A browser audit of every page at 360 and 1280 px, in light and dark, with the keyboard
  only and with axe; a code audit (bugs, the tutor's security, the bundle, dead code,
  huge programs); and a content audit that checked every sentence outside the lessons
  and practice (cheat sheet, Home, About, examples, emulator messages, README) against
  the emulator. Five engineers then fixed the findings, each in their own files.

### Accessibility and phones

- New `e2e/a11y.spec.ts`: axe (WCAG 2.1 A and AA) on every page and on the important
  states (the stepper mid-run and waiting for input, a wrong practice answer, a quiz
  question, the progress reset dialog, the tutor drawer), in light and dark, at both
  sizes. 92 checks, 0 violations, no rule switched off.
- The name of every link and button contains its visible words. Home cards, Progress
  rows, register rows and stack boxes (with all 16 digits) start with them; an empty
  trace-table cell says its line first ("Line 1, changed: empty, put a chip here").
- Boxes that scroll (Explanation, Data, Output) can be reached and scrolled with the
  keyboard, show a focus ring, and fade at the edge when there is more text.
- The keyboard focus never hides under a sticky bar (the practice Check bar, the quiz's
  Back and Next). After Check, the feedback and "Next problem" come into view together.
- Text a student must read is at least 14 px on a phone: flag captions, badges, the step
  heading, the MiniStepper's labels, the trace table, code chips. Code listings are 14
  px (15 px in practice problems). The skip link is inside the header.
- Colors: the current line stands out more (1.43:1 against the code background in the
  light theme), and "changed" differs from "wrong" and "warning" in lightness, not only
  in hue. Every text color still meets WCAG AA.

### Stepper

- A link (a practice "Show me" or a shared program) never costs the student's own saved
  program. The Example menu offers "Your own program" or "Your earlier program", and a
  link opened right after typing waits for the save.
- A practice "Show me" note keeps its whole height on a laptop, and the notes about a
  missing `.intel_syntax` or `main:` line are hidden for these links.
- One line above the code says when the browser cannot save the program.
- Text inserted all at once without a paste event (5,000 lines) takes 0.8 s instead of
  18 s.
- rip shows 16 digits in groups with "line N" under them; step numbers have commas;
  "Line N" buttons have a 44 px touch area; a breakpoint on a line with no instruction
  gets a quiet note; an opened stack box scrolls its bytes into view; on a phone the
  MiniStepper shows its explanation right after the buttons and about 7 lines of code.

### Practice

- The practice hub no longer downloads the problem makers or the emulator.
- Trace table: 14 px chips with gaps between the hex digit groups. On phones narrower
  than about 426 px the chip tray waits under the table. The page no longer jumps 20 px
  when a drag starts. The trace-table tests also run on the real practice page.
- Answer fields stop at 64 characters, and a saved quiz with a longer answer is cut
  instead of lost.
- Clearer words: "Wrong", "Right answers one after another", the quiz's first sentence,
  and "mixed quiz" everywhere.
- The tutor sees the words on the chips and choices, not their ids.
- Found by the final checks and fixed, each with a new browser test:
  - on a 360 px phone, a call-and-ret problem with a long `lea` line made the page 16–25
    px wider than the screen; the code box now scrolls by itself;
  - the answer "Illegal: memory needs a size (byte/word/dword/qword ptr)" could not
    break, so with its "Right answer" mark it stuck out of the card on a phone, and the
    quiz results scrolled sideways. It now reads "(byte, word, dword or qword ptr)" and
    may break.
- Shorter reasons after a wrong answer: an illegal `mov` gets the rule in at most two
  sentences (the assembler's advice stays in the stepper), and "Follow rsp" shows one
  decimal amount in hex instead of two.
- The practice hub and the Progress page say the recent answers in the same words ("1
  right of 1 answer"), and the number never starts a line alone.
- The tutor is not on the mixed quiz, because the quiz works like a test (now written in
  the README and the plan).

### Lessons

- Long hex values in lesson text are written in groups of four, like the panels.
- All lesson code uses a two-space indent, so every line fits the 14 px phone listing.
- The Learn page says when the browser cannot save progress (one "Not saved" note, the
  same on Learn, Practice and Progress).

### Emulator

- A line in AT&T syntax gets the same line written the Intel way (`movq %rbx, %rax` →
  `mov rax, rbx`, destination first). NASM's `resb` and `equ` get the gcc line to write.
  `.comm` gets a warning that says what to write instead. An empty `main:` gets a
  warning. After 20 errors one line says there are more.
- Long code no longer overlaps the read-only data: the data moves to the next page after
  the code, as a linker does.
- The output limits count characters (an emoji is one).
- Jump explanations start with what the comparison means, for example: "after
  `cmp ecx, edx`, it jumps when ecx > edx (as signed numbers)." The tip about junk
  registers is shorter. `exit` names the exit code the shell sees (300 → 44). `scanf`
  names three values and counts the rest. Every explanation stays within 400 characters,
  unless a label name is very long (about 80 characters or more).
- Example comments and descriptions corrected; a new run-time code, `'internal'`, for a
  problem inside the emulator itself.

### Tutor

- The per-address limit is now 300 an hour, half of the 600 for everyone, so one network
  cannot lock out the others.
- A reply cut off at the token limit is marked `cut`: the drawer keeps the text, says it
  was cut off, and offers "Try again".
- When the API spend limit is reached, the student reads "The tutor cannot answer more
  questions right now. Please tell your teacher."

### The rest of the site

- About and the cheat sheet corrected line by line (the directive list, `.comm`,
  `movsxd`, printf sizes and widths, what the tutor is sent).
- Build-phase leftovers removed ("Coming soon" states, unused exports). The share-link
  decoder limits the step count to 1–10,000 and the stack to 1 MiB.
- `README.md` written: what the site is, how to run it, free deploys (GitHub Pages,
  Vercel, Netlify), turning on the tutor, the assembly it understands, and the known
  limits. Its claims were checked against the code by a separate review; the deploy
  steps have not been tried with real accounts.

### Final check

- From a clean copy of the project: `npm ci`, `npm run build`, `npm run dev` and
  `vite preview` all work, with no console error and no sideways scrolling.
- After the last fixes: type check, ESLint and Prettier are clean. Vitest: 84 files,
  10,143 tests, all pass. `npm run verify:native`: 10 programs, 308 steps, all matched.
- Playwright: 647 passed on the built site and 855 on the dev server, 0 failed (the
  skipped tests belong to the other screen size or to dev-only test pages).
- 4,463 page states (200 problems of every topic, shown and checked; 40 quizzes with
  every question and their results; every lesson; every page) have no sideways
  scrolling at 360 px, and also at 320 px.
- First-load JS is 80.56 kB gzip (the budget is 300 kB). CodeMirror is only in the
  stepper's lazy chunk, and each lesson is its own chunk.
- No key, SDK or API name in any built file.
- 56 screenshots of every page in `docs/screenshots/final/`.

## Milestone 7: the optional AI tutor (live call and real deploys not yet tried)

- One small serverless function (`api/tutor.ts` for Vercel, `netlify/functions/tutor.ts`
  for Netlify, served by `server/devPlugin.ts` during `npm run dev`) calls the Anthropic
  Messages API with the official SDK. The key is read from `ANTHROPIC_API_KEY` on the
  server only; a test builds the site and checks that no output file mentions the key,
  the SDK or the API.
- Without a key the function answers `{ "enabled": false }` and the site shows no tutor
  at all. On a static host (GitHub Pages) the request simply fails and the tutor stays
  hidden.
- The system prompt makes the tutor give hints and questions before answers, keep replies
  short and plain, treat everything from the page as data, and refuse graded homework,
  whole programs and translations of assignments.
- Strict request checks (sizes, roles, at most the 12 newest messages), rate limits (8 a
  minute and 60 an hour per page load; 60 a minute and 600 an hour per address; 600 an
  hour per function instance; plus Netlify's own rule; Vercel needs one firewall rule,
  see the README), streaming replies with a Stop button, and a clear marker when a reply
  is refused, empty or broken off. (Milestone 8 added one for a reply cut at the token
  limit, and lowered the per-address hour to 300.)
- Drawer: a native `<dialog>`, keyboard and screen-reader friendly, a bottom sheet on
  phones. 235 server tests, 94 drawer tests, `e2e/tutor.spec.ts`.

## Milestone 6: cheat sheet and progress page

- `/cheatsheet`: every fact a beginner needs on one side of a 3×5 inch index card
  (about 6 pt, four columns) and on one letter page. Its register and jump tables come
  from the emulator's own tables. The printed fonts are pinned so that Safari cannot
  swap in a wider code font. Browser tests print both versions to PDF and check one
  page, the paper size and the font size.
- `/progress`: lessons done, practice accuracy per topic, the three weakest topics with
  "Practice my weak spots", mock quiz scores, and a reset that asks first (native
  `<dialog>`). Everything stays in this browser.
- 95 unit tests; `e2e/cheatsheet.spec.ts` and `e2e/progress.spec.ts`.

## Milestone 5: practice

### Problems that check themselves

- Eight kinds of problems: register names, writing part of a register, follow rsp, where
  is rip, call and ret, address or contents, legal or illegal `mov`, and the trace
  table. Each one is made from a seed (`?seed=N` opens exactly that problem), and its
  answer key comes from running the problem in the emulator.
- A wrong answer names the mistake with the problem's own numbers ("You kept the old top
  half (0x4231788a)…"), and a carried slip is not blamed twice: a step worked out
  correctly from the student's own earlier wrong answer counts as carried.
- "Show me" opens the problem in the stepper; "Step through it here" opens a MiniStepper
  under the problem.
- `/practice` hub with recent accuracy per topic; `/practice/<topic>` endless practice;
  `/practice/weak` mixes the weakest topics (wrong answers first, then untried ones);
  `/practice/quiz` is a 15-question mock quiz with a question map, a results page that
  folds right answers away, and it survives a reload.
- Answers: hex with or without `0x`, any case, spaces allowed; the 16-digit rule with a
  digit counter; a size may be typed with its unit ("4 bytes").

### Checked by an attack on the answer keys

- A reviewer solved problems by hand and with independent code (thousands of seeds per
  topic) and tried to make a correct student be told they were wrong. Every finding was
  fixed: no mistake is named for a right answer, and a habit across a whole trace (such
  as 4-byte boxes) is named as that habit.
- A browser review (phone, keyboard, designer) led to: a guard against double taps on
  Check / Next, one sticky layer for the trace table, the named mistake first on
  phones, and digits grouped in fours.
- 517 unit tests; `e2e/practice.spec.ts` and `e2e/trace-table.spec.ts`, including the
  trace table on the real page at five screen sizes.

### Trace table with drag-and-drop chips

- The homework-style table: the student places answer chips in the "changed" cell of
  each line by dragging with a mouse, by tapping a chip and then a line on a phone, or
  with the keyboard. Screen readers hear every move.
- 208 unit tests and 52 browser tests (real mouse drags, real taps, keyboard only).

## Milestone 4: the lessons

- `/learn` lists fourteen lessons, from "Registers are your hands, memory is the fridge"
  to "The calling convention"; `/learn/<id>` shows one. Each lesson has one idea, an
  everyday comparison, a short text (under about 250 words), an example to step through
  with "Watch for" notes, a check question, a short "Remember" list, and links to the
  next lesson and to the matching practice.
- Check questions come in three kinds: choices, a hex value, or a word. Expected wrong
  answers get their own feedback; an incomplete answer gets a neutral note, not "Not
  yet". A right answer marks the lesson done.
- Every number in the text comes from running the example in the emulator. Content tests
  check every lesson file: forbidden words, code lines short enough for a 360 px phone,
  hex answers that cannot be copied from the same page, and more.
- Each lesson is its own small download (1.3 to 2.0 kB gzip), loaded when it is opened or
  when its link is pointed at.
- Reviewed twice (every example re-run and every claim checked; then the pages used on a
  phone, with the keyboard and as a designer) and fixed: three false statements
  corrected, every code line fits at 360 px, phone layout and touch scrolling improved.
- 161 unit tests; `e2e/lessons.spec.ts` (29 tests, including every lesson at 360 and
  320 px).

## Milestone 3: the stepper page

### The page

- `/stepper`: the code editor, Step / Back / Run (with a speed slider; 10 is instant) /
  Reset, the registers (each opens into `eax`, `ax`, `ah`, `al` with bytes, unsigned and
  signed values), the flags, the stack (boxes with rsp and rbp arrows, labels, offsets
  from rbp, leftover boxes), the output with the scanf input box, the data, and one
  explanation per step with a "Next:" line.
- Wide screens: three columns with no page scroll. Phones: one column, tabs for
  Registers / Stack / Output with change dots, and a fixed bar of thumb-sized buttons.
- Examples menu (the student's own program is kept and can be brought back), share links,
  keyboard shortcuts (Ctrl/Cmd + Enter steps; S, B, R and 0 outside the editor, with a
  switch to turn them off), breakpoints that follow their line through edits.
- Protecting the student's work: the program is saved in the browser, typing while Run
  plays pauses it, Reset can be undone, a link opened by mistake does not replace the
  student's program.
- The same panels in a small form make the MiniStepper that lessons and practice use.
- `src/features/stepper/session.ts`: one program, one emulator, auto-play, breakpoints and
  input, without React, so it is tested on its own.

### Reviews and fixes

- Reviewed in a real browser (student, teacher, accessibility) and in the code with
  measurements; every must-fix and should-fix finding in the stepper's files was fixed:
  a stack list that stays short however deep the stack, junk registers marked as junk
  instead of "changed", the line that just ran and the line of a run-time error marked
  in the editor, focus that never jumps away, buttons that stay focusable when
  unavailable, and more room for the explanation.
- 520 unit tests in the stepper and machine-panel folders; `e2e/stepper.spec.ts` and
  `e2e/editor.spec.ts` pass in dev mode and against the production build.

### Code editor (done)

- CodeMirror 6 editor in its own lazy chunk (about 103 kB gzip, loaded only on the
  stepper page), colored by the same tokenizer as every other code listing.
- Gutter with line numbers, breakpoints (click, tap, or Ctrl/Cmd + B), an arrow on the
  line that runs next, an hourglass while a library function runs, and marks for errors
  and warnings whose message opens under the line.
- Keyboard: Tab indents with spaces, Escape then Tab leaves the editor, a hidden
  summary and live announcements for screen readers.
- 139 unit tests and 48 browser tests per screen size (desktop and phone).

### Share links (done)

- `src/lib/share.ts`: a program, and for practice problems the starting state of the
  machine, travels inside the link (`#/stepper?s=v1.…`). Nothing is stored on a server.
  23 tests.

## Milestone 2: the full emulator

### Running programs

- `src/emulator/executor.ts`, `libc.ts`, `emulator.ts`: every supported instruction, run
  as effects first and committed only when nothing faults, so a step does all of its work
  or none of it. `step`, `stepBack` (exact undo, at least 20,000 steps back), `run` (stops
  at the end, an error, a breakpoint, input or the step limit), `reset`, breakpoints,
  `subscribe` / `getSnapshot` for React.
- Library calls take two visible steps (the `call` pushes the return address, then the
  function runs and returns). `printf`, `scanf` (it pauses and asks for input), `puts`,
  `putchar`, `exit`. After a call the caller-saved registers hold junk, as on a real
  machine, and a note says so. A `call` with rsp not a multiple of 16 gets a warning.
- `explain.ts`: one to three plain sentences per step with the real numbers ("`push rbp`:
  rsp went down by 8 (0x…dff8 → 0x…dff0), then rbp's value 0x0 was copied into the new
  top box."), plus tips and warnings, and friendly run-time errors (`runtimeErrors.ts`).
- Behaviour that follows a real Linux machine (decided after the reviews): memory is
  given in whole 4 KiB pages; addresses 0x0–0x3f are never memory, so a NULL pointer
  always faults; `%p` of 0 prints `(nil)`; input that scanf cannot read stays in the
  input, as in C; reading the program's own code as data gives 0 with a warning that a
  real machine gives the machine code. One call may print at most 65,536 characters and
  a program 1,048,576.
- New option `labelStartBox`, so a practice problem can show its own value in the box
  where rsp starts.

### Checked three ways, then fixed in three rounds

- 672 black-box tests written from the contract alone, 16 property tests over 310
  generated programs (exact undo, honest diffs, run = a loop of steps, reset = fresh), a
  white-box code review, and a plain-language review of every message.
- Every finding was fixed and confirmed by a separate engineer. The emulator now has
  8,009 tests; all 600 real-CPU programs and 4,660 instruction results agree;
  `npm run verify:native` matched every step of the ten examples (308 steps) and of 40
  more random programs (2,677 steps) on real x86-64.

### Ground truth from a real CPU

- `scripts/make-cpu-fuzz-fixture.mjs`: 600 random programs (28,342 instructions, every
  supported instruction form, every register name, all 14 jump conditions taken and not
  taken) were run as real x86-64 code and their final registers, flags and memory
  stored in `src/emulator/__fixtures__/cpu-fuzz.json`. `cpu-fuzz.test.ts` replays them
  in the emulator on every `npm test`.
- `npm run verify:native`: builds every example as a real program and compares it with
  the emulator instruction by instruction (gdb on x86-64 Linux; lldb or a built-in
  single-step tracer on a Mac), or compares the printed output when stepping is not
  possible, or skips with one clear line when there is no compiler.
  `-- --fuzz p0042 --show-steps` shows the first instruction where the two part.
- `scripts/run-ts.mjs`: runs a scratch TypeScript file that imports the sources.

## Milestone 1: setup, parser, register model, app shell

### Project setup

- Vite 8 + React 19 + TypeScript 6.0 (strict) + Tailwind CSS 4.
- ESLint 9 (type-checked rules, react-hooks, jsx-a11y) and Prettier; `npm run check` runs
  typecheck, lint, format check and unit tests.
- Vitest for unit tests; Playwright with a desktop (1280×800) and a phone (360×740)
  project. Each run can use its own port, build folder and dependency cache, so several
  runs can go on side by side.
- `scripts/screenshots.mjs`: opens pages in a real browser, saves desktop and phone
  screenshots, and fails on horizontal scrolling or console errors.
- Semantic, color-blind-safe design tokens with light and dark themes (`src/index.css`);
  the theme is chosen before first paint.

### Emulator foundations

- `src/emulator/types.ts`: the shared contract (registers, operands, program, step
  results, machine snapshot, public API).
- `src/emulator/registers.ts`: all 68 register names and the sub-register write rules
  (8/16-bit writes keep the other bits, 32-bit writes zero the top half, `ah/bh/ch/dh`
  are bits 15–8), with 70 tests.
- `memory.ts` (sparse little-endian memory with regions and faults), `alu.ts` (add, sub,
  inc, dec, imul, logic, all four flags, the 14 jump conditions), `format.ts` (hex
  display and hex-answer parsing): 845 tests.
- `alu.truth.test.ts`: 4,660 single instructions whose results and flags were recorded
  from real x86-64 execution (`scripts/make-truth-fixture.mjs`); the emulator agrees on
  every defined result. Finding: after `imul`, SF and ZF are undefined on a real CPU;
  the emulator sets them from the result and says so.

### Parser and assembler

- `assemble(source, options)` turns program text into a `Program`, or into a list of
  beginner-friendly errors that start with the line number (29 error and warning codes,
  98 message variants, all in `errors.ts`). It never throws.
- Intel syntax as gcc writes it: labels, `#` comments, the directives a course uses,
  decimal / hex / negative numbers, and every memory operand spelling (`[rax]`,
  `[rbp-8]`, `-8[rbp]`, `name[rbp]`, `message[rip]`, `byte/word/dword/qword ptr`).
- Every rule the course teaches is enforced and explained: no memory-to-memory `mov`,
  no number as a destination, sizes must match, memory + number needs a `ptr` size,
  `push`/`pop` take 64-bit registers.
- Real instruction sizes, so addresses and rip look like the ones gdb shows. Checked
  against a real assembler: 427 instruction forms and 25 jump programs agree on every
  line (`scripts/make-size-fixture.mjs`).
- Checked by 2,207 black-box tests written from the contract alone; all pass.
- Labels may have the name of an instruction (`loop:`, `add:`, `test:`); only register
  names and the size words are refused.
- Characters pasted from slides or phone keyboards (curly quotes, dashes, wide letters)
  get a message that shows the corrected line; odd spaces get a warning.
- A constant used before its `.equ` line gets a warning, because gcc would read it as a
  memory address there.
- String escapes give the same bytes as gcc (octal, `\x41`, `\b`, `\f`).

### App shell

- Hash router (works on any static host), app shell with skip link, header, phone
  menu, theme switch and footer; shared UI kit; Home, About and Not Found pages.
- `storage.ts` (never throws), `progress.ts` (lessons done, accuracy per topic, weakest
  topics, in-memory fallback, two-tab sync), `theme.ts`.
- 296 unit tests; `e2e/shell.spec.ts` (92 passing across desktop and phone).

### Shared pieces for the pages

- Ten example programs (`src/examples`), each confirmed to print its expected output
  when assembled and run as a real x86-64 program.
- `asmHighlight.ts` (one tokenizer for all code on the site), `rng.ts` (seeded random
  numbers, so a practice problem can be rebuilt from its seed).
- Practice contract and answer checker (`src/features/practice/types.ts`, `check.ts`):
  hex answers with or without `0x`, any case, spaces allowed; the 16-digit rule; blank
  parts named.
