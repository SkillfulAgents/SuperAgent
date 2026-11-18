import React from 'react'
import ReactDOM from 'react-dom/client'
import './globals.css'
import { QuickDispatchApp } from './components/quick-dispatch/quick-dispatch-app'
import { initApiBaseUrl, isElectron, getPlatform } from './lib/env'
import { initRendererErrorReporting } from './lib/error-reporting'

// Standalone entry for the quick-dispatch launcher window — a separate
// BrowserWindow / renderer process, so it boots its own (slim) provider tree
// with NO router and none of the main app shell. Mirrors main.tsx's startup
// order: error reporting → vibrancy class → API base URL → render.

initRendererErrorReporting()

if (isElectron() && (getPlatform() === 'darwin' || getPlatform() === 'win32')) {
  document.documentElement.classList.add('electron-vibrancy')
  if (getPlatform() === 'win32') {
    document.documentElement.classList.add('electron-vibrancy-win')
  }
}

// Resolve the Electron API base URL before the first apiFetch, then render.
initApiBaseUrl()
  .catch((error) => {
    console.error('Failed to initialize quick-dispatch:', error)
  })
  .finally(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <QuickDispatchApp />
      </React.StrictMode>,
    )
  })
