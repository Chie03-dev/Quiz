import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './tokens.css'
import './ui.css'
import './shell.css'
import './screens.css'
import './theme-paper.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)