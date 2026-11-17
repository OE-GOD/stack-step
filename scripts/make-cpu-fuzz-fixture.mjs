#!/usr/bin/env node
/**
 * Ground truth from a real x86-64 CPU for the emulator tests.
 *
 *   node scripts/make-cpu-fuzz-fixture.mjs [--seed N] [--count N]
 *
 * 1. Generates random straight-line programs in the emulator's syntax (always the same
 *    programs for the same seed).
 * 2. Runs them as real x86-64 code (clang; through Rosetta 2 on an Apple Silicon Mac)
 *    and records every register, the flags and the scratch memory at the end.
 * 3. Writes src/emulator/__fixtures__/cpu-fuzz.json, which
 *    src/emulator/cpu-fuzz.test.ts replays in the emulator on every `npm test`.
 *
 * If this machine cannot build or run x86-64 code, the script says so and leaves an
 * existing fixture alone. Run with --help for all options.
 *
 * No packages are needed. The code lives in scripts/lib/cpu-fuzz/ (TypeScript, loaded
 * directly by Node):
 *   generate.ts  the program generator and its safety rules
 *   model.ts     a small reference model, used only to cross-check the harness
 *   native.ts    the assembly wrapper and the C driver that capture the CPU state
 *   main.ts      the steps above
 */
import process from 'node:process'
import { loadTypeScript } from './lib/load-typescript.mjs'

const loaded = await loadTypeScript(new URL('./lib/cpu-fuzz/main.ts', import.meta.url))
if (!loaded.ok) {
  // A Node that cannot run TypeScript is a reason to stop quietly. A file that does not
  // load is a bug.
  console.log(loaded.message)
  console.log('Nothing was written. An existing fixture is unchanged.')
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
