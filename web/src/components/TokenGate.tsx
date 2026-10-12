import { useState } from 'react'
import { setToken } from '../api.ts'

export function TokenGate(props: { onToken(): void }) {
  const { onToken } = props
  const [value, setValue] = useState('')

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    setToken(trimmed)
    onToken()
  }

  return (
    <div className="app">
      <main className="main">
        <div className="panel">
          <div className="panel-head">
            <span>Whales</span>
          </div>
          <div className="panel-body">
            <form className="form" onSubmit={submit}>
              <label className="field">
                <span>Access token</span>
                <input
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete="off"
                  autoFocus
                />
              </label>
              <div className="row">
                <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
                  Connect
                </button>
              </div>
            </form>
          </div>
        </div>
      </main>
    </div>
  )
}
