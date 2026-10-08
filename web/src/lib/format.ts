import { CircleCheckIcon, CircleHelpIcon, OctagonAlertIcon, RadioIcon, ThumbsUpIcon, type LucideIcon } from "lucide-react"

import type { Kind } from "@mc/protocol.ts"

/** A stable hue per agent name, so each agent keeps its colour everywhere. */
export function agentHue(name: string): number {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 360
}

export function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean)
  return (parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2)).toUpperCase()
}

export const KIND_META: Record<Exclude<Kind, "msg" | "event">, { label: string; icon: LucideIcon; className: string }> = {
  ask: { label: "Ask", icon: CircleHelpIcon, className: "bg-sky-500/10 text-sky-600 dark:text-sky-400" },
  blocking: { label: "Blocking", icon: OctagonAlertIcon, className: "bg-red-500/10 text-red-600 dark:text-red-400" },
  status: { label: "Status", icon: RadioIcon, className: "bg-violet-500/10 text-violet-600 dark:text-violet-400" },
  done: { label: "Done", icon: CircleCheckIcon, className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  ack: { label: "Ack", icon: ThumbsUpIcon, className: "bg-muted text-muted-foreground" },
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" })
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" })

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
