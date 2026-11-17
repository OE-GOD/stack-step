# Stack Step

Stack Step is a website for learning beginner x86-64 assembly (Intel syntax, as GNU `as`
and `gcc` write it). It is made for community-college students, many of whom are
learning English, so every page uses short sentences and plain words.

Students type a program and run it one instruction at a time. After every step they see
the registers, the stack, the flags and the output, and a short, plain explanation (one
to three sentences) of what the step did, with the real numbers. The emulator that runs
the programs is written in TypeScript and runs entirely in the browser: no server, no
sign-in, no tracking. Progress is kept in the browser's own storage.

## What is on the site

- **Stepper**: a code editor with breakpoints; Step, Back, Run and Reset; a speed
  slider; ten example programs; and share links that carry the whole program inside the
  link (up to about 74 kB of code).
- **Learn**: fourteen short lessons, from registers and memory to the calling
  convention. Each one has a small stepper to try and a check question.
- **Practice**: eight kinds of problems, made fresh from a seed, with answers worked out
  by the emulator itself. A wrong answer names the mistake ("you kept the old top half"),
  and "Show me" opens the problem in the stepper. The trace table works with drag and
  drop, with taps on a phone, and with the keyboard. A 15-question mixed quiz covers all
  eight kinds.
- **Cheat sheet**: everything on one 3×5 inch index card (about 6 pt) or one letter
  page, ready to print.
- **Progress**: lessons done, accuracy per topic, the three weakest topics, and quiz
  scores, with a reset button.
- **AI tutor** (optional, off unless you turn it on): a drawer on the stepper and on
  practice problems that gives hints and asks questions. It does not do homework, and it
  is not in the mixed quiz, because the quiz works like a test.

## Run it on your computer

You need [Node.js](https://nodejs.org) 22.18 or newer.

```sh
npm install
npm run dev
```

Then open the address it prints (usually http://localhost:5173).

| Command                 | What it does                                                            |
| ----------------------- | ----------------------------------------------------------------------- |
| `npm run dev`           | Development server with live reload (it also serves the tutor)          |
| `npm run build`         | Type check, then build the static site into `dist/`                     |
| `npm run preview`       | Serve the built `dist/` folder                                          |
| `npm test`              | Unit tests (Vitest)                                                     |
| `npm run test:e2e`      | Browser tests (Playwright) at desktop (1280 px) and phone (360 px) size |
| `npm run check`         | Type check, lint, format check and unit tests                           |
| `npm run verify:native` | Compare the emulator with real x86-64 code (see below)                  |
| `npm run screenshots`   | Screenshot the routes you list (see below)                              |

The first time you run the browser tests, install the browser they use:
`npx playwright install chromium`.

Stop `npm run preview` before you run `npm run test:e2e`. Both use port 4173, and the
tests would then check the old `dist/` folder instead of a fresh build.

`npm run screenshots` needs a dev or preview server that is already running. It takes
desktop and phone screenshots of the routes you list, saves them in
`docs/screenshots/latest/` (or in the folder after `--out`), and checks them for sideways
scrolling and console errors:
`npm run screenshots -- --base http://localhost:5173 --routes "/,/stepper,/learn"`.

## Put it online for free

`npm run build` makes a plain static site in `dist/`. It uses relative paths and `#/`
addresses, so it works in any folder of any static host without redirect rules.

These deploy steps have not been tried yet with real GitHub, Vercel or Netlify accounts,
and the tutor has not yet answered with a real API key. After your first deploy, open the
site and try it. If something does not work, read the build log and the function log of
your host.

### GitHub Pages (no tutor)

The workflow `.github/workflows/deploy-pages.yml` is ready (it has not run yet).

1. Push the project to a GitHub repository. On a free GitHub account the repository must
   be public: GitHub Pages works with private repositories only on paid plans.
2. In the repository: Settings → Pages → Build and deployment → Source: **GitHub
   Actions**.
3. Push to `main`. The workflow runs `npm run check`, builds the site and publishes it at
   `https://<user>.github.io/<repository>/`.

GitHub Pages cannot run the tutor's server function, so the tutor stays hidden there.
Everything else works. The browser console shows one 404 error for `/api/tutor`; that is
expected.

### Vercel (tutor possible)

1. Import the repository in Vercel. `vercel.json` already sets the build command, the
   output folder and the tutor function (`api/tutor.ts`).
2. Deploy. The site works now, without the tutor.
3. To turn the tutor on, follow [Turn on the tutor](#turn-on-the-tutor).

### Netlify (tutor possible)

1. Import the repository in Netlify. `netlify.toml` already sets the build and the
   functions folder (`netlify/functions/tutor.ts`).
2. Deploy. The site works now, without the tutor.
3. To turn the tutor on, follow [Turn on the tutor](#turn-on-the-tutor).

## Turn on the tutor

The tutor is one small server function. It reads the key from the `ANTHROPIC_API_KEY`
environment variable **on the server**. The key is never sent to the browser: a test
builds the site and checks that no file of the built site contains the key or mentions
the API. When the variable is not set, the function answers `{"enabled":false}` and the
site shows no tutor at all.

**First, limit the spending.** A public website can be called by anyone. In the
[Claude Console](https://platform.claude.com), make a workspace for the tutor and create
an API key in it. Then set a monthly spend limit for that workspace (or for the whole
organization under Settings → Spend limits). The default workspace cannot have its own
spend limit. When a limit is reached, the tutor tells the student: "The tutor cannot
answer more questions right now. Please tell your teacher."

**Vercel**

1. Settings → Environment Variables: add `ANTHROPIC_API_KEY` (and `TUTOR_MODEL` if you
   want another model).
2. In the project's Firewall, add a new rule: if the request path equals `/api/tutor`,
   then rate limit it (fixed window, 60 seconds, 60 requests, counted per IP address,
   answer 429). Save the rule, then choose Review Changes and Publish: the rule works
   only after you publish it. The limits inside the function count separately in each
   running copy of it, so this rule and the spend limit are the real limits.
3. Redeploy. Open `/api/tutor` on your site: it should show `{"enabled":true}`.

**Netlify**

1. Project configuration → Environment variables: add `ANTHROPIC_API_KEY`. The variable
   must reach functions. On the free plan every variable does. On Pro and above, make
   sure its scopes include **Functions**. A variable written in `netlify.toml` does not
   reach functions.
2. Redeploy, then open `/api/tutor`: it should show `{"enabled":true}`. The function
   already declares Netlify's own rate limit (60 requests a minute per address).

**On your computer**

```sh
ANTHROPIC_API_KEY=sk-ant-... npm run dev
```

### What the tutor does

- It sees the code on the screen and the machine state. On a practice page it also sees
  the problem and the student's answers so far. It answers questions about them.
- It gives hints and asks questions before it gives answers, in short, plain replies.
- It refuses to write whole programs, to turn an assignment (C, Python or pseudocode)
  into assembly, and to give answers to worksheets or quizzes. It helps the student find
  their own bug instead.
- Each question goes to Anthropic's API with the code, the machine state and, on a
  practice page, the problem and the student's answers. Nothing is sent while the tutor
  is off.
- Each question sends at most the 12 newest messages of the chat.
- Limits. Each running copy of the function counts on its own, so these limits are not
  exact:
  - each page load: 8 questions a minute and 60 an hour;
  - each internet address: 60 a minute and 300 an hour (an IPv6 address counts by its /64
    network);
  - all students together: 600 an hour for each running copy.

### The API call, for reviewers

The function uses the official SDK (`@anthropic-ai/sdk`):
`client.beta.messages.stream(params, { signal })` with

- `model`: `TUTOR_MODEL`, or `claude-opus-5-5` when it is not set
- `max_tokens`: 2000
- `system`: one text block with `cache_control: { type: 'ephemeral' }` (the same text on
  every request, so it is cached)
- `messages`: the earlier turns, then the page data and the question
- `output_config: { effort: 'low' }`
- `betas: ['server-side-fallback-2026-07-01']` with `fallbacks: 'default'`
- no `thinking` parameter (this model always thinks adaptively; the low effort keeps
  that short, and thinking counts toward `max_tokens`), and no sampling or tool
  parameters

The client has a 45-second timeout per try and a 50-second deadline for the whole reply.
It retries once after a server error, an overload or a broken connection, but never after
a 429. A reply that does not end normally ends with the character U+0007 and one word:

- `refused`: the drawer shows a fixed sentence in place of the reply;
- `cut` (the reply reached `max_tokens`): the drawer keeps the text, says it was cut
  off, and offers "Try again";
- `empty` and `interrupted`: the drawer shows a plain sentence and a "Try again" button.

## The assembly it understands

Programs look like `gcc -S -masm=intel` output: labels, `#` comments, and
`.intel_syntax noprefix`. The whole file that gcc writes for a beginner program (with its
`.cfi_*` lines, `.LC0` labels and `OFFSET FLAT:`) assembles and runs, if it uses only the
instructions listed below. Compile with `gcc -S -masm=intel -fno-stack-protector`: on many
Linux systems (Ubuntu, for example) gcc adds stack-protector lines (`fs:40`,
`__stack_chk_fail`) to a function with an array, and the emulator cannot run them. gcc
also writes some instructions that the emulator does not have, for example `cdqe` for an
array index, and `cdq` and `idiv` for a division. The emulator names each such line and
says what to write instead, where it can.

**Instructions:** `mov`, `movzx`, `movsx` (and `movsxd`), `lea`, `push`, `pop`, `add`,
`sub`, `inc`, `dec`, `imul` (two operands), `cmp`, `test`, `and`, `or`, `xor`, `jmp`,
`je`/`jz`, `jne`/`jnz`, `jg`, `jge`, `jl`, `jle`, `ja`, `jae`, `jb`, `jbe`, `js`, `jns`,
`jo`, `jno` (and the other usual spellings, such as `jnle` and `jc`), `call`, `ret`,
`leave`, `nop`, and `endbr64` (which runs as `nop`).

**Memory operands:** `[rax]`, `[rbp-8]`, `-8[rbp]`, `8[rsp]`, `name[rbp]` (with an
`.equ` constant), `message[rip]`, `[rbx+rcx*8]`, and the sizes `byte ptr`, `word ptr`,
`dword ptr` and `qword ptr`. Numbers can be decimal, `0x` hex, `0b` binary, negative, or
a character such as `'A'`.

**Library functions:** `printf` (`%d %i %u %x %X %c %s %p %%`, the sizes `l`, `ll`, `h`
and `hh`, widths such as `%5d`, `%05d` and `%-5d`, and precision), `scanf` (`%d %i %u %x
%c %s` with the same sizes), `puts`, `putchar` and `exit`, called as `printf` or
`printf@PLT`. In the stepper a library call takes two steps. First the `call` pushes the
return address. Then the whole function runs as one step and returns.

**Directives:** `.intel_syntax noprefix`, `.text`, `.data`, `.bss`, `.section .rodata`,
`.globl`, `.type`, `.string`, `.asciz`, `.ascii`, `.quad`, `.long`, `.int`, `.word`,
`.short`, `.byte`, `.zero` (`.space`, `.skip`), `.equ` and `.set`. Directives that only
matter to the linker or the debugger (`.file`, `.ident`, `.size`, `.loc`, `.weak`,
`.local`, `.cfi_*`) are skipped, and so are `.align`, `.p2align` and `.balign` (which on
a real machine can move later data). `.comm` is not supported: a warning says to put the
variable after `.data` with `.zero` instead. Any other directive is skipped with a
warning.

**Registers:** all 16 general registers and every part of them (`rax eax ax ah al` …
`r15 r15d r15w r15b`), with the real write rules: a 32-bit write sets the top half to 0,
and an 8- or 16-bit write keeps the other bits. Flags: CF, ZF, SF and OF.

**Rules that are explained when broken:** no memory-to-memory `mov`; a number cannot be
the destination; both sides must be the same size; memory plus a number needs a `ptr`
size; `push` and `pop` take 64-bit registers (or a number, for `push`); the number must
fit; `ah`–`dh` cannot be mixed with `sil`, `dil`, `spl`, `bpl` or `r8`–`r15`; addresses
are built from 64-bit registers. Each message names the line, for example "Line 7: you
can't move memory into memory. Load it into a register first." A whole line in AT&T
syntax (`movq %rbx, %rax`) gets the same line written the Intel way (`mov rax, rbx`). A
single AT&T sign (`%rax`, `$5`, `movq`), NASM habits (`resb`, `equ`), `;` comments and
characters pasted from slides get their own messages too.

## Known limits

- It is a teaching subset, not a whole CPU. It runs only the instructions listed above:
  there is no division (`div`, `idiv`, `cdq`), no shifts (`shl`, `shr`, `sar`), no `neg`,
  `not` or `cdqe`, and no 3-operand `imul`. There is no floating point, no SIMD, no system
  calls, no segment registers, and only the four flags above.
- After `imul`, a real CPU leaves SF and ZF undefined. The emulator sets them from the
  result, and warns when a jump reads them.
- After a library call, the registers that a function may change (`rcx`, `rdx`, `rsi`,
  `rdi`, `r8`–`r11`) hold junk, as they may on a real machine. Practice problems turn
  this off (the emulator option `clobberCallerSaved`).
- The library functions are small versions of the real ones, written for this project,
  and cover what a beginner course uses. They behave like glibc's where a beginner can
  see it: `%p` of 0 prints `(nil)`, and input that `scanf` did not read stays for the
  next `scanf`. One call prints at most 65,536 characters, and a program 1,048,576 in
  all. A width such as `%5d` can be at most 1,000. `printf`, `puts` and `scanf` read a
  string from memory up to 4,096 bytes; a longer string is cut. There is no `%f`.
- Instruction sizes match a real assembler (checked against `clang`), so `rip` and the
  return addresses look real. The addresses look like those of a small non-PIE Linux
  build, but the program runs alone: there is no operating system, no other code, and
  `main` returns to a stop address.
- Memory is only the program's own areas and the stack. A null pointer, or any address
  outside them, stops the program with a plain message. Reading the bytes of the code
  gives 0 and a warning.
- Run stops with a friendly message when a program may be stuck in a loop: after 1,000
  steps at the speeds 1 to 9, and after 10,000 steps at speed 10 (instant). Press Run
  again to go on. An endless loop does not freeze the page. Back can undo at least the
  last 20,000 steps.

## How we know the emulator is right

- **Results from real x86-64 code:** 4,660 single instructions and 600 random programs
  were run as x86-64 machine code (through Rosetta 2 on an Apple Silicon Mac). Their
  results are stored in `src/emulator/__fixtures__/`, and every `npm test` compares the
  emulator with them.
- **Real instruction sizes:** 427 instruction forms and 25 small programs (23 with jumps
  and calls, 2 with addresses) were assembled with `clang`, so addresses and `rip` look
  like the ones `gdb` shows.
- **`npm run verify:native`** builds every example as a real program and compares the two
  instruction by instruction: with `gdb` on x86-64 Linux, or with `lldb` or a small
  single-step tracer on a Mac (on Apple silicon through Rosetta 2). If it cannot step, it
  compares what each program prints. Without a compiler it skips with one line. So far it
  has run only on a Mac (mostly with the tracer; all 308 steps of the ten examples
  matched). The `gdb` mode is tested only with recorded `gdb` output.
- Practice answers come from the emulator (by running the problem, or from its register
  table), never from a separate answer table. A reviewer also tried to break them with
  code of their own.

## Where things are

`PLAN.md` describes the design (the emulator, the pages, the decisions) and
`CHANGELOG.md` what each milestone added. The emulator is in `src/emulator/`, the pages
in `src/features/`, and the tutor function in `server/`, `api/` and `netlify/`.

All lesson text, examples and problems were written for this project.
