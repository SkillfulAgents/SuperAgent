import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './globals.css'
import { initApiBaseUrl } from './lib/env'

// Initialize API URL before rendering (needed for Electron where port may vary)
initApiBaseUrl().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})
