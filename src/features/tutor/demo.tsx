/**
 * Entry point of the tutor harness (demo.html). A developer tool: it is not part of the
 * site and not part of the production build.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../index.css'
import { TutorDemoPage } from './TutorDemoPage'

const root = document.getElementById('root')
if (root === null) throw new Error('demo.html has no element with id="root".')

// StrictMode like the real site: it mounts every component twice during development,
// and the tutor must still ask the function only once.
createRoot(root).render(
  <StrictMode>
    <TutorDemoPage />
  </StrictMode>,
)
