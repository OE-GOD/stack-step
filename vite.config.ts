/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { tutorDevPlugin } from './server/devPlugin.ts'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths: the built site works from any folder
  // (GitHub Pages project sites, Vercel, Netlify) with no extra config.
  base: './',
  // Each dev server can keep its own dependency cache, so several servers started from
  // this folder at once (end-to-end runs on different ports) do not disturb each other:
  //   STACKSTEP_VITE_CACHE=node_modules/.vite-5191 npx vite --port 5191 --strictPort
  cacheDir: process.env.STACKSTEP_VITE_CACHE ?? 'node_modules/.vite',
  // tutorDevPlugin serves the optional tutor function at /api/tutor during `npm run dev`.
  plugins: [react(), tailwindcss(), tutorDevPlugin()],
  server: {
    // No CORS headers at all: the dev server serves the tutor function, which spends money,
    // and a page of another site (or of another port of localhost) must not be able to read
    // its answers. (Vite's default answers CORS checks from any localhost page.)
    cors: false,
  },
  build: {
    target: 'es2022',
  },
  test: {
    // Emulator and practice logic are pure TypeScript, so tests run in Node.
    // A test that needs a browser-like DOM opts in with a first-line comment:
    //   // @vitest-environment jsdom
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})
