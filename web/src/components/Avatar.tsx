/** Round avatar: a soft colour picked from the id, with initials (or '#' for rooms). Decorative: aria-hidden. */
const HUES = [162, 28, 232, 268, 200, 348, 45, 128, 300, 12]

/** FNV-1a: spreads short, similar ids (agent-1, agent-2) across the palette. */
function hueFor(id: string): number {
  let hash = 0x811c9dc5
  for (const ch of id) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return HUES[hash % HUES.length] ?? 162
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : (words[0] ?? '?').slice(0, 2)
  return letters.toUpperCase()
}

export function Avatar(props: { id: string; name: string; kind?: 'agent' | 'room' | 'user'; size?: number }) {
  const { id, name, kind = 'agent', size = 36 } = props
  const hue = hueFor(id)
  return (
    <span
      className={`avatar avatar-${kind}`}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        // CSS reads --avatar-hue to tint background and text for light and dark themes.
        ['--avatar-hue' as string]: String(hue),
      }}
    >
      {kind === 'room' ? '#' : initials(name)}
    </span>
  )
}
