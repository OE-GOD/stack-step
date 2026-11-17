#!/usr/bin/env node
/**
 * npm run verify:native
 *
 * Builds every example program (src/examples/index.ts) as real x86-64 code and compares
 * it with the emulator. It picks the best mode this machine allows:
 *
 *   1. gdb     x86-64 Linux with gcc and gdb: single-step each program in gdb and compare
 *              the registers, rip and the flags with the emulator after every instruction.
 *   2. lldb    a Mac with clang and lldb (through Rosetta 2 on Apple Silicon): the same,
 *              driving lldb. Chosen by itself only when macOS developer mode is on (else
 *              lldb may wait for a password); `--mode lldb` asks for it.
 *      trace   a Mac without that permission: the same comparison with a built-in
 *              single-step tracer (the x86 trap flag), no debugger needed.
 *   3. output  build and run only: compare what each program prints and its exit code.
 *   4. nothing usable: one line says what is needed, exit code 0.
 *
 * Exit code 0 when everything matched or the check was skipped, 1 when something differs.
 * Run with `-- --help` for the options. Two worth knowing:
 *   --fuzz p0042   step through a program of the CPU fuzz fixture instead of the examples:
 *                  it shows the first instruction behind a failure of cpu-fuzz.test.ts
 *   --show-steps   print every step of the real machine
 *
 * No packages are needed. The code lives in scripts/lib/native/ (TypeScript, loaded
 * directly by Node):
 *   verify.ts        the modes and the flow
 *   compare.ts       the rules for comparing a real process with the emulator
 *   debuggers.ts     gdb and lldb command files and output parsers
 *   tracer.ts        the built-in single-step tracer
 *   macos-source.ts  rewriting a program for the macOS assembler
 *   emulator.ts      loading the emulator and collecting its steps
 */
import process from 'node:process'
import { loadTypeScript } from './lib/load-typescript.mjs'

const loaded = await loadTypeScript(new URL('./lib/native/verify.ts', import.meta.url))
if (!loaded.ok) {
  // A Node that cannot run TypeScript is a reason to skip. A file that does not load is a bug.
  console.log(`verify:native ${loaded.nodeTooOld ? 'skipped' : 'cannot start'}: ${loaded.message}`)
  process.exit(loaded.nodeTooOld ? 0 : 1)
}
try {
  process.exitCode = await loaded.module.main(process.argv.slice(2))
} catch (error) {
  // A bug in the script itself, not a result: say so and fail.
  console.error('The script stopped because of an internal error:')
  console.error(error)
  process.exitCode = 1
}
