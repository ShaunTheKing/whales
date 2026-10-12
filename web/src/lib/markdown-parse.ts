/** Block-level Markdown parser (no JSX, so Node can unit-test it). Rendering lives in markdown.tsx. */

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; lines: string[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; lines: string[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'table'; header: string[]; align: ('left' | 'center' | 'right' | undefined)[]; rows: string[][] }
  | { type: 'rule' }

export interface ListItem {
  text: string
  children: ListItem[]
  ordered: boolean
}

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const BOLD_LINE = /^\s{0,3}(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[start] ?? '')!
  const ordered = /\d/.test(first[2] ?? '')
  const baseIndent = (first[1] ?? '').length
  const items: ListItem[] = []
  const stack: { indent: number; items: ListItem[] }[] = [{ indent: baseIndent, items }]
  let i = start
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = LIST_ITEM.exec(line)
    if (!m) {
      if (line.trim() === '') {
        // A blank line ends the list unless the next line continues it.
        const after = lines[i + 1] ?? ''
        if (LIST_ITEM.test(after) && (LIST_ITEM.exec(after)?.[1] ?? '').length >= baseIndent) continue
        break
      }
      // Continuation text of the previous item (indented or lazy).
      const top = stack[stack.length - 1]!.items
      const last = top[top.length - 1]
      if (last && /^\s+/.test(line)) {
        last.text += `\n${line.trim()}`
        continue
      }
      break
    }
    const indent = (m[1] ?? '').length
    if (indent < baseIndent) break
    // At the top level, switching between bullets and numbers starts a new list.
    if (indent <= baseIndent + 1 && /\d/.test(m[2] ?? '') !== ordered) break
    const item: ListItem = { text: m[3] ?? '', children: [], ordered: /\d/.test(m[2] ?? '') }
    while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) stack.pop()
    const level = stack[stack.length - 1]!
    if (indent > level.indent + 1) {
      const parentList = level.items
      const parent = parentList[parentList.length - 1]
      if (parent) {
        parent.children.push(item)
        stack.push({ indent, items: parent.children })
        continue
      }
    }
    level.items.push(item)
  }
  const startNumber = ordered ? Number.parseInt(first[2] ?? '1', 10) || 1 : 1
  return { block: { type: 'list', ordered, start: startNumber, items }, next: i }
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]!
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker)) body.push(lines[i++] ?? '')
      i++ // closing fence (or end of text while streaming)
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2] ?? '' })
      i++
      continue
    }
    const bold = BOLD_LINE.exec(line)
    if (bold && !(bold[1] ?? '').includes('**')) {
      blocks.push({ type: 'heading', level: 4, text: bold[1] ?? '' })
      i++
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) quoted.push(QUOTE.exec(lines[i++] ?? '')?.[1] ?? '')
      blocks.push({ type: 'quote', lines: quoted })
      continue
    }
    if (LIST_ITEM.test(line)) {
      const { block, next } = parseList(lines, i)
      blocks.push(block)
      i = next
      continue
    }
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const header = splitRow(line)
      const align = splitRow(lines[i + 1] ?? '').map((cell) =>
        cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : undefined,
      )
      const rows: string[][] = []
      i += 2
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') rows.push(splitRow(lines[i++] ?? ''))
      blocks.push({ type: 'table', header, align, rows })
      continue
    }
    const paragraph: string[] = []
    while (i < lines.length) {
      const l = lines[i] ?? ''
      if (l.trim() === '' || FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || LIST_ITEM.test(l)) break
      if (paragraph.length && BOLD_LINE.test(l)) break
      paragraph.push(l)
      i++
    }
    if (paragraph.length === 0) {
      // A line no rule above consumed (defensive): treat it as text so parsing always advances.
      paragraph.push(line)
      i++
    }
    blocks.push({ type: 'paragraph', lines: paragraph })
  }
  return blocks
}
