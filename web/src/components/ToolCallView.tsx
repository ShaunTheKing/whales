import type { JSX } from 'react'

const MAX_CHARS = 20000

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text
  return `${text.slice(0, MAX_CHARS)}\n… (${text.length - MAX_CHARS} more characters)`
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return truncate(value)
  try {
    const json = JSON.stringify(value, null, 2)
    return truncate(json === undefined ? String(value) : json)
  } catch {
    return truncate(String(value))
  }
}

export function ToolCallView(props: { name: string; input: unknown; result?: { output: string; isError: boolean } }) {
  const { name, input, result } = props
  const status = result ? (result.isError ? 'error' : 'done') : 'running'
  const className = result?.isError ? 'tool tool-error' : 'tool'
  return (
    <details className={className}>
      <summary>
        <span className={`tool-dot tool-dot-${status}`} aria-hidden="true" />
        <span className="mono">{name}</span>
        <span className="tool-status">{status === 'running' ? 'running…' : status === 'error' ? 'failed' : 'done'}</span>
      </summary>
      <div className="tool-io">
        <pre className="tool-io">{pretty(input)}</pre>
        {result ? <pre className="tool-io">{truncate(result.output)}</pre> : null}
      </div>
    </details>
  )
}
