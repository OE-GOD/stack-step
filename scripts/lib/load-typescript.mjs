/**
 * Lets a plain Node script load this project's TypeScript files directly.
 *
 * Node (22.18 or newer) removes the type annotations by itself, but it does not accept
 * the import style the project uses: `import { reg } from './registers'` (no file
 * extension). `installTypeScriptResolver()` adds one small rule to Node's module
 * resolution: when a relative import from a `.ts` file is not found (or names a folder),
 * try the same path with `.ts`, then with `/index.ts`.
 *
 * No packages are needed: this uses only `node:module`.
 */
import nodeModule from 'node:module'
import process from 'node:process'

let installed = false

/** True when this Node can run `.ts` files and supports resolver hooks. */
export function nodeCanLoadTypeScript() {
  return Boolean(process.features.typescript) && typeof nodeModule.registerHooks === 'function'
}

/** One sentence for the user when `nodeCanLoadTypeScript()` is false. */
export function nodeTooOldMessage() {
  return (
    `This script loads the project's TypeScript files directly, which needs Node 22.18 or newer. ` +
    `This is Node ${process.versions.node}.`
  )
}

export function installTypeScriptResolver() {
  if (installed) return
  installed = true
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        const relative = specifier.startsWith('./') || specifier.startsWith('../')
        const fromTypeScript =
          typeof context.parentURL === 'string' && /\.[cm]?ts$/.test(context.parentURL)
        // A folder (`'../emulator'`) is "unsupported directory import", not "not found".
        const notFound =
          error !== null &&
          typeof error === 'object' &&
          (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ERR_UNSUPPORTED_DIR_IMPORT')
        if (relative && fromTypeScript && notFound) {
          for (const ending of ['.ts', '/index.ts']) {
            try {
              return nextResolve(specifier + ending, context)
            } catch {
              // Try the next spelling.
            }
          }
        }
        throw error
      }
    },
  })
}

/**
 * Import a TypeScript module of this project.
 * Returns `{ ok: true, module }`, or `{ ok: false, nodeTooOld, message }` with a sentence
 * that says why it could not be loaded. `nodeTooOld` tells "this Node cannot do it" (a
 * reason to skip) apart from "the file is broken" (a reason to fail). Never throws.
 */
export async function loadTypeScript(url) {
  if (!nodeCanLoadTypeScript()) {
    return { ok: false, nodeTooOld: true, message: nodeTooOldMessage() }
  }
  installTypeScriptResolver()
  try {
    return { ok: true, module: await import(String(url)) }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return { ok: false, nodeTooOld: false, message: `Could not load ${String(url)}: ${text}` }
  }
}
