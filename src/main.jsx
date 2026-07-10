import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Register the service worker so the hub installs to the homescreen and opens quickly.
// Guarded to production so the dev server isn't affected. No push/notifications.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/nwu-hub/sw.js').catch(() => {})
  })
}
