import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests.
 *
 *   npm run test:e2e                 build the site, serve it, test it (what CI should run)
 *   E2E_DEV=1 npm run test:e2e       test against the dev server instead (faster while coding)
 *   E2E_PORT=4321 npm run test:e2e   use another port (several runs side by side)
 *
 * The production run builds into its own folder (not `dist/`), named after the port, so
 * that several runs side by side never overwrite each other or a real `npm run build`.
 */
const PORT = Number(process.env.E2E_PORT ?? 4173)
const useDevServer = process.env.E2E_DEV === '1'
const BUILD_DIR = `node_modules/.e2e-dist-${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // Output folders are per port too, so runs side by side do not delete each other's files.
  outputDir: `test-results/port-${PORT}`,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `playwright-report/port-${PORT}` }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      // A small phone: the narrowest screen the site promises to support.
      name: 'phone',
      use: {
        browserName: 'chromium',
        viewport: { width: 360, height: 740 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: useDevServer
      ? `npm run dev -- --port ${PORT} --strictPort`
      : `npx vite build --outDir ${BUILD_DIR} --emptyOutDir && npx vite preview --outDir ${BUILD_DIR} --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // A dev server on its own port gets its own dependency cache (see vite.config.ts).
    env: useDevServer
      ? { STACKSTEP_VITE_CACHE: process.env.STACKSTEP_VITE_CACHE ?? `node_modules/.vite-${PORT}` }
      : {},
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
