/**
 * Entry point of the trace-table harness (demo.html). A developer tool: it is not part
 * of the site and not part of the production build.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../../index.css'
import { TraceDemoPage } from './TraceDemoPage'

const root = document.getElementById('root')
if (root === null) throw new Error('demo.html has no element with id="root".')

// StrictMode like the real site: it mounts every component twice during development,
// which the drag-and-drop set-up has to survive.
createRoot(root).render(
  <StrictMode>
    <TraceDemoPage />
  </StrictMode>,
)
