#!/usr/bin/env node
/**
 * Run a TypeScript file that imports this project's sources, with plain Node:
 *
 *   node scripts/run-ts.mjs path/to/script.ts [arguments for the script]
 *
 * Node (22.18 or newer) can run TypeScript by itself, but it does not accept the import
 * style the project uses (`from './registers'`, no file extension). This starter adds
 * that one rule and then loads your file. Handy for a quick experiment:
 *
 *   // try.ts
 *   import { createEmulator } from '/absolute/path/to/stack-step/src/emulator/index.ts'
 *   const made = createEmulator('mov eax, 7\nret\n')
 *   if (made.ok) console.log(made.emulator.run(), made.emulator.readRegister('rax'))
 *
 * Only plain `.ts` files work (no JSX, nothing that needs Vite).
 */
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { loadTypeScript } from './lib/load-typescript.mjs'

const [file, ...rest] = process.argv.slice(2)
if (file === undefined || file === '--help' || file === '-h') {
  console.log('Usage: node scripts/run-ts.mjs path/to/script.ts [arguments for the script]')
  process.exit(file === undefined ? 1 : 0)
}

// The script sees its own arguments where it would expect them.
process.argv = [process.argv[0], path.resolve(file), ...rest]

const loaded = await loadTypeScript(pathToFileURL(path.resolve(file)))
if (!loaded.ok) {
  console.error(loaded.message)
  process.exit(1)
}
