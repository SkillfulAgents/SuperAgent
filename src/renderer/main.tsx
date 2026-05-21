import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './globals.css'
import { initApiBaseUrl, isElectron, getPlatform } from './lib/env'
import { initRendererErrorReporting } from './lib/error-reporting'

// Initialize Sentry error reporting as early as possible
initRendererErrorReporting()

// Add vibrancy class for macOS/Windows Electron so CSS can conditionally apply transparent backgrounds
if (isElectron() && (getPlatform() === 'darwin' || getPlatform() === 'win32')) {
  document.documentElement.classList.add('electron-vibrancy')
  if (getPlatform() === 'win32') {
    document.documentElement.classList.add('electron-vibrancy-win')
  }
}

async function init() {
  // Load render tracking instrumentation before any components (must patch React first)
  if (__RENDER_TRACKING__) {
    await import('./lib/render-tracking')
  }

  // Initialize API URL before rendering
  initApiBaseUrl()
    .catch((error) => {
      console.error('Failed to initialize:', error)
    })
    .finally(() => {
      ReactDOM.createRoot(document.getElementById('root')!).render(
        <React.StrictMode>
          <App />
        </React.StrictMode>
      )
    })
}

init()
