// Message text is untrusted. Only these schemes may become a link; everything else stays text.
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"])

/** A URL a message may open, or undefined when it must stay plain text. */
export function sanitizeMarkdownUrl(url: string): string | undefined {
  const value = url.trim()
  if (!value || hasControlOrSpace(value)) return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (!SAFE_PROTOCOLS.has(parsed.protocol)) return undefined
  if (parsed.username || parsed.password) return undefined
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.hostname) return undefined
  return value
}

export type SortDir = "asc" | "desc"

/** None, then ascending, then descending, then back to the author's order. */
export function nextSort(current: { column: number; direction: SortDir } | null, column: number): { column: number; direction: SortDir } | null {
  if (!current || current.column !== column) return { column, direction: "asc" }
  if (current.direction === "asc") return { column, direction: "desc" }
  return null
}

/** Numbers compare as numbers. Everything else compares as text, so "10" sorts after "2". */
export function compareCells(a: string, b: string): number {
  const an = numeric(a)
  const bn = numeric(b)
  if (an !== null && bn !== null && an !== bn) return an < bn ? -1 : 1
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
}

function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

function numeric(value: string): number | null {
  const text = value.trim().replace(/,/g, "")
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}
