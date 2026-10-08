import { SearchIcon, SquarePenIcon } from "lucide-react"
import { useState } from "react"

import { displayName, useAuth } from "@/lib/auth"
import { channelTitle, loadRecent, useKnownChannels } from "@/lib/channel"
import { formatShort } from "@/lib/format"
import { cx } from "@/lib/utils"
import { AppMark, Avatar, AvatarStack, Button, IconButton } from "./kit"

/** The channel list, like the conversation list in Messages. */
export function Sidebar({ active, onSelect, onNew, className }: { active: string; onSelect: (code: string) => void; onNew: () => void; className?: string }) {
  const auth = useAuth()
  const channels = useKnownChannels()
  const [query, setQuery] = useState("")

  const rows = channels
    .map((c) => {
      const recent = loadRecent(c.code)
      return { ...c, recent, title: channelTitle(c, recent), ts: recent?.ts ?? c.at }
    })
    .filter((c) => !query.trim() || c.title.toLowerCase().includes(query.trim().toLowerCase()) || c.recent?.text.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => b.ts - a.ts)

  return (
    <aside className={cx("h-full w-full shrink-0 flex-col border-r border-separator bg-sidebar backdrop-blur-2xl md:w-[300px]", className)}>
      <header className="flex h-[52px] shrink-0 items-center justify-between px-4">
        <span className="flex items-center gap-2">
          <AppMark size={22} />
          <span className="text-[15px] font-semibold">channel-one</span>
        </span>
        <IconButton label="New channel" tone="blue" onClick={onNew}>
          <SquarePenIcon />
        </IconButton>
      </header>

      <div className="px-3 pb-2">
        <label className="flex h-8 items-center gap-1.5 rounded-[9px] bg-fill-2 px-2 text-label-2">
          <SearchIcon className="size-4 shrink-0" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="min-w-0 flex-1 bg-transparent text-[14px] text-label outline-none placeholder:text-label-2" />
        </label>
      </div>

      <nav className="flex-1 overflow-y-auto px-2">
        {rows.map((c) => {
          const selected = c.code === active
          return (
            <button
              key={c.code}
              type="button"
              onClick={() => onSelect(c.code)}
              className={cx("flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition", selected ? "bg-blue text-white" : "hover:bg-fill-2")}
            >
              <AvatarStack names={c.recent?.people.length ? c.recent.people : [c.title]} size={42} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[15px] font-semibold">{c.title}</span>
                  <span className={cx("shrink-0 text-[12px]", selected ? "text-white/80" : "text-label-2")}>{formatShort(c.ts)}</span>
                </span>
                <span className={cx("line-clamp-2 text-[13px] leading-snug", selected ? "text-white/85" : "text-label-2")}>
                  {c.recent?.text ? (c.recent.from ? `${c.recent.from}: ${c.recent.text}` : c.recent.text) : "No messages yet"}
                </span>
              </span>
            </button>
          )
        })}
        {channels.length > 0 && rows.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-label-2">No channels match.</p>}
        {channels.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-label-2">Your channels appear here.</p>}
      </nav>

      <footer className="flex h-14 shrink-0 items-center gap-2.5 border-t border-separator px-4">
        {auth.status === "signed-in" ? (
          <>
            <Avatar name={displayName(auth.user)} size={28} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{displayName(auth.user)}</span>
            <Button size="sm" variant="plain" onClick={auth.signOut}>
              Sign Out
            </Button>
          </>
        ) : auth.status === "signed-out" ? (
          <>
            <span className="flex-1 text-[13px] text-label-2">Not signed in</span>
            <Button size="sm" onClick={auth.signIn}>
              Sign In
            </Button>
          </>
        ) : (
          <span className="text-[12px] text-label-2">End-to-end encrypted</span>
        )}
      </footer>
    </aside>
  )
}
