import { Logout01Icon, PencilEdit02Icon, Search01Icon } from "@hugeicons/core-free-icons"
import { useState } from "react"

import { displayName, useAuth } from "@/lib/auth"
import { channelTitle, loadRecent, useKnownChannels } from "@/lib/channel"
import { formatShort } from "@/lib/format"
import { cx } from "@/lib/utils"
import { Icon } from "./icon"
import { Avatar, Button, IconButton } from "./kit"

/** The channel list, like the conversation list in Messages. */
export function Sidebar({ active, onSelect, onNew, className }: { active: string; onSelect: (code: string) => void; onNew: () => void; className?: string }) {
  const auth = useAuth()
  const channels = useKnownChannels()
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()

  const rows = channels
    .map((c) => {
      const recent = loadRecent(c.code)
      return { ...c, recent, title: channelTitle(c, recent), ts: recent?.ts ?? c.at }
    })
    .filter((c) => !q || c.title.toLowerCase().includes(q) || c.recent?.text.toLowerCase().includes(q))
    .sort((a, b) => b.ts - a.ts)

  return (
    <aside className={cx("h-full w-full shrink-0 flex-col bg-sidebar shadow-[inset_-0.5px_0_0_var(--separator)] md:w-[296px]", className)}>
      <header className="flex h-[56px] shrink-0 items-center gap-2 pr-2 pl-3">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[9px] bg-fill-2 px-2.5 text-label-2 transition-shadow focus-within:shadow-[0_0_0_3px_var(--selection)]">
          <Icon icon={Search01Icon} size={15} strokeWidth={1.8} className="shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-label outline-none placeholder:text-label-2 focus-visible:outline-none"
          />
        </label>
        <IconButton label="New channel" tone="blue" onClick={onNew}>
          <Icon icon={PencilEdit02Icon} size={19} />
        </IconButton>
      </header>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {rows.map((c) => {
          const selected = c.code === active
          return (
            <button
              key={c.code}
              type="button"
              onClick={() => onSelect(c.code)}
              className={cx("flex w-full items-center gap-3 rounded-[12px] px-2.5 py-2.5 text-left transition-colors duration-100", selected ? "bg-blue text-white" : "hover:bg-fill-2")}
            >
              <Avatar name={c.title} size={40} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[14px] font-semibold tracking-[-0.01em]">{c.title}</span>
                  <span className={cx("shrink-0 text-[12px] tabular-nums", selected ? "text-white/75" : "text-label-2")}>{formatShort(c.ts)}</span>
                </span>
                <span className={cx("mt-0.5 line-clamp-2 text-[13px] leading-[1.3]", selected ? "text-white/80" : "text-label-2")}>
                  {c.recent?.text ? (c.recent.from ? `${c.recent.from}: ${c.recent.text}` : c.recent.text) : "No messages yet"}
                </span>
              </span>
            </button>
          )
        })}
        {channels.length > 0 && rows.length === 0 && <p className="px-3 py-8 text-center text-[13px] text-label-2">No channel matches “{query}”.</p>}
        {channels.length === 0 && <p className="px-6 py-8 text-center text-[13px] leading-snug text-label-2">Channels you create or join show up here.</p>}
      </nav>

      {auth.status === "signed-in" ? (
        <footer className="flex h-[60px] shrink-0 items-center gap-2.5 pr-2 pl-4 shadow-[inset_0_0.5px_0_var(--separator)]">
          <Avatar name={displayName(auth.user)} size={30} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{displayName(auth.user)}</span>
            <span className="block truncate text-[11px] text-label-2">{auth.user?.email}</span>
          </span>
          <IconButton label="Sign out" onClick={auth.signOut}>
            <Icon icon={Logout01Icon} size={18} />
          </IconButton>
        </footer>
      ) : auth.status === "signed-out" ? (
        <footer className="flex h-[60px] shrink-0 items-center justify-between gap-2 px-4 shadow-[inset_0_0.5px_0_var(--separator)]">
          <span className="text-[13px] text-label-2">Not signed in</span>
          <Button size="sm" onClick={auth.signIn}>
            Sign in
          </Button>
        </footer>
      ) : null}
    </aside>
  )
}
