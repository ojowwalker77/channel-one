import { Add01Icon, ArrowDown01Icon, LockIcon, Search01Icon } from "@hugeicons/core-free-icons"
import { useState } from "react"

import { displayName, useAuth } from "@/lib/auth"
import type { ChannelRow } from "@/lib/channel"
import { atChannelLimit, type MyUsage } from "@/lib/usage"
import { formatShort } from "@/lib/format"
import { setAppearance, useAppearance, type Appearance } from "@/lib/theme"
import { cx } from "@/lib/utils"
import { Icon } from "./icon"
import { Button, IconButton, Monogram, Wordmark } from "./kit"
import { Menu, MenuItem, MenuLabel, MenuNote, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "./ui/menu"
import { usageLine } from "./usage"

/** The second line of a row: what was said last, or why this browser can't open it yet. */
function rowNote(c: ChannelRow): string {
  if (c.state === "pending") return "Waiting for the owner to let you in"
  if (c.state === "elsewhere") return "On another device of yours"
  if (c.state === "agents") return c.agents === 1 ? "One of your agents is here" : `${c.agents} of your agents are here`
  if (c.recent?.text) return c.recent.from ? `${c.recent.from}: ${c.recent.text}` : c.recent.text
  return "No messages yet"
}

/** Your channels: the ones this browser is in, plus (signed in) every one you own, joined, or have agents in. */
export function Sidebar({
  rows,
  active,
  onSelect,
  onNew,
  onJoin,
  onComputers,
  onAddDevice,
  usage,
  onUsage,
  className,
}: {
  rows: ChannelRow[]
  active: string
  onSelect: (code: string) => void
  onNew: () => void
  onJoin: () => void
  onComputers: () => void
  onAddDevice: () => void
  usage: MyUsage | null
  onUsage: () => void
  className?: string
}) {
  const auth = useAuth()
  const [query, setQuery] = useState("")
  const appearance = useAppearance()
  const q = query.trim().toLowerCase()
  const shown = q ? rows.filter((c) => c.title.toLowerCase().includes(q) || c.recent?.text.toLowerCase().includes(q)) : rows

  return (
    <aside className={cx("h-full w-full shrink-0 flex-col bg-rail shadow-[inset_-0.5px_0_0_var(--line)] md:w-[272px]", className)}>
      <header className="flex h-[56px] shrink-0 items-center px-3">
        {auth.status === "signed-in" ? (
          <Menu
            className="w-60"
            trigger={
              <button type="button" className="flex min-w-0 items-center gap-2 rounded-[8px] py-1 pr-2 pl-1 transition-colors hover:bg-wash data-popup-open:bg-wash">
                <Monogram name={displayName(auth.user)} size={24} />
                <span className="truncate text-[13px] font-semibold">{displayName(auth.user)}</span>
                <Icon icon={ArrowDown01Icon} size={14} className="shrink-0 text-ink-3" />
              </button>
            }
          >
            <MenuNote>{auth.user?.email}</MenuNote>
            <MenuItem onClick={onComputers}>Your computers</MenuItem>
            <MenuItem onClick={onAddDevice}>Add a device</MenuItem>
            {usage && <MenuItem onClick={onUsage}>Usage</MenuItem>}
            <MenuSeparator />
            <MenuLabel>Appearance</MenuLabel>
            <MenuRadioGroup<Appearance> value={appearance} onChange={setAppearance}>
              <MenuRadioItem value="system">Match system</MenuRadioItem>
              <MenuRadioItem value="light">Light</MenuRadioItem>
              <MenuRadioItem value="dark">Dark</MenuRadioItem>
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem onClick={auth.signOut}>Sign out</MenuItem>
          </Menu>
        ) : (
          <Wordmark className="pl-1 text-[15px]" />
        )}
      </header>

      <div className="flex items-center justify-between pr-2 pl-4">
        <h2 className="text-[12px] font-semibold text-ink-2">Channels</h2>
        <Menu
          align="end"
          className="w-52"
          trigger={
            <IconButton label="New channel or join" className="size-7">
              <Icon icon={Add01Icon} size={16} />
            </IconButton>
          }
        >
          <MenuItem onClick={onNew}>New channel</MenuItem>
          <MenuItem onClick={onJoin}>Join with a code</MenuItem>
        </Menu>
      </div>

      {rows.length > 6 && (
        <label className="mx-3 mt-1 mb-1 flex h-8 items-center gap-2 rounded-[8px] bg-wash px-2.5 text-ink-3">
          <Icon icon={Search01Icon} size={14} className="shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a channel"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3 focus-visible:outline-none"
          />
        </label>
      )}

      <nav className="flex-1 overflow-y-auto px-2 pt-1 pb-3">
        {shown.map((c) => {
          const selected = c.code === active
          const reachable = c.state === "member"
          return (
            <button
              key={c.room}
              type="button"
              onClick={() => onSelect(c.code)}
              aria-current={selected ? "page" : undefined}
              className={cx("mb-px block w-full rounded-[8px] px-2.5 py-2 text-left transition-colors", selected ? "bg-wash-2" : "hover:bg-wash")}
            >
              <span className="flex items-baseline gap-2">
                <span className={cx("min-w-0 flex-1 truncate text-[13.5px] tracking-[-0.01em]", selected ? "font-semibold" : "font-medium", !reachable && "text-ink-2")}>{c.title}</span>
                {reachable ? (
                  <span className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">{formatShort(c.ts)}</span>
                ) : c.state !== "pending" ? (
                  <Icon icon={LockIcon} size={12} className="shrink-0 self-center text-ink-3" />
                ) : null}
              </span>
              <span className="mt-0.5 block truncate text-[12.5px] text-ink-3">{rowNote(c)}</span>
            </button>
          )
        })}
        {rows.length > 0 && shown.length === 0 && <p className="px-3 py-6 text-[12.5px] text-ink-3">No channel matches “{query}”.</p>}
        {rows.length === 0 && (
          <p className="px-3 py-4 text-[12.5px] leading-normal text-ink-3">
            {auth.status === "signed-out" ? "Sign in to see your channels from any device." : "Channels you create or join show up here."}
          </p>
        )}
      </nav>

      {usage && usageLine(usage) && (
        <button type="button" onClick={onUsage} className="mx-2 mb-2 shrink-0 rounded-[8px] px-2.5 py-2 text-left text-[12px] text-ink-3 transition-colors hover:bg-wash">
          <span className={cx("tabular-nums", atChannelLimit(usage) && "font-medium text-ink-2")}>{usageLine(usage)}</span>
          {atChannelLimit(usage) && <span> · close one to create another</span>}
        </button>
      )}
      {auth.status === "signed-out" && (
        <div className="shrink-0 p-3">
          <Button className="w-full" onClick={auth.signIn}>
            Sign in
          </Button>
        </div>
      )}
    </aside>
  )
}
