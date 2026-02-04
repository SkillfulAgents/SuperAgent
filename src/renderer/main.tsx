import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './globals.css'
import { initApiBaseUrl, isElectron, getPlatform } from './lib/env'

// Add vibrancy class for macOS Electron so CSS can conditionally apply transparent backgrounds
if (isElectron() && getPlatform() === 'darwin') {
  document.documentElement.classList.add('electron-vibrancy')
}

// Initialize API URL before rendering (needed for Electron where port may vary)
initApiBaseUrl().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})
