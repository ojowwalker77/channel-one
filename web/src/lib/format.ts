import type { Kind } from "@mc/protocol.ts"
import type { Member } from "@mc/state.ts"

/**
 * Every agent speaks in its own voice colour, drawn from Apple's system
 * palette and stable for its name. People stay neutral (null).
 */
const VOICES = ["#5856d6", "#30b0c7", "#ff9500", "#ff2d55", "#af52de", "#00c7be", "#a2845e", "#34c759", "#ff6482", "#5e5ce6"]

export function voiceOf(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return VOICES[h % VOICES.length]!
}

/** One or two letters for a monogram: "Jonatas Filho" → "JF", "claude" → "C". */
export function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean)
  return (parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 1)).toUpperCase()
}

/** How non-chat message kinds are labelled above a bubble. */
export const KIND_LABEL: Partial<Record<Kind, { label: string; tone: string }>> = {
  ask: { label: "Question", tone: "text-blue" },
  blocking: { label: "Blocking", tone: "text-red" },
  status: { label: "Status", tone: "text-label-2" },
  done: { label: "Done", tone: "text-green" },
  ack: { label: "Ack", tone: "text-label-2" },
}

/** The name to show for a member: a person's real name, an agent's own name. */
export function memberName(m: Pick<Member, "name" | "kind" | "display"> | undefined, fallback = ""): string {
  if (!m) return fallback
  return m.kind === "human" && m.display ? m.display : m.name
}

/** Who a member is, in a phrase: "Owner", "Reviewer for Jonatas", "Agent for Jonatas". */
export function memberLine(m: Pick<Member, "name" | "kind" | "display" | "sponsor" | "role" | "owner">): string {
  if (m.owner) return "Owner"
  if (m.kind === "human") return "Person"
  const role = m.role ? m.role[0]!.toUpperCase() + m.role.slice(1) : "Agent"
  return m.sponsor ? `${role} for ${m.sponsor.name.split(" ")[0]}` : role
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" })
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" })
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long" })
const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "numeric", year: "2-digit" })

export const formatTime = (ts: number) => timeFmt.format(ts)
export const formatFull = (ts: number) => fullFmt.format(ts)

export function formatDay(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return "Today"
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday"
  return dayFmt.format(d)
}

/** Like the Messages list: a time today, "Yesterday", a weekday this week, else a date. */
export function formatShort(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const today = new Date(now)
  if (d.toDateString() === today.toDateString()) return formatTime(ts)
  if (d.toDateString() === new Date(now - 86_400_000).toDateString()) return "Yesterday"
  if (now - ts < 6 * 86_400_000) return weekdayFmt.format(d)
  return dateFmt.format(d)
}

export function formatAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** One-line plain-text preview of a markdown body. */
export function excerpt(body: string, max = 90): string {
  const flat = body
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:#+|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat
}
