import { Tooltip as Base } from "@base-ui/react/tooltip"
import type { ReactElement, ReactNode } from "react"

// A short label on hover or focus, for controls that are only an icon.

export const TooltipProvider = Base.Provider

export function Tooltip({ label, children, side = "bottom" }: { label: ReactNode; children: ReactElement; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Base.Root>
      <Base.Trigger render={children} />
      <Base.Portal>
        <Base.Positioner side={side} sideOffset={6} className="z-[70]">
          <Base.Popup className="rounded-[6px] bg-ink px-2 py-1 text-[12px] font-medium text-canvas shadow-pop transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0">
            {label}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}
