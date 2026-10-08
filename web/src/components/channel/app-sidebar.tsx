import {
  ActivityIcon,
  AtSignIcon,
  KanbanSquareIcon,
  ChevronsUpDownIcon,
  CircleHelpIcon,
  ArrowLeftIcon,
  CopyIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  UsersIcon,
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
import type { Connection, Online } from "@/lib/channel"
import { excerpt, formatAgo } from "@/lib/format"
import { cn } from "@/lib/utils"
import { AgentAvatar } from "./agent-avatar"

export type View = { kind: "all" } | { kind: "board" } | { kind: "open" } | { kind: "mine" } | { kind: "members" } | { kind: "agent"; name: string }

export interface AgentRow {
  name: string
  role?: string
  lastSeen: number
  status?: string
  verified: boolean
}

const CONNECTION: Record<Connection, { label: string; dot: string }> = {
  connecting: { label: "Connecting", dot: "bg-amber-500 animate-pulse" },
  live: { label: "Live", dot: "bg-emerald-500" },
  reconnecting: { label: "Reconnecting", dot: "bg-amber-500 animate-pulse" },
}

interface Props {
  channelId: string
  connection: Connection
  view: View
  onView: (v: View) => void
  counts: { all: number; board: number; open: number; mine: number; members: number }
  agents: AgentRow[]
  online: Map<string, Online>
  now: number
  me: string
  isOwner: boolean
  onCopyCode: () => void
  onBack: () => void
}

export function AppSidebar({ channelId, connection, view, onView, counts, agents, online, now, me, isOwner, onCopyCode, onBack }: Props) {
  const { theme, setTheme } = useTheme()
  const { isMobile, setOpenMobile } = useSidebar()
  const select = (v: View) => {
    onView(v)
    if (isMobile) setOpenMobile(false)
  }
  const conn = CONNECTION[connection]
  const others = agents.filter((a) => a.name !== me)
  const onlineCount = others.filter((a) => online.has(a.name)).length

  const views = [
    { view: { kind: "all" } as const, label: "Activity", icon: ActivityIcon, count: counts.all },
    { view: { kind: "board" } as const, label: "Task board", icon: KanbanSquareIcon, count: counts.board },
    { view: { kind: "open" } as const, label: "Open questions", icon: CircleHelpIcon, count: counts.open },
    { view: { kind: "mine" } as const, label: `For ${me}`, icon: AtSignIcon, count: counts.mine },
    { view: { kind: "members" } as const, label: isOwner ? "Members & requests" : "Members", icon: UsersIcon, count: counts.members },
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
                    <SidebarMenuBadge className={cn(v.view.kind === "open" && "text-sky-600 dark:text-sky-400", v.view.kind === "members" && "text-amber-600 dark:text-amber-400")}>
                      {v.count}
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>
            Agents
            <span className="ml-auto font-normal tabular-nums">
              {onlineCount}/{others.length} online
            </span>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {others.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No one else has posted yet.</p>
              )}
              {others.map((a) => {
                const on = online.get(a.name)
                return (
                  <SidebarMenuItem key={a.name}>
                    <SidebarMenuButton
                      size="lg"
                      isActive={view.kind === "agent" && view.name === a.name}
                      onClick={() => select({ kind: "agent", name: a.name })}
                      className="h-auto py-2"
                    >
                      <AgentAvatar name={a.name} online={!!on} className="self-start" />
                      <div className="grid flex-1 gap-0.5 text-left leading-tight">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-medium">{a.name}</span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">{on ? "online" : formatAgo(a.lastSeen, now)}</span>
                        </span>
                        {(a.role || on?.role) && <span className="truncate text-[11px] text-muted-foreground/80">{a.role ?? on?.role}</span>}
                        {a.status && <span className="line-clamp-2 text-xs text-muted-foreground">{excerpt(a.status, 80)}</span>}
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
                    <span className="truncate text-xs text-muted-foreground">{isOwner ? "Owner" : "Member"}</span>
                  </div>
                  <ChevronsUpDownIcon className="ml-auto" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side={isMobile ? "bottom" : "right"} align="end" className="min-w-56">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  {isOwner ? "You approve everyone who joins, and only you can close the channel." : "Your name is bound to this browser’s key by the owner."}
                </DropdownMenuLabel>
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
                <DropdownMenuItem onSelect={onCopyCode}>
                  <CopyIcon />
                  Copy join code
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onBack}>
                  <ArrowLeftIcon />
                  All channels
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
