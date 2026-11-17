/**
 * Entry point of the editor harness (demo.html). A developer tool: it is not part of
 * the site and not part of the production build.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../index.css'
import { EditorDemoPage } from './EditorDemoPage'

const root = document.getElementById('root')
if (root === null) throw new Error('demo.html has no element with id="root".')

// StrictMode like the real site: it mounts every component twice during development,
// which is exactly what the editor has to survive.
createRoot(root).render(
  <StrictMode>
    <EditorDemoPage />
  </StrictMode>,
)
