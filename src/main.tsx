import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { watchHistory } from './components/layout/historyScroll'

const root = document.getElementById('root')
if (root === null) throw new Error('index.html has no element with id="root".')

// Before the first render, so that it hears about a new address before the app does.
watchHistory()

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
