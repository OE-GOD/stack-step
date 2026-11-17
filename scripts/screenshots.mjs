#!/usr/bin/env node
/**
 * Browser check: open pages in a real browser (Chromium via Playwright), save
 * screenshots at desktop and phone width, and report problems.
 *
 *   node scripts/screenshots.mjs --base http://localhost:5173 --out docs/screenshots/m1 \
 *        --routes "/,/stepper,/learn"
 *
 * Options
 *   --base     URL of a running site (dev server or preview).      default http://localhost:5173
 *   --out      folder for the PNG files.                           default docs/screenshots/latest
 *   --routes   comma-separated app routes (hash routes, without #). default "/"
 *   --dark     also capture dark mode.
 *   --full     capture the full page height (default: yes; pass --no-full for the viewport only).
 *
 * For every page and size it also checks:
 *   - no horizontal scrolling (page is not wider than the screen)
 *   - no errors in the browser console
 *
 * Exit code 1 when a check fails, so it can be used as a gate.
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { chromium } from '@playwright/test'

function parseArgs(argv) {
  const args = { base: 'http://localhost:5173', out: 'docs/screenshots/latest', routes: '/' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dark') args.dark = true
    else if (a === '--no-full') args.noFull = true
    else if (a === '--full') args.noFull = false
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i]
  }
  return args
}

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800, isMobile: false, hasTouch: false },
  { name: 'phone', width: 360, height: 740, isMobile: true, hasTouch: true },
]

function fileNameFor(route) {
  const clean = route
    .replace(/^\/+/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return clean === '' ? 'home' : clean
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const routes = String(args.routes)
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
  const themes = args.dark ? ['light', 'dark'] : ['light']
  await mkdir(args.out, { recursive: true })

  const browser = await chromium.launch()
  const problems = []
  const shots = []

  for (const viewport of VIEWPORTS) {
    for (const theme of themes) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.isMobile ? 2 : 1,
        isMobile: viewport.isMobile,
        hasTouch: viewport.hasTouch,
        colorScheme: theme,
      })
      const page = await context.newPage()
      const consoleErrors = []
      page.on('console', (msg) => {
        // On a host without the optional tutor function, the tutor's availability check
        // gets a 404 and the browser logs it. That is expected: the site hides the tutor.
        if (msg.type() !== 'error' || msg.location().url.endsWith('/api/tutor')) return
        consoleErrors.push(msg.text())
      })
      page.on('pageerror', (err) => consoleErrors.push(String(err)))

      for (const route of routes) {
        consoleErrors.length = 0
        const url = `${args.base.replace(/\/$/, '')}/#${route}`
        await page.goto(url, { waitUntil: 'networkidle' })
        // Hash navigation does not reload; make sure the app has rendered the route.
        await page.waitForTimeout(350)

        const overflow = await page.evaluate(() => {
          const doc = document.documentElement
          return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth }
        })
        if (overflow.scrollWidth > overflow.clientWidth + 1) {
          problems.push(
            `${route} @ ${viewport.name}/${theme}: page is ${overflow.scrollWidth}px wide on a ${overflow.clientWidth}px screen (horizontal scroll)`,
          )
        }
        for (const text of consoleErrors) {
          problems.push(`${route} @ ${viewport.name}/${theme}: console error: ${text}`)
        }

        const suffix = themes.length > 1 ? `-${theme}` : ''
        const file = path.join(args.out, `${fileNameFor(route)}-${viewport.name}${suffix}.png`)
        await page.screenshot({ path: file, fullPage: !args.noFull })
        shots.push(file)
      }
      await context.close()
    }
  }

  await browser.close()

  console.log(`Saved ${shots.length} screenshots:`)
  for (const file of shots) console.log(`  ${file}`)
  if (problems.length > 0) {
    console.log(`\n${problems.length} problem(s):`)
    for (const p of problems) console.log(`  - ${p}`)
    process.exit(1)
  }
  console.log('\nNo horizontal scrolling and no console errors.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
