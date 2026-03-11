import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'

function App() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-100">
      <h1 className="text-3xl font-bold text-slate-800">Hello from PersonWerner</h1>
    </main>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
