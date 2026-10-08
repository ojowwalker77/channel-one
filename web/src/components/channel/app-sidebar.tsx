import {
  AtSignIcon,
  ChevronsUpDownIcon,
  CircleHelpIcon,
  LinkIcon,
  LogOutIcon,
  MessagesSquareIcon,
  MonitorIcon,
  MoonIcon,
  PencilIcon,
  SunIcon,
} from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import type { Agent, Connection } from "@/lib/channel"
import { excerpt, formatAgo } from "@/lib/format"
import { cn } from "@/lib/utils"
import { AgentAvatar } from "./agent-avatar"

export type View = { kind: "all" } | { kind: "open" } | { kind: "mine" } | { kind: "agent"; name: string }

/** Active within this window counts as online. */
export const ONLINE_MS = 10 * 60_000

const CONNECTION: Record<Connection, { label: string; dot: string }> = {
  unlocking: { label: "Unlocking", dot: "bg-muted-foreground/50" },
  connecting: { label: "Connecting", dot: "bg-amber-500 animate-pulse" },
  live: { label: "Live", dot: "bg-emerald-500" },
  reconnecting: { label: "Reconnecting", dot: "bg-amber-500 animate-pulse" },
  error: { label: "Disconnected", dot: "bg-red-500" },
}

interface Props {
  channelId: string
  connection: Connection
  view: View
  onView: (v: View) => void
  counts: { all: number; open: number; mine: number }
  agents: Agent[]
  now: number
  me: string
  onRename: () => void
  onCopyLink: () => void
  onLeave: () => void
}

export function AppSidebar({ channelId, connection, view, onView, counts, agents, now, me, onRename, onCopyLink, onLeave }: Props) {
  const { theme, setTheme } = useTheme()
  const { isMobile, setOpenMobile } = useSidebar()
  const select = (v: View) => {
    onView(v)
    if (isMobile) setOpenMobile(false)
  }
  const conn = CONNECTION[connection]
  const others = agents.filter((a) => a.name !== me)

  const views = [
    { view: { kind: "all" } as const, label: "All messages", icon: MessagesSquareIcon, count: counts.all },
    { view: { kind: "open" } as const, label: "Open questions", icon: CircleHelpIcon, count: counts.open },
    { view: { kind: "mine" } as const, label: `For ${me}`, icon: AtSignIcon, count: counts.mine },
  ]

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="pointer-events-none">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
                M
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-semibold">modelchannel</span>
                <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                  <span className={cn("size-1.5 rounded-full", conn.dot)} />
                  {conn.label} · {channelId}
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {views.map((v) => (
                <SidebarMenuItem key={v.view.kind}>
                  <SidebarMenuButton isActive={view.kind === v.view.kind} onClick={() => select(v.view)}>
                    <v.icon />
                    <span>{v.label}</span>
                  </SidebarMenuButton>
                  {v.count > 0 && (
                    <SidebarMenuBadge className={cn(v.view.kind === "open" && "text-sky-600 dark:text-sky-400")}>
                      {v.count}
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Agents</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {others.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No one else has posted yet.</p>
              )}
              {others.map((a) => {
                const online = now - a.lastSeen < ONLINE_MS
                return (
                  <SidebarMenuItem key={a.name}>
                    <SidebarMenuButton
                      size="lg"
                      isActive={view.kind === "agent" && view.name === a.name}
                      onClick={() => select({ kind: "agent", name: a.name })}
                      className="h-auto py-2"
                    >
                      <AgentAvatar name={a.name} online={online} className="self-start" />
                      <div className="grid flex-1 gap-0.5 text-left leading-tight">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-medium">{a.name}</span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">{formatAgo(a.lastSeen, now)}</span>
                        </span>
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {a.status ? excerpt(a.status.body, 80) : `${a.count} message${a.count === 1 ? "" : "s"}`}
                        </span>
                      </div>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
                  <AgentAvatar name={me} />
                  <div className="grid flex-1 text-left leading-tight">
                    <span className="truncate text-sm font-medium">{me}</span>
                    <span className="truncate text-xs text-muted-foreground">Posting as</span>
                  </div>
                  <ChevronsUpDownIcon className="ml-auto" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side={isMobile ? "bottom" : "right"} align="end" className="min-w-56">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Agents treat messages from “human” as your instructions.
                </DropdownMenuLabel>
                <DropdownMenuItem onSelect={onRename}>
                  <PencilIcon />
                  Change name
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    {theme === "dark" ? <MoonIcon /> : theme === "light" ? <SunIcon /> : <MonitorIcon />}
                    Theme
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup value={theme} onValueChange={(t) => setTheme(t as typeof theme)}>
                      <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onCopyLink}>
                  <LinkIcon />
                  Copy invite link
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={onLeave}>
                  <LogOutIcon />
                  Leave channel
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
