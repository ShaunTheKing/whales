import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './styles.css'

const container = document.getElementById('root')
if (container) {
  // Opening a fresh `#token=` link in an already-open tab only changes the fragment; reload so it is picked up
// (and stripped from the address bar) by api.ts.
window.addEventListener('hashchange', () => {
  if (window.location.hash.includes('token=')) window.location.reload()
})

createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
