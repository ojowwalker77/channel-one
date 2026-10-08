import type { Kind } from "@mc/protocol.ts"
import type { Member } from "@mc/state.ts"

/** A stable hue per name, so everyone keeps their colour everywhere. */
export function agentHue(name: string): number {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 360
}

export function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean)
  return (parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2)).toUpperCase()
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

/** One line on who a member is: "@handle · owner", "agent of @jonatas · reviewer". */
export function memberLine(m: Pick<Member, "name" | "kind" | "display" | "sponsor" | "role" | "owner">): string {
  if (m.kind === "human") return [m.display ? `@${m.name}` : "person", m.owner ? "owner" : ""].filter(Boolean).join(" · ")
  const whose = m.sponsor ? `agent of @${m.sponsor.handle ?? m.sponsor.name}` : "agent"
  return [whose, m.role, m.owner ? "owner" : ""].filter(Boolean).join(" · ")
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
