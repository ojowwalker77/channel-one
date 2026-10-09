import { Dialog } from "@base-ui/react/dialog"
import { Search01Icon } from "@hugeicons/core-free-icons"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { cx } from "@/lib/utils"
import { Icon } from "../icon"

// ⌘K: jump to a channel or do something, by typing a few letters of it.

export interface Command {
  id: string
  label: string
  group: "Channels" | "Actions" | "Appearance"
  /** Quiet text on the right: when a channel last spoke, a shortcut. */
  hint?: ReactNode
  /** More words to match on, e.g. the last message of a channel. */
  keywords?: string
  run: () => void
}

/** Best first: the label starts with the query, then a word in it does, then it contains it anywhere. */
function rank(c: Command, q: string): number {
  if (!q) return 1
  const label = c.label.toLowerCase()
  if (label.startsWith(q)) return 4
  if (label.split(/[\s,&-]+/).some((w) => w.startsWith(q))) return 3
  if (label.includes(q)) return 2
  return c.keywords?.toLowerCase().includes(q) ? 1 : 0
}

const GROUPS: Command["group"][] = ["Channels", "Actions", "Appearance"]

export function Palette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Command[] }) {
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const q = query.trim().toLowerCase()
  const shown = useMemo(() => {
    const scored = commands.map((c) => ({ c, r: rank(c, q) })).filter((x) => x.r > 0)
    // Grouped in a fixed order; within a group, the best matches first.
    return GROUPS.flatMap((g) =>
      scored
        .filter((x) => x.c.group === g)
        .sort((a, b) => b.r - a.r)
        .map((x) => x.c)
    )
  }, [commands, q])
  const at = Math.min(index, Math.max(0, shown.length - 1))

  useEffect(() => {
    list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" })
  }, [at])

  const choose = (c: Command | undefined) => {
    if (!c) return
    onClose()
    c.run()
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => !o && onClose()}
      onOpenChangeComplete={(o) => {
        if (o) return
        setQuery("")
        setIndex(0)
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay transition-opacity duration-150 data-starting-style:opacity-0" />
        <Dialog.Popup
          aria-label="Go to a channel or run a command"
          className="fixed top-[14vh] left-1/2 z-50 flex max-h-[min(480px,70svh)] w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 flex-col overflow-hidden rounded-[14px] bg-raised shadow-pop transition-[opacity,scale] duration-150 ease-out outline-none data-starting-style:scale-[0.98] data-starting-style:opacity-0"
        >
          <label className="flex h-12 shrink-0 items-center gap-2.5 px-4 shadow-[inset_0_-1px_0_var(--line)]">
            <Icon icon={Search01Icon} size={17} className="shrink-0 text-ink-3" />
            <input
              autoFocus
              value={query}
              onChange={(e) => (setQuery(e.target.value), setIndex(0))}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault()
                  const d = e.key === "ArrowDown" ? 1 : -1
                  setIndex((at + d + shown.length) % Math.max(1, shown.length))
                } else if (e.key === "Enter") {
                  e.preventDefault()
                  choose(shown[at])
                }
              }}
              placeholder="Go to a channel or run a command"
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={shown[at] ? `palette-${shown[at].id}` : undefined}
              className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-3 focus-visible:outline-none"
            />
          </label>
          <div ref={list} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {shown.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-ink-3">Nothing matches “{query}”.</p>}
            {shown.map((c, i) => (
              <div key={c.id}>
                {(i === 0 || shown[i - 1]!.group !== c.group) && <p className="px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-ink-3">{c.group}</p>}
                <div
                  id={`palette-${c.id}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === at}
                  onMouseMove={() => i !== at && setIndex(i)}
                  onClick={() => choose(c)}
                  className={cx("flex h-9 cursor-default items-center gap-3 rounded-[8px] px-2.5 text-[13.5px]", i === at && "bg-wash-2")}
                >
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.hint && <span className="shrink-0 text-[12px] text-ink-3 tabular-nums">{c.hint}</span>}
                </div>
              </div>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** ⌘K on a Mac, Ctrl+K elsewhere, from anywhere in the app. */
export function usePaletteShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        open()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])
}
