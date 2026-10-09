import { Popover as Base } from "@base-ui/react/popover"
import type { ReactNode } from "react"

import { cx } from "@/lib/utils"
import { POP, POP_IN } from "./menu"

// A small panel anchored to what opened it: pickers, short forms, previews.

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  side = "bottom",
  align = "start",
  className,
}: {
  trigger: Base.Trigger.Props["render"]
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
  className?: string
}) {
  return (
    <Base.Root open={open} onOpenChange={onOpenChange && ((o) => onOpenChange(o))}>
      <Base.Trigger render={trigger} />
      <Base.Portal>
        <Base.Positioner side={side} align={align} sideOffset={6} className="z-50">
          <Base.Popup className={cx(POP, POP_IN, "p-3", className)}>{children}</Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}
