import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './globals.css'
import { initApiBaseUrl, isElectron, getPlatform } from './lib/env'
import { initRendererErrorReporting } from './lib/error-reporting'
import { applyWebFavicon } from './lib/favicon'

// Initialize Sentry error reporting as early as possible
initRendererErrorReporting()

// Precaching service worker, web production only. __WEB__ is false in every
// Electron build (dead-code-stripped; file:// can't host a SW anyway) and dev
// is excluded so the Vite dev server is never shadowed by a stale cache. The
// SW (built by vite-plugin-pwa in vite.config.ts) precaches the full hashed
// asset set in the background: lazy route chunks stay warm for offline/flaky
// networks, and deploys swap in as one atomic set. Registered after `load` so
// it never competes with boot-critical fetches.
if (__WEB__ && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('Service worker registration failed:', error)
    })
  })
}

// Add vibrancy class for macOS/Windows Electron so CSS can conditionally apply transparent backgrounds
if (isElectron() && (getPlatform() === 'darwin' || getPlatform() === 'win32')) {
  document.documentElement.classList.add('electron-vibrancy')
  if (getPlatform() === 'win32') {
    document.documentElement.classList.add('electron-vibrancy-win')
  }
}

async function init() {
  if (__WEB__) {
    applyWebFavicon()
  }

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
