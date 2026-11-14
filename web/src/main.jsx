import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import LegacyApp from './views/LegacyApp.jsx'
import SqlDrawer, { SqlProvider } from './views/SqlDrawer.jsx'
import './styles.css'
import './demo.css'

// /contested/#legacy: the pre-demo app with every view (hidden from the navigation, kept).
const legacy = window.location.hash.startsWith('#legacy')
// moving into or out of #legacy swaps the whole app
window.addEventListener('hashchange', () => { if (window.location.hash.startsWith('#legacy') !== legacy) window.location.reload() })

createRoot(document.getElementById('root')).render(
  <SqlProvider>
    {legacy ? <LegacyApp /> : <App />}
    <SqlDrawer />
  </SqlProvider>,
)
