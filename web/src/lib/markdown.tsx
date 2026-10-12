import { Fragment, type ReactNode } from 'react'
import { parseBlocks, type ListItem } from './markdown-parse.ts'

/**
 * SECURITY: a small Markdown renderer that builds React elements directly. It never creates HTML strings and never uses
 * dangerouslySetInnerHTML, so model output cannot inject markup or scripts. Links are rendered only for http(s) and
 * mailto URLs and always open outside the app (the desktop shell sends them to the system browser).
 *
 * Supported: headings (#…######, and a line that is entirely **bold** — e.g. "**Room conclusion (news)**" — becomes a
 * heading), paragraphs with line breaks, **bold**, *italic*, ~~strike~~, `code`, fenced code blocks, > quotes,
 * - / * / 1. lists (nested by indentation), tables, --- rules, [links](https://…) and bare URLs.
 */

// ---------- inline ----------

const SAFE_LINK = /^(https?:\/\/|mailto:)/i

function link(href: string, children: ReactNode, key: string): ReactNode {
  if (!SAFE_LINK.test(href)) return <Fragment key={key}>{children}</Fragment>
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

/** Inline markup. Order matters: code spans first (their content is literal), then links, then emphasis. */
export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let n = 0
  const key = () => `${keyPrefix}-${n++}`
  const patterns: { re: RegExp; render: (m: RegExpExecArray) => ReactNode }[] = [
    { re: /`([^`\n]+)`/, render: (m) => <code key={key()}>{m[1]}</code> },
    { re: /\[([^\]\n]+)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/, render: (m) => link(m[2] ?? '', renderInline(m[1] ?? '', `${keyPrefix}-l${n}`), key()) },
    { re: /<(https?:\/\/[^\s>]+)>/, render: (m) => link(m[1] ?? '', m[1], key()) },
    { re: /\*\*\*(?=\S)([^*\n]+?)\*\*\*/, render: (m) => <strong key={key()}><em>{renderInline(m[1] ?? '', `${keyPrefix}-be${n}`)}</em></strong> },
    { re: /\*\*(?=\S)([\s\S]+?)\*\*/, render: (m) => <strong key={key()}>{renderInline(m[1] ?? '', `${keyPrefix}-b${n}`)}</strong> },
    { re: /(?<![\w\\])__(?=\S)([\s\S]+?)__(?!\w)/, render: (m) => <strong key={key()}>{renderInline(m[1] ?? '', `${keyPrefix}-u${n}`)}</strong> },
    { re: /~~(?=\S)([\s\S]+?)~~/, render: (m) => <del key={key()}>{renderInline(m[1] ?? '', `${keyPrefix}-s${n}`)}</del> },
    { re: /(?<![*\w\\])\*(?=[^\s*])([^*\n]+?)\*(?![*\w])/, render: (m) => <em key={key()}>{renderInline(m[1] ?? '', `${keyPrefix}-e${n}`)}</em> },
    { re: /(?<![\w\\])_(?=[^\s_])([^_\n]+?)_(?!\w)/, render: (m) => <em key={key()}>{renderInline(m[1] ?? '', `${keyPrefix}-f${n}`)}</em> },
    { re: /\bhttps?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/, render: (m) => link(m[0], m[0], key()) },
  ]
  while (rest) {
    let best: { index: number; m: RegExpExecArray; render: (m: RegExpExecArray) => ReactNode } | undefined
    for (const p of patterns) {
      const m = p.re.exec(rest)
      if (m && (best === undefined || m.index < best.index)) best = { index: m.index, m, render: p.render }
    }
    if (!best) {
      out.push(rest.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1'))
      break
    }
    if (best.index > 0) out.push(rest.slice(0, best.index).replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1'))
    out.push(best.render(best.m))
    rest = rest.slice(best.index + best.m[0].length)
  }
  return out
}

function lines(texts: string[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  texts.forEach((t, i) => {
    if (i > 0) out.push(<br key={`${keyPrefix}-br${i}`} />)
    out.push(...renderInline(t, `${keyPrefix}-${i}`))
  })
  return out
}

function renderList(items: ListItem[], ordered: boolean, start: number, key: string): ReactNode {
  const children = items.map((item, i) => (
    <li key={`${key}-${i}`}>
      {lines(item.text.split('\n'), `${key}-${i}`)}
      {item.children.length ? renderList(item.children, item.children[0]?.ordered ?? false, 1, `${key}-${i}-c`) : null}
    </li>
  ))
  return ordered ? (
    <ol key={key} start={start === 1 ? undefined : start}>
      {children}
    </ol>
  ) : (
    <ul key={key}>{children}</ul>
  )
}

export function Markdown(props: { text: string }) {
  const blocks = parseBlocks(props.text)
  return (
    <div className="md">
      {blocks.map((block, i) => {
        const key = `b${i}`
        switch (block.type) {
          case 'heading': {
            const content = renderInline(block.text, key)
            if (block.level <= 1) return <h2 key={key}>{content}</h2>
            if (block.level === 2) return <h3 key={key}>{content}</h3>
            return <h4 key={key}>{content}</h4>
          }
          case 'paragraph':
            return <p key={key}>{lines(block.lines, key)}</p>
          case 'code':
            return (
              <pre key={key} className="md-code" data-lang={block.lang || undefined}>
                <code>{block.text}</code>
              </pre>
            )
          case 'quote':
            return <blockquote key={key}>{lines(block.lines, key)}</blockquote>
          case 'list':
            return renderList(block.items, block.ordered, block.start, key)
          case 'table':
            return (
              <div key={key} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {block.header.map((cell, c) => (
                        <th key={c} style={block.align[c] ? { textAlign: block.align[c] } : undefined}>
                          {renderInline(cell, `${key}-h${c}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c} style={block.align[c] ? { textAlign: block.align[c] } : undefined}>
                            {renderInline(cell, `${key}-${r}-${c}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'rule':
            return <hr key={key} />
        }
      })}
    </div>
  )
}
