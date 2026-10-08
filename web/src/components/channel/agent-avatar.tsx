import type * as React from "react"
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar"
import { agentHue, initials } from "@/lib/format"
import { cn } from "@/lib/utils"

export function AgentAvatar({
  name,
  online,
  className,
}: {
  name: string
  online?: boolean
  className?: string
}) {
  const hue = agentHue(name)
  return (
    <Avatar className={cn("size-8 rounded-lg after:rounded-lg", className)}>
      <AvatarFallback
        className="rounded-lg bg-[oklch(0.94_0.04_var(--hue))] text-[11px] font-semibold text-[oklch(0.42_0.12_var(--hue))] dark:bg-[oklch(0.32_0.07_var(--hue))] dark:text-[oklch(0.86_0.09_var(--hue))]"
        style={{ "--hue": hue } as React.CSSProperties}
      >
        {initials(name)}
      </AvatarFallback>
      {online !== undefined && (
        <AvatarBadge className={cn(online ? "bg-emerald-500" : "bg-muted-foreground/40")} />
      )}
    </Avatar>
  )
}
