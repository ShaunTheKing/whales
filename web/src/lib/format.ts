/** "12:11 AM" today, "Yesterday", weekday within a week, else "Mar 4". */
export function shortTime(at: number, now: number = Date.now()): string {
  const date = new Date(at)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (at >= startOfToday) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (at >= startOfToday - 86_400_000) return 'Yesterday'
  if (at >= startOfToday - 6 * 86_400_000) return date.toLocaleDateString(undefined, { weekday: 'long' })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Divider label between messages more than 15 minutes apart: "Today 12:11 AM", "Yesterday 9:02 PM", "Mar 4, 3:10 PM". */
export function dividerTime(at: number, now: number = Date.now()): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (at >= startOfToday) return time
  if (at >= startOfToday - 86_400_000) return `Yesterday ${time}`
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

/** True when a time divider belongs between two messages. */
export function needsDivider(previous: number | undefined, next: number): boolean {
  return previous === undefined || next - previous > 15 * 60_000
}

/** Markdown → one plain line for previews: drops emphasis markers, heading hashes, list bullets and link targets. */
export function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](\S)/g, '$1$2')
    .replace(/(\S)[*_](?=\s|$)/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
