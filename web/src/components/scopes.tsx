import { useState } from "react"

import { PRESETS, presetOf, SCOPE_LABELS, SCOPES, type Preset, type Scope } from "@mc/scopes.ts"
import { cx } from "@/lib/utils"

// What a member may do besides read: three presets, and each scope on its own
// when none of them fits. The owner signs the choice; every client enforces it.

const PRESET_LABEL: Record<Preset, string> = { full: "Everything", contributor: "No tasks", "read-only": "Read only" }
const PRESET_NOTE: Record<Preset, string> = {
  full: "Write, ask, run tasks, claim paths and set facts.",
  contributor: "Everything but adding, claiming or updating tasks.",
  "read-only": "Reads the channel; can't send anything.",
}

/** How a member's scopes read in a line: nothing for everything (the usual), else the preset or the list. */
export function scopesLine(scopes: readonly Scope[]): string | null {
  const p = presetOf(scopes)
  if (p === "full") return null
  if (p === "read-only") return "read only"
  if (p === "contributor") return "no tasks"
  return `may ${scopes.map((s) => SCOPE_LABELS[s].split(" ")[0]).join(", ")}`
}

export function ScopePicker({ value, onChange, disabled }: { value: Scope[]; onChange: (s: Scope[]) => void; disabled?: boolean }) {
  const preset = presetOf(value)
  const [custom, setCustom] = useState(preset === null)
  const toggle = (s: Scope) => onChange(SCOPES.filter((x) => (x === s ? !value.includes(s) : value.includes(x))))
  return (
    <div className="grid gap-2">
      <div role="radiogroup" aria-label="What they can do" className="grid grid-cols-3 gap-1 rounded-[9px] bg-wash p-0.5">
        {(Object.keys(PRESETS) as Preset[]).reverse().map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={preset === p}
            disabled={disabled}
            onClick={() => (onChange([...PRESETS[p]]), setCustom(false))}
            className={cx("rounded-[7px] px-2 py-1.5 text-[12.5px] font-medium transition-colors", preset === p ? "bg-canvas text-ink shadow-[0_0_0_1px_var(--line)]" : "text-ink-2 hover:text-ink")}
          >
            {PRESET_LABEL[p]}
          </button>
        ))}
      </div>
      <p className="text-[12px] leading-snug text-ink-3">
        {preset ? PRESET_NOTE[preset] : "Your own mix."}{" "}
        {!custom && (
          <button type="button" className="font-medium text-ink-2 hover:text-ink" onClick={() => setCustom(true)} disabled={disabled}>
            Choose each…
          </button>
        )}
      </p>
      {custom && (
        <div className="grid gap-1">
          {SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-[13px] text-ink">
              <input type="checkbox" checked={value.includes(s)} onChange={() => toggle(s)} disabled={disabled} className="size-4 accent-[var(--accent)]" />
              {SCOPE_LABELS[s][0]!.toUpperCase() + SCOPE_LABELS[s].slice(1)}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// What new members get by default, picked when inviting and confirmed at each approval. It's this
// browser's preference, not a promise: nothing is signed until the owner approves someone.
const DEFAULT_KEY = (roomId: string) => `mc.scopes.${roomId}`

export function defaultScopes(roomId: string): Scope[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DEFAULT_KEY(roomId)) ?? "null") as unknown
    return Array.isArray(raw) ? SCOPES.filter((s) => raw.includes(s)) : [...SCOPES]
  } catch {
    return [...SCOPES]
  }
}

export function saveDefaultScopes(roomId: string, scopes: Scope[]): void {
  localStorage.setItem(DEFAULT_KEY(roomId), JSON.stringify(scopes))
}
