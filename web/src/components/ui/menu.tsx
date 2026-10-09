import { Menu as Base } from "@base-ui/react/menu"
import { Tick02Icon } from "@hugeicons/core-free-icons"
import type { ReactNode } from "react"

import { cx } from "@/lib/utils"
import { Icon } from "../icon"

// Menus on Base UI: keyboard, focus and outside-click come for free. Pass the
// element that opens it as `trigger`; it keeps its own look.

export const POP = "rounded-[10px] bg-raised p-1 text-ink shadow-pop outline-none"
/** Popups grow out of their anchor on open and leave at once on close. */
export const POP_IN = "origin-(--transform-origin) transition-[opacity,scale] duration-150 ease-out data-starting-style:scale-[0.97] data-starting-style:opacity-0"
const ITEM = "flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[13px] outline-none select-none data-disabled:opacity-40 data-highlighted:bg-wash-2"

export function Menu({
  trigger,
  children,
  side = "bottom",
  align = "start",
  className,
}: {
  trigger: Base.Trigger.Props["render"]
  children: ReactNode
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
  className?: string
}) {
  return (
    <Base.Root>
      <Base.Trigger render={trigger} />
      <Base.Portal>
        <Base.Positioner side={side} align={align} sideOffset={6} className="z-50 outline-none">
          <Base.Popup className={cx(POP, POP_IN, "min-w-44", className)}>{children}</Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}

export function MenuItem({ className, tone, ...props }: Base.Item.Props & { tone?: "danger"; className?: string }) {
  return <Base.Item className={cx(ITEM, tone === "danger" && "text-alert", className)} {...props} />
}

/** Quiet text at the top of a menu, e.g. who you're signed in as. */
export function MenuNote({ children }: { children: ReactNode }) {
  return <p className="truncate px-2 pt-1.5 pb-2 text-[12px] text-ink-2">{children}</p>
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <Base.GroupLabel className="px-2 pt-1.5 pb-1 text-[11.5px] font-medium text-ink-3">{children}</Base.GroupLabel>
}

export function MenuSeparator() {
  return <Base.Separator className="mx-1 my-1 h-px bg-line" />
}

export const MenuGroup = Base.Group

export function MenuRadioGroup<T extends string>({ value, onChange, children }: { value: T; onChange: (v: T) => void; children: ReactNode }) {
  return (
    <Base.RadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
      {children}
    </Base.RadioGroup>
  )
}

/** One choice of several: a tick marks the current one; a hint can say what it means. */
export function MenuRadioItem({ value, children, hint, onClick }: { value: string; children: ReactNode; hint?: ReactNode; onClick?: () => void }) {
  return (
    <Base.RadioItem value={value} closeOnClick onClick={onClick} className={cx(ITEM, hint != null && "items-start")}>
      <span className={cx("w-4 shrink-0 text-ink", hint != null && "pt-0.5")}>
        <Base.RadioItemIndicator>
          <Icon icon={Tick02Icon} size={14} strokeWidth={2} />
        </Base.RadioItemIndicator>
      </span>
      {hint ? (
        <span>
          <span className="block font-medium">{children}</span>
          <span className="block text-[12px] text-ink-3">{hint}</span>
        </span>
      ) : (
        children
      )}
    </Base.RadioItem>
  )
}
